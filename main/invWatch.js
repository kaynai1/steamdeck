'use strict';

/**
 * 库存变动监控
 *
 * 每 6 小时给每个有网页会话的账号拍一次库存快照，
 * 只记「物品 + 数量」，不记具体 assetid；下一次对比出增加/减少，
 * 用系统通知告诉用户，并在界面里留一份最近的变动记录。
 *
 * 监控范围：Steam 社区物品（753）+ 用户自己添加的 AppID（settings.customApps）。
 * 第一次运行只建基线、不通知，避免刚装好就弹一堆"少了 400 件"。
 */

const fs = require('fs');
const path = require('path');
const { Notification } = require('electron');
const store = require('./store');
const logger = require('./logger');
const session = require('./session');
const accounts = require('./steamAccounts');
const inventory = require('./inventory');

const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_DELAY = 2 * 60 * 1000;
const MAX_CHANGES = 300;
const MAX_ITEMS = 4000;
const GAP_MS = 1200;

let file = null;
let state = null; // { at, baselineAt, accounts: { sid: { appId: { key: { q, n } } } }, changes: [] }
let timer = null;
let running = false;
let onOpen = null;
let iconPath = '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function load() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    loaded = null;
  }
  state =
    loaded && typeof loaded === 'object'
      ? loaded
      : { at: 0, baselineAt: 0, accounts: {}, changes: [] };
  if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {};
  if (!Array.isArray(state.changes)) state.changes = [];
  state.baselineAt = Number(state.baselineAt) || 0;
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'inv-watch.json');
  load();
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('库存监控快照写入失败', { message: err && err.message });
  }
}

function monitoredApps() {
  const settings = store.getSettings();
  const ids = [753, ...(settings.customApps || []).map((a) => Number(a.appId)).filter(Boolean)];
  return [...new Set(ids)].slice(0, 6);
}

function hasCookies(steamId) {
  try {
    return !!store.readSecret(`cookies:${steamId}`);
  } catch {
    return false;
  }
}

