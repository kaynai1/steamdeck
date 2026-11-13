'use strict';

/**
 * 挂单自动补货
 *
 * 思路：盯"我卖出的"成交记录。发现新成交后，如果库存里还有同款
 * （可上架、不在交易冷却、当前也没挂着），就按当时市场最低价 -0.01 重新挂上。
 *
 * 约束（必须记住）：
 *   - 上架只能替"当前网页登录的账号"操作，所以只对实时会话账号生效；
 *   - 第一次运行/换号只记基线，不补历史旧成交，避免一开软件就挂出去一堆；
 *   - 每日有件数上限，单轮也有上限，防止失控；
 *   - 只补"成交"留下的空位，手动下架的不会被自动挂回去。
 */

const fs = require('fs');
const path = require('path');
const notifier = require('./notify');
const store = require('./store');
const logger = require('./logger');
const session = require('./session');
const inventory = require('./inventory');
const market = require('./market');
const seller = require('./seller');
const history = require('./marketHistory');
const autoWindow = require('./autoWindow');

const FIRST_DELAY = 4 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

let file = null;
let state = null;
let timer = null;
let running = false;
let iconPath = '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 后台任务不能无限等：bridge 通道在网络异常时可能一直不返回 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${label}超时（网络或代理问题）`), { code: 'E_TIMEOUT' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyState() {
  return {
    sid: '',
    baselineAt: 0,
    seen: [],
    day: dayKey(),
    count: 0,
    lastAt: 0,
    lastResult: null,
    log: [],
    error: '',
  };
}

function load() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    loaded = null;
  }
  state = loaded && typeof loaded === 'object' ? loaded : emptyState();
  if (!Array.isArray(state.seen)) state.seen = [];
  if (!Array.isArray(state.log)) state.log = [];
  if (!state.day) state.day = dayKey();
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'restock.json');
  load();
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('自动补货状态写入失败', { message: err && err.message });
  }
}

function options() {
  const s = store.getSettings();
  return {
    enabled: s.restock === true,
    dailyCap: Math.max(0, Number(s.restockDailyCap) || 10),
    maxPerRun: Math.max(1, Number(s.restockMaxPerRun) || 3),
    intervalMin: Math.max(5, Number(s.restockIntervalMin) || 20),
  };
}

function usedToday() {
  if (!state) return 0;
  if (state.day !== dayKey()) {
    state.day = dayKey();
    state.count = 0;
  }
  return Number(state.count) || 0;
}

function pushLog(entry) {
  state.log = [entry, ...state.log].slice(0, 60);
}

function notify(lines, count) {
  notifier.send(`自动补货 · 已重新上架 ${count} 件`, lines.slice(0, 4).join('\n'));
}

/**
 * 跑一轮补货。
 * @param {{force?: boolean}} [opts] force 表示手动「立即检查」，忽略开关
 */
