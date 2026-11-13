'use strict';

/**
 * 自动守价（被别人压价时跟价）
 *
 * 与阶梯降价互补：
 *   - 阶梯降价管「挂了很久没人看」，按时间降；
 *   - 自动守价管「有人挂得比我便宜」，按市场最低价跟。
 *
 * 规则：
 *   - 只处理当前网页登录账号的挂单（上架接口的固有限制）；
 *   - 差价小于「最小降价空间」不动，避免为几分钱来回改；
 *   - 跟到「市场最低价 - 0.01」，但不低于成本 × 风控最低比例；
 *   - 可设「只通知不改价」：只提醒被压价，不动挂单；
 *   - 每轮、每日都有件数上限，并计入风控的每日改价次数；
 *   - 维护模式或已有上架任务时跳过本轮。
 *
 * 执行方式和阶梯降价一致：Steam 没有改价接口，只能下架 → 等 1.5 秒 → 按新价重上。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const session = require('./session');
const costs = require('./costs');
const seller = require('./seller');
const risk = require('./risk');
const market = require('./market');
const notify = require('./notify');
const autoWindow = require('./autoWindow');

const FIRST_DELAY = 9 * 60 * 1000;
const MIN_PRICE = 0.03;
const MAX_QUOTES_PER_RUN = 120;
const RENOTIFY_MS = 6 * 60 * 60 * 1000;

let file = null;
let state = null;
let timer = null;
let running = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(Object.assign(new Error(`${label}超时（网络或代理问题）`), { code: 'E_TIMEOUT' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyState() {
  return { sid: '', items: {}, day: dayKey(), count: 0, lastAt: 0, lastResult: null, log: [], error: '' };
}

function load() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    loaded = null;
  }
  state = loaded && typeof loaded === 'object' ? loaded : emptyState();
  if (!state.items || typeof state.items !== 'object') state.items = {};
  if (!Array.isArray(state.log)) state.log = [];
  if (!state.day) state.day = dayKey();
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'priceguard.json');
  load();
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('自动守价状态写入失败', { message: err && err.message });
  }
}

function options() {
  const s = store.getSettings();
  return {
    enabled: s.priceGuardEnabled === true,
    notifyOnly: s.priceGuardNotifyOnly === true,
    minGap: Math.max(0.01, Number(s.priceGuardMinGap) || 0.05),
    maxPerRun: Math.min(20, Math.max(1, Number(s.priceGuardMaxPerRun) || 5)),
    dailyCap: Math.max(0, Number(s.priceGuardDailyCap) || 50),
    intervalMin: Math.max(5, Number(s.priceGuardIntervalMin) || 30),
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
  state.log = [entry, ...state.log].slice(0, 80);
}

function keepAliveItems(entries) {
  const alive = new Set(entries.map(([assetId]) => String(assetId)));
  for (const key of Object.keys(state.items)) {
    if (!alive.has(key)) delete state.items[key];
  }
}

/** 把一件挂单的当前价与市场最低价对比，返回是否值得跟 */
function isUnderpriced(listing, lowest, minGap) {
  const current = Number(listing && listing.price) || 0;
  if (!(current > 0) || !(lowest > 0)) return false;
  return current - lowest > minGap;
}

/**
 * 跑一轮。
 * @param {{force?: boolean}} [opts] force 表示「立即检查」，忽略开关
 */
