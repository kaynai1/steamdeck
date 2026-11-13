'use strict';

/**
 * 挂机掉落提醒
 *
 * 针对「挂机游戏」这类按在线时长掉道具的游戏：定时读一次这些 AppID 的库存，
 * 发现新增物品就查一下市场价，超过设定门槛（默认 ¥5）就推一条通知。
 *
 * 监控范围：库里自带的挂机清单（只算你真正拥有的）+ 你在页面上手动「加入监控」的游戏。
 * 第一次运行只建基线、不通知，避免一开就把历史掉落全推一遍。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');
const session = require('./session');
const inventory = require('./inventory');
const market = require('./market');
const library = require('./steamLibrary');

const FIRST_DELAY = 2 * 60 * 1000;
const GAP_MS = 800;
const MAX_ITEMS = 500;

let file = null;
let timer = null;
let firstTimer = null;
let running = false;
let state = { accounts: {}, baselineAt: 0, lastAt: 0, lastResult: '', lastError: '' };

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'drop-watch.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state.accounts = loaded.accounts && typeof loaded.accounts === 'object' ? loaded.accounts : {};
      state.baselineAt = Number(loaded.baselineAt) || 0;
      state.lastAt = Number(loaded.lastAt) || 0;
      state.lastResult = String(loaded.lastResult || '');
      state.lastError = String(loaded.lastError || '');
    }
  } catch {
    /* 第一次运行没有文件 */
  }
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('掉落提醒状态写入失败', { message: err && err.message });
  }
}