async function runOnce(opts = {}) {
  const opt = options();
  if (!opts.force && !opt.enabled) return { skipped: true, reason: '自动补货未开启' };
  if (!opts.force && store.getSettings().automationPaused === true) {
    return { skipped: true, reason: '维护模式已暂停自动化' };
  }
  if (!opts.force && !autoWindow.inWindow()) {
    return { skipped: true, reason: `不在自动化时段（${autoWindow.describe()}）` };
  }
  if (running) return { skipped: true, reason: '正在检查' };
  if (!state) return { skipped: true, reason: '未初始化' };

  running = true;
  state.error = '';
  state.lastAt = Date.now();
  try {
    const ses = await session.getSession();
    if (!ses || !ses.steamId) {
      state.lastResult = { at: Date.now(), skipped: '没有可用的网页登录会话' };
      save();
      return { skipped: true, reason: '没有可用的网页登录会话' };
    }
    const sid = String(ses.steamId);

    // 换号：重新建基线，不补别的号的历史成交
    if (state.sid !== sid || !state.baselineAt) {
      state.sid = sid;
      state.baselineAt = Date.now();
      state.seen = [];
      state.lastResult = { at: Date.now(), baseline: true, sid };
      save();
      logger.info('自动补货：建立基线', { sid });
      return { baseline: true, sid };
    }

    const hist = await withTimeout(history.recentHistory(), 20000, '读取成交记录');
    const sells = (hist.items || []).filter(
      (it) =>
        it.kind === 'sell' &&
        it.marketHashName &&
        Number(it.time) * 1000 > state.baselineAt &&
        !state.seen.includes(it.id)
    );
    if (!sells.length) {
      state.baselineAt = Date.now();
      state.lastResult = { at: Date.now(), sales: 0, listed: 0 };
      save();
      return { sales: 0, listed: 0 };
    }

    const cap = opt.dailyCap;
    const used = usedToday();
    const remaining = Math.max(0, cap - used);
    if (!remaining) {
      state.seen = [...new Set([...state.seen, ...sells.map((s) => s.id)])].slice(-500);
      state.baselineAt = Date.now();
      state.lastResult = { at: Date.now(), sales: sells.length, listed: 0, reason: '今日补货已达上限' };
      save();
      return { sales: sells.length, listed: 0, reason: '今日补货已达上限' };
    }

    const todo = sells.slice(0, Math.min(opt.maxPerRun, remaining));
    const byApp = new Map();
    for (const s of todo) {
      const app = Number(s.appid) || 753;
      if (!byApp.has(app)) byApp.set(app, []);
      byApp.get(app).push(s);
    }

    // 当前已挂着的 assetId：不能重复上架同一件
    let listingMap = {};
    try {
      const l = await withTimeout(seller.fetchMyListings(sid, null), 20000, '读取挂单');
      listingMap = (l && l.map) || {};
    } catch (err) {
      logger.warn('自动补货：读取挂单失败', { message: err && err.message });
    }
    const listedIds = new Set(Object.keys(listingMap));

    const items = [];
    const consumed = [];
    const skipped = [];
    for (const [appId, sales] of byApp) {
      let inv = null;
      try {
        inv = await withTimeout(
          inventory.fetchInventory(sid, appId, null, { noNote: true }),
          30000,
          '读取库存'
        );
      } catch (err) {
        skipped.push(`${appId}: 库存读取失败 ${err.message}`);
        continue;
      }
      const groups = new Map((inv.groups || []).map((g) => [g.marketHashName || g.key, g]));
      for (const s of sales) {
        const g = groups.get(s.marketHashName);
        if (!g) {
          skipped.push(`${s.name}: 库存里没有同款`);
          continue;
        }
        // 市场只要求 marketable；交易冷却中的物品照样能挂单
        const asset = (g.assets || []).find(
          (a) => a.marketable && !listedIds.has(String(a.assetId))
        );
        if (!asset) {
          skipped.push(`${s.name}: 同款都不可售或已挂单`);
          continue;
        }
        let q = null;
        try {
          q = await withTimeout(
            market.quoteOne(g.appId || appId, s.marketHashName, { force: true }),
            15000,
            '查价'
          );
        } catch {
          q = null;
        }
        const lowest = Number(q && q.lowest) || 0;
        if (!(lowest > 0)) {
          skipped.push(`${s.name}: 没有行情，无法定价`);
          continue;
        }
        const priceYuan = Math.max(0.03, Math.round((lowest - 0.01) * 100) / 100);
        const item = {
          assetId: String(asset.assetId),
          appId: g.sourceAppId || appId,
          contextId: asset.contextId || g.contextId || '2',
          marketHashName: s.marketHashName,
          name: s.name || g.name,
          priceYuan,
          lowestPrice: lowest,
          marketable: true,
          tradable: true,
        };
        // 同一件 assetid 一批里只用一次
        if (items.some((x) => x.assetId === item.assetId)) continue;
        items.push(item);
        listedIds.add(item.assetId);
        consumed.push(s);
        await sleep(500);
      }
    }

    let run = null;
    if (items.length) {
      try {
        run = await seller.runQueue({
          items,
          strategy: 'manual',
          steamId: sid,
          source: 'restock',
        });
      } catch (err) {
        if (err && err.code === 'E_BUSY') {
          // 用户正在上架：这批卖出的记录不标记，下一轮再补
          state.lastResult = { at: Date.now(), sales: sells.length, listed: 0, reason: '有上架任务在跑' };
          save();
          return { sales: sells.length, listed: 0, reason: '有上架任务在跑' };
        }
        state.error = err.message;
        logger.warn('自动补货：上架失败', { message: err.message });
      }
    }

    const okCount = Number(run && run.ok) || 0;
    const failed = Number(run && run.fail) || 0;
    if (items.length) {
      state.count = usedToday() + okCount;
      state.day = dayKey();
    }
    // 失败 / 被风控拦下的不标记，下一轮还能重试；成功或明确跳过的才记为已处理
    const failedHashes = new Set(
      [
        ...((run && run.executed) || []).filter((x) => x.status === 'failed').map((x) => x.marketHashName),
        ...((run && run.blocked) || []).map((x) => x.marketHashName),
      ].filter(Boolean)
    );
    const processedIds = run
      ? consumed.filter((s) => !failedHashes.has(s.marketHashName)).map((s) => s.id)
      : [];
    if (processedIds.length) {
      state.seen = [...new Set([...state.seen, ...processedIds])].slice(-500);
    }
    state.baselineAt = Date.now();

    for (const it of items) {
      pushLog({
        at: Date.now(),
        name: it.name,
        priceYuan: it.priceYuan,
        assetId: it.assetId,
        status: failedHashes.has(it.marketHashName) ? 'failed' : 'listed',
      });
    }
    for (const line of skipped.slice(0, 6)) pushLog({ at: Date.now(), name: line, status: 'skip' });

    state.lastResult = {
      at: Date.now(),
      sales: sells.length,
      listed: okCount,
      failed,
      skipped: skipped.length,
      pendingConfirm: Number(run && run.pendingConfirm) || 0,
      blocked: Number(run && run.blocked && run.blocked.length) || 0,
      error: state.error || '',
    };
    save();

    if (okCount > 0) {
      notify(
        items.slice(0, 4).map((x) => `${x.name}  ¥${x.priceYuan.toFixed(2)}`),
        okCount
      );
    }
    logger.info('自动补货完成', {
      sales: sells.length,
      listed: okCount,
      failed,
      skipped: skipped.length,
    });
    return { sales: sells.length, listed: okCount, failed, skipped: skipped.length, items };
  } catch (err) {
    state.error = (err && err.message) || String(err);
    state.lastResult = { at: Date.now(), error: state.error };
    save();
    logger.warn('自动补货失败', { message: state.error });
    return { error: state.error };
  } finally {
    running = false;
  }
}

function getState() {
  const opt = options();
  return {
    ...opt,
    sid: state ? state.sid : '',
    baselineAt: state ? state.baselineAt : 0,
    lastAt: state ? state.lastAt : 0,
    usedToday: state ? usedToday() : 0,
    lastResult: state ? state.lastResult : null,
    log: state ? state.log.slice(0, 40) : [],
    monitoring: running,
    error: state ? state.error : '',
  };
}

function setEnabled(on) {
  store.setSettings({ restock: !!on });
  logger.info('自动补货开关', { enabled: !!on });
  return { enabled: !!on };
}

function start(opts = {}) {
  iconPath = opts.icon || '';
  if (timer) return;
  setTimeout(() => {
    maybeRun();
    timer = setInterval(maybeRun, TICK_MS);
  }, FIRST_DELAY);
}

function maybeRun() {
  if (!state || running) return;
  if (store.getSettings().automationPaused === true) return;
  const opt = options();
  if (!opt.enabled) return;
  if (state.lastAt && Date.now() - state.lastAt < opt.intervalMin * 60 * 1000) return;
  runOnce().catch(() => {});
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { init, start, stop, runOnce, getState, setEnabled, options };