async function runOnce(opts = {}) {
  const opt = options();
  if (!opts.force && store.getSettings().automationPaused === true) {
    return { skipped: true, reason: '维护模式已暂停自动化' };
  }
  if (!opts.force && !autoWindow.inWindow()) {
    return { skipped: true, reason: `不在自动化时段（${autoWindow.describe()}）` };
  }
  if (!opts.force && !opt.enabled) return { skipped: true, reason: '自动守价未开启' };
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
    if (state.sid !== sid) {
      state.sid = sid;
      state.items = {};
      state.count = 0;
      save();
    }

    const map = await withTimeout(seller.fetchMyListings(sid, null), 25000, '读取挂单');
    const entries = Object.entries((map && map.map) || {}).filter(
      ([, l]) => l && typeof l === 'object' && l.listingId && Number(l.price) > 0 && l.marketHashName
    );
    keepAliveItems(Object.entries((map && map.map) || {}));

    const now = Date.now();
    const underpriced = [];
    let checked = 0;
    for (const [assetId, l] of entries) {
      if (checked >= MAX_QUOTES_PER_RUN) break;
      const rec = state.items[assetId] || {};
      // 刚被我们改过价的，10 分钟内不重复评估，避免来回折腾
      if (rec.at && now - Number(rec.at) < 10 * 60 * 1000) continue;
      // 刚挂上的挂单给一点稳定时间，别和自己的新价打架
      const createdAt = Number(l.createdAt) || 0;
      if (createdAt && now - createdAt * 1000 < 5 * 60 * 1000) continue;

      checked++;
      let q = null;
      try {
        q = await withTimeout(
          market.quoteOne(Number(l.appId) || 753, l.marketHashName),
          15000,
          '查询市场最低价'
        );
      } catch (err) {
        logger.warn('自动守价：查价失败', { name: l.marketHashName, message: err && err.message });
        continue;
      }
      const lowest = Number(q && q.lowest) || 0;
      if (!isUnderpriced(l, lowest, opt.minGap)) continue;

      const current = Number(l.price) || 0;
      const next = Math.max(MIN_PRICE, Math.round((lowest - 0.01) * 100) / 100);
      if (next >= current - 0.009) continue;

      // 成本保护：低于成本 × 风控比例就不跟了，留给人工决定
      const cost = costs.get(sid, l.marketHashName);
      const limit = risk.limits();
      if (cost && Number(cost.cost) > 0 && limit.minCostRatio > 0) {
        const floor = Number(cost.cost) * limit.minCostRatio;
        if (next < floor) continue;
      }

      underpriced.push({
        assetId: String(assetId),
        listingId: l.listingId,
        appId: Number(l.appId) || 753,
        contextId: l.contextId,
        marketHashName: l.marketHashName,
        name: l.name || l.marketHashName,
        current,
        lowest,
        priceYuan: next,
      });
    }

    if (!underpriced.length) {
      state.lastResult = { at: Date.now(), checked, underpriced: 0, listed: 0 };
      save();
      return { checked, underpriced: 0, listed: 0 };
    }

    // 只通知模式，或到了每日上限：发一次提醒，不动挂单
    const used = usedToday();
    const riskLimit = risk.limits();
    const riskUsed = risk.status().repricedToday;
    const riskRemaining =
      riskLimit.enabled && riskLimit.maxDailyReprice > 0
        ? Math.max(0, riskLimit.maxDailyReprice - riskUsed)
        : Infinity;
    const capacity = Math.min(opt.maxPerRun, Math.max(0, opt.dailyCap - used), riskRemaining);

    if (opt.notifyOnly || capacity <= 0) {
      const fresh = underpriced.filter((c) => {
        const rec = state.items[c.assetId] || {};
        return !rec.notifiedAt || Date.now() - Number(rec.notifiedAt) > RENOTIFY_MS;
      });
      for (const c of fresh) {
        state.items[c.assetId] = { ...(state.items[c.assetId] || {}), notifiedAt: Date.now() };
      }
      state.lastResult = {
        at: Date.now(),
        checked,
        underpriced: underpriced.length,
        listed: 0,
        reason: opt.notifyOnly ? '只通知模式' : '今日守价次数已达上限',
      };
      for (const c of fresh.slice(0, 8)) {
        pushLog({ at: Date.now(), name: c.name, current: c.current, lowest: c.lowest, status: 'notice' });
      }
      save();
      if (fresh.length) {
        notify.send(
          `自动守价 · ${fresh.length} 件挂单被压价`,
          fresh
            .slice(0, 4)
            .map((c) => `${c.name}：我 ${c.current.toFixed(2)} / 最低 ${c.lowest.toFixed(2)}`)
            .join('\n') + (opt.notifyOnly ? '\n（只通知模式，未改价）' : '')
        );
      }
      return {
        checked,
        underpriced: underpriced.length,
        listed: 0,
        mode: opt.notifyOnly ? 'notify' : 'capped',
      };
    }

    const todo = underpriced.slice(0, capacity);
    const items = todo.map((c) => ({
      assetId: c.assetId,
      appId: c.appId,
      contextId: c.contextId,
      marketHashName: c.marketHashName,
      name: c.name,
      priceYuan: c.priceYuan,
      // 用当前价做价格保护基准，避免被「低于最低价 70%」的通用规则误拦；
      // 真正的成本下限由风控的成本检查负责
      lowestPrice: c.current,
      marketable: true,
      tradable: true,
    }));

    let built = null;
    try {
      built = await seller.buildPlan({ items, strategy: 'manual', guardMinRatio: 0, steamId: sid });
    } catch (err) {
      state.error = (err && err.message) || String(err);
      state.lastResult = { at: Date.now(), checked, underpriced: underpriced.length, error: state.error };
      save();
      return { error: state.error };
    }
    const executableIds = new Set(((built && built.executable) || []).map((x) => String(x.assetId)));
    const toRemove = todo.filter((c) => executableIds.has(c.assetId));

    let removed = 0;
    const reload = [];
    for (let i = 0; i < toRemove.length; i++) {
      const c = toRemove[i];
      try {
        await seller.removeListing(sid, c.listingId);
        removed++;
        reload.push({
          assetId: c.assetId,
          appId: c.appId,
          contextId: c.contextId,
          marketHashName: c.marketHashName,
          name: c.name,
          priceYuan: c.priceYuan,
          lowestPrice: 0,
          marketable: true,
          tradable: true,
          original: c.current,
        });
      } catch (err) {
        logger.warn('自动守价：下架失败', { name: c.name, message: err && err.message });
      }
      if (i < toRemove.length - 1) await sleep(1100);
    }

    let run = null;
    let restoreError = '';
    if (reload.length) {
      await sleep(1500);
      const clean = reload.map(({ original, ...x }) => x);
      try {
        run = await seller.runQueue({
          items: clean,
          strategy: 'manual',
          guardMinRatio: 0,
          steamId: sid,
          source: 'guard',
        });
      } catch (err) {
        try {
          await seller.runQueue({
            items: reload.map(({ original, ...x }) => ({ ...x, priceYuan: original })),
            strategy: 'manual',
            guardMinRatio: 0,
            steamId: sid,
            source: 'guard',
          });
          restoreError = '重新上架失败，已按原价补回';
        } catch (e2) {
          restoreError = `已下架但未能重新上架：${e2.message}，请在挂单页手动处理`;
        }
        state.error = restoreError;
        logger.warn('自动守价：重新上架失败', { message: restoreError });
      }
    }

    const okIds = new Set(
      ((run && run.executed) || [])
        .filter((x) => x.status === 'listed')
        .map((x) => String(x.assetId))
    );
    for (const c of todo) {
      if (!okIds.has(c.assetId)) continue;
      state.items[c.assetId] = { ...(state.items[c.assetId] || {}), at: Date.now(), from: c.current, to: c.priceYuan };
      pushLog({ at: Date.now(), name: c.name, from: c.current, to: c.priceYuan, lowest: c.lowest, status: 'ok' });
    }
    const okCount = okIds.size;
    if (okCount > 0) {
      if (state.day !== dayKey()) {
        state.day = dayKey();
        state.count = 0;
      }
      state.count = (Number(state.count) || 0) + okCount;
    }
    state.lastResult = {
      at: Date.now(),
      checked,
      underpriced: underpriced.length,
      removed,
      listed: okCount,
      blocked: toRemove.length - okCount,
      pendingConfirm: Number(run && run.pendingConfirm) || 0,
      error: restoreError,
    };
    save();

    if (restoreError) notify.send('自动守价需要手动处理', restoreError);
    if (okCount > 0) {
      notify.send(
        `自动守价 · 跟价 ${okCount} 件`,
        todo
          .filter((c) => okIds.has(c.assetId))
          .slice(0, 4)
          .map((c) => `${c.name}：${c.current.toFixed(2)} → ${c.priceYuan.toFixed(2)}（最低 ${c.lowest.toFixed(2)}）`)
          .join('\n')
      );
    }
    // 有被压价但没处理的（成本下限、风控）也提醒一次
    const left = underpriced.length - okCount;
    if (left > 0) {
      notify.send(
        `自动守价 · 还有 ${left} 件被压价未处理`,
        '可能触发成本下限或风控，打开挂单页手动确认。'
      );
    }
    return {
      checked,
      underpriced: underpriced.length,
      listed: okCount,
      removed,
      error: restoreError,
    };
  } catch (err) {
    state.error = (err && err.message) || String(err);
    state.lastResult = { at: Date.now(), error: state.error };
    save();
    logger.warn('自动守价失败', { message: state.error });
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
    day: state ? state.day : '',
    count: state ? usedToday() : 0,
    lastAt: state ? state.lastAt : 0,
    lastResult: state ? state.lastResult : null,
    log: state ? state.log : [],
    error: state ? state.error : '',
    risk: risk.status(),
  };
}