function shorten(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function accountName(a) {
  return a.personaName || a.accountName || String(a.steamId).slice(-6);
}

/** 对比一个账号某个 app 的新旧快照，把差异写进 changes */
function diffApp(sid, name, appId, prev, cur, at) {
  const out = [];
  const push = (key, delta, itemName) => {
    if (!delta) return;
    out.push({
      at,
      steamId: sid,
      account: name,
      appId,
      key,
      name: shorten(itemName || key, 48),
      delta,
    });
  };
  for (const [k, v] of Object.entries(cur)) {
    const old = prev[k];
    const delta = old ? v.q - old.q : v.q;
    if (delta > 0) push(k, delta, v.n);
  }
  for (const [k, v] of Object.entries(prev)) {
    const now = cur[k];
    const delta = now ? now.q - v.q : -v.q;
    if (delta < 0) push(k, delta, v.n);
  }
  return out;
}

function notifyChanges(changes) {
  if (!changes.length) return;
  const byAcc = new Map();
  for (const c of changes) {
    const arr = byAcc.get(c.account) || [];
    arr.push(c);
    byAcc.set(c.account, arr);
  }
  const lines = [];
  for (const [acc, arr] of [...byAcc.entries()].slice(0, 3)) {
    const total = arr.reduce((s, x) => s + x.delta, 0);
    const sample = arr
      .slice(0, 2)
      .map((x) => `${x.name} ${x.delta > 0 ? '+' : ''}${x.delta}`)
      .join('、');
    lines.push(`${acc}：${total > 0 ? '+' : ''}${total} 件（${sample}${arr.length > 2 ? ' 等' : ''}）`);
  }
  if (byAcc.size > 3) lines.push(`另有 ${byAcc.size - 3} 个账号有变动`);
  const title = `库存变动 · ${changes.length} 项`;
  const body = lines.join('\n');

  // 桌面通知
  if (Notification.isSupported()) {
    const n = new Notification({
      title,
      body,
      icon: iconPath || undefined,
    });
    n.on('click', () => {
      try {
        if (onOpen) onOpen();
      } catch {
        /* ignore */
      }
    });
    n.show();
  }

  // 手机/QQ 推送（走用户在「通知外发」里选的渠道）
  try {
    require('./notify').send(title, body, {
      onClick: () => {
        try {
          if (onOpen) onOpen();
        } catch {
          /* ignore */
        }
      },
    }).catch(() => {});
  } catch { /* 通知模块异常不影响监控 */ }
  logger.info('库存变动通知', { items: changes.length, accounts: byAcc.size });
}

/**
 * 跑一轮检查。
 * @param {{force?: boolean}} [opts] force 用于手动「立即检查」，不受开关限制
 */
async function runOnce(opts = {}) {
  const settings = store.getSettings();
  if (!opts.force && settings.invWatch === false) {
    return { skipped: true, reason: '监控已关闭', changes: [] };
  }
  if (!file) return { skipped: true, reason: '监控未初始化', changes: [] };

  const scan = accounts.scanAccounts();
  const live = await session.getSession().catch(() => null);
  const liveId = (live && live.steamId) || null;
  const apps = monitoredApps();
  const firstRun = !state.baselineAt;
  const at = Date.now();
  const newChanges = [];
  let accountsDone = 0;

  for (const u of scan.users) {
    // 只监控「有自己网页会话的号」和「当前登录的号」。
    // 其它号只能借当前登录态的 Cookie 去读，Steam 有时返回当前号的数据、
    // 有时返回空，快照不可靠，会把别人的东西算成"少了 200 件"。
    if (!hasCookies(u.steamId) && u.steamId !== liveId) continue;
    const accSnap = state.accounts[u.steamId] || {};
    const name = accountName(u);
    let any = false;
    for (const appId of apps) {
      let data = null;
      try {
        data = await inventory.fetchInventory(u.steamId, appId, null, { noNote: true });
      } catch (err) {
        logger.warn('库存监控：读取失败', {
          account: name,
          appId,
          message: shorten(err && err.message, 100),
        });
        await sleep(GAP_MS);
        continue;
      }
      const cur = {};
      for (const g of data.groups || []) {
        const key = g.marketHashName || g.key;
        if (!key) continue;
        cur[key] = { q: g.qty, n: shorten(g.name, 60) };
        if (Object.keys(cur).length >= MAX_ITEMS) break;
      }
      const prev = accSnap[appId];
      // 上次有东西、这次却读到空：优先当成读取异常（隐私/权限/接口抽风），
      // 不能当成"全部卖光"给用户弹 200 条通知
      if (prev && Object.keys(prev).length > 0 && Object.keys(cur).length === 0) {
        logger.warn('库存监控：本次读到空库存，保留上次快照', { account: name, appId });
        await sleep(GAP_MS);
        continue;
      }
      if (prev) newChanges.push(...diffApp(u.steamId, name, appId, prev, cur, at));
      accSnap[appId] = cur;
      any = true;
      await sleep(GAP_MS);
    }
    if (any) {
      state.accounts[u.steamId] = accSnap;
      accountsDone += 1;
    }
  }

  state.at = at;
  if (firstRun && accountsDone) state.baselineAt = at;
  if (newChanges.length) {
    state.changes = [...newChanges.reverse(), ...state.changes].slice(0, MAX_CHANGES);
    if (!firstRun) notifyChanges(newChanges);
  }
  save();

  logger.info('库存监控完成', {
    accounts: accountsDone,
    changes: newChanges.length,
    baseline: firstRun ? '建立基线' : '对比',
  });
  return { skipped: false, at, accounts: accountsDone, baseline: firstRun, changes: newChanges };
}

async function check() {
  if (running) return { skipped: true, reason: '正在检查' };
  running = true;
  try {
    return await runOnce();
  } catch (err) {
    logger.warn('库存监控失败', { message: err && err.message });
    return { skipped: true, reason: err && err.message };
  } finally {
    running = false;
  }
}

/** 某个账号的库存快照（appId → { 物品key: {q,n} }），给持仓盈亏复用，省一次网络请求 */
function snapshotFor(steamId) {
  if (!state || !state.accounts) return null;
  return state.accounts[String(steamId || '')] || null;
}

function getState() {
  const settings = store.getSettings();
  return {
    enabled: settings.invWatch !== false,
    at: state ? state.at || 0 : 0,
    baselineAt: state ? state.baselineAt || 0 : 0,
    accounts: state ? Object.keys(state.accounts || {}).length : 0,
    changes: state ? (state.changes || []).slice(0, 120) : [],
    monitoring: running,
    apps: monitoredApps(),
  };
}

function setEnabled(on) {
  store.setSettings({ invWatch: !!on });
  logger.info('库存监控开关', { enabled: !!on });
  return { enabled: !!on };
}

function start(opts = {}) {
  onOpen = opts.onOpen || null;
  iconPath = opts.icon || '';
  if (timer) return;
  setTimeout(() => {
    check();
    timer = setInterval(check, CHECK_MS);
  }, FIRST_DELAY);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  init,
  start,
  stop,
  check,
  runOnce,
  getState,
  setEnabled,
  _diffApp: diffApp,
  _snapshotFor: snapshotFor,
};