function parseKeywords(v) {
  return String(v || '')
    .split(/[,，;；]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function options() {
  const s = store.getSettings();
  return {
    enabled: s.dropWatchEnabled === true,
    minYuan: Math.max(0, Number(s.dropWatchMinYuan) || 5),
    intervalMin: Math.max(10, Number(s.dropWatchIntervalMin) || 30),
    ignore: parseKeywords(s.dropIgnoreKeywords),
  };
}

/** 物品名命中排除关键词就忽略（箱子、涂鸦这类不值钱的东西别说个没完） */
function ignored(name, list) {
  if (!list.length) return false;
  const n = String(name || '').toLowerCase();
  return list.some((k) => n.includes(k.toLowerCase()));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function watched() {
  const s = store.getSettings();
  return Array.isArray(s.idleWatchApps) ? s.idleWatchApps : [];
}

/** 内置挂机清单里、当前账号真正拥有的游戏 */
function builtinOwned(steamId) {
  const ids = new Set();
  try {
    const owned = library.scanOwned(steamId);
    for (const a of (owned && owned.apps) || []) ids.add(Number(a.appId));
  } catch {
    /* 读不到就只监控手动添加的 */
  }
  const out = [];
  for (const w of watched()) {
    const id = Number(w && w.appId ? w.appId : w);
    if (id) out.push({ appId: id, name: (w && w.name) || `App ${id}` });
  }
  return { owned: ids, watched: out };
}

async function checkOnce(opts = {}) {
  const opt = options();
  if (!opts.force && !opt.enabled) return { skipped: true, reason: '掉落提醒未开启' };
  if (running) return { skipped: true, reason: '正在检查' };
  running = true;
  state.lastAt = Date.now();
  const drops = [];
  try {
    const live = await session.getSession().catch(() => null);
    const steamId = live && live.steamId;
    if (!steamId) {
      state.lastError = '还没有登录 Steam 网页会话';
      state.lastResult = '';
      save();
      return { error: state.lastError };
    }

    const { owned, watched: extra } = builtinOwned(steamId);
    const apps = new Map();
    for (const g of require('./idleMarket').games()) {
      const id = Number(g.appId);
      if (id && (owned.has(id) || !g.builtin)) apps.set(id, g.name);
    }
    for (const w of extra) apps.set(w.appId, w.name);

    const acc = state.accounts[steamId] && typeof state.accounts[steamId] === 'object'
      ? state.accounts[steamId]
      : {};
    const firstRun = !state.baselineAt;
    let scanned = 0;

    for (const [appId, appName] of apps) {
      let data = null;
      try {
        data = await inventory.fetchInventory(steamId, appId, null, { noNote: true });
      } catch (e) {
        logger.warn('掉落提醒：读取库存失败', { appId, message: e && e.message });
        await sleep(GAP_MS);
        continue;
      }
      const cur = {};
      for (const g of data.groups || []) {
        const key = g.marketHashName || g.key;
        if (!key) continue;
        cur[key] = { q: g.qty, n: g.name || key, hash: g.marketHashName || key };
        if (Object.keys(cur).length >= MAX_ITEMS) break;
      }
      const prev = acc[appId];
      // 上次有、这次读到空：按读取异常处理，保留旧快照
      if (prev && Object.keys(prev).length > 0 && Object.keys(cur).length === 0) {
        logger.warn('掉落提醒：本次读到空库存，保留上次快照', { appId });
        await sleep(GAP_MS);
        continue;
      }
      if (prev && !firstRun) {
        for (const [key, v] of Object.entries(cur)) {
          const old = prev[key];
          const delta = old ? v.q - old.q : v.q;
          if (delta > 0 && !ignored(v.n, opt.ignore)) drops.push({ appId, appName, key, name: v.n, delta });
        }
      }
      acc[appId] = cur;
      scanned++;
      await sleep(GAP_MS);
    }

    state.accounts[steamId] = acc;
    if (firstRun && scanned) state.baselineAt = Date.now();
    state.lastError = '';

    if (drops.length) {
      const priced = [];
      for (const d of drops.slice(0, 20)) {
        let q = null;
        try {
          q = await market.quoteOne(d.appId, d.key);
        } catch {
          /* 单件查价失败就跳过价格 */
        }
        const yuan = q && q.state === 'ok' ? (Number(q.lowest) || 0) / 100 : 0;
        priced.push({ ...d, yuan, volume: q && q.volume ? q.volume : null });
        await sleep(400);
      }
      const hit = priced.filter((d) => d.yuan >= opt.minYuan);
      const list = hit.length ? hit : [];
      if (list.length) {
        const lines = list.slice(0, 5).map((d) => {
          const vol = d.volume ? ` · 24h ${d.volume}` : '';
          return `· ${d.appName}：${d.name} ×${d.delta} 现价 ¥${d.yuan.toFixed(2)}${vol}`;
        });
        if (list.length > 5) lines.push(`…另有 ${list.length - 5} 件`);
        notify.send(`挂机掉落 ${list.length} 件（≥ ¥${opt.minYuan}）`, lines.join('\n'), { kind: 'good' });
        logger.info('挂机掉落提醒', { count: list.length });
      }
      state.lastResult = `新掉落 ${drops.length} 件，其中 ${(list || []).length} 件达到 ¥${opt.minYuan}`;
    } else {
      state.lastResult = firstRun ? `已建立基线（${scanned} 个游戏）` : '没有新的掉落';
    }
    save();
    return { drops: drops.length, scanned, baseline: firstRun };
  } catch (e) {
    state.lastError = (e && e.message) || '检查失败';
    state.lastResult = '';
    save();
    logger.warn('掉落提醒检查失败', { message: state.lastError });
    return { error: state.lastError };
  } finally {
    running = false;
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!options().enabled) return;
    checkOnce().catch(() => {});
  }, options().intervalMin * 60 * 1000);
}

function start() {
  if (firstTimer) clearTimeout(firstTimer);
  firstTimer = setTimeout(() => {
    if (options().enabled) checkOnce().catch(() => {});
  }, FIRST_DELAY);
  reschedule();
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

function getState() {
  const opt = options();
  return {
    enabled: opt.enabled,
    minYuan: opt.minYuan,
    intervalMin: opt.intervalMin,
    ignore: opt.ignore,
    lastAt: state.lastAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    accounts: Object.keys(state.accounts || {}).length,
  };
}

module.exports = { init, start, stop, checkOnce, reschedule, getState };