function setOptions(patch) {
  const p = patch || {};
  const out = {};
  if ('enabled' in p) out.priceGuardEnabled = !!p.enabled;
  if ('notifyOnly' in p) out.priceGuardNotifyOnly = !!p.notifyOnly;
  if ('minGap' in p) out.priceGuardMinGap = Math.min(10, Math.max(0.01, Number(p.minGap) || 0.05));
  if ('maxPerRun' in p) out.priceGuardMaxPerRun = Math.min(20, Math.max(1, Number(p.maxPerRun) || 5));
  if ('dailyCap' in p) out.priceGuardDailyCap = Math.max(0, Number(p.dailyCap) || 50);
  if ('intervalMin' in p) out.priceGuardIntervalMin = Math.max(5, Number(p.intervalMin) || 30);
  store.setSettings(out);
  if ('enabled' in p && p.enabled && !timer) start();
  return getState();
}

function start() {
  if (timer) return;
  const tick = async () => {
    timer = null;
    try {
      if (!store.getSettings().automationPaused) await runOnce();
    } catch (err) {
      logger.warn('自动守价定时任务异常', { message: err && err.message });
    }
    const opt = options();
    timer = setTimeout(tick, Math.max(5, opt.intervalMin) * 60 * 1000);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(tick, FIRST_DELAY);
  if (timer.unref) timer.unref();
}

module.exports = { init, start, runOnce, getState, setOptions };
