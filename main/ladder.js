'use strict';

/**
 * 阶梯降价（滞销自动清仓）
 *
 * 自动守价管的是"被别人压价"的挂单；这里管的是"挂很久也没人看"的。
 * 规则：挂满 N 天没卖掉，自动降一档（默认 5%），最多降 M 档；
 * 每件每次只降一档，下一轮再评估，避免一次性砍到底。
 *
 * 安全边界：
 *   - 默认关闭，用户在设置里手动开；
 *   - 只对当前网页登录账号生效（上架接口的固有限制）；
 *   - 降价不低于成本 × 风控最低比例，也不低于 0.03 元；
 *   - 每日改价次数沿用风控上限；
 *   - 维护模式或手动任务进行中时跳过本轮。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const session = require('./session');
const costs = require('./costs');
const seller = require('./seller');
const risk = require('./risk');
const notify = require('./notify');
const autoWindow = require('./autoWindow');

const FIRST_DELAY = 6 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const MIN_PRICE = 0.03;

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

function emptyState() {
  return { sid: '', items: {}, lastAt: 0, lastResult: null, log: [], error: '' };
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
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'ladder.json');
  load();
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('阶梯降价状态写入失败', { message: err && err.message });
  }
}

function options() {
  const s = store.getSettings();
  return {
    enabled: s.ladderEnabled === true,
    days: Math.max(1, Number(s.ladderDays) || 7),
    stepPct: Math.min(50, Math.max(1, Number(s.ladderStepPct) || 5)),
    maxSteps: Math.min(20, Math.max(1, Number(s.ladderMaxSteps) || 3)),
    maxPerRun: Math.min(20, Math.max(1, Number(s.ladderMaxPerRun) || 5)),
    intervalMin: Math.max(10, Number(s.ladderIntervalMin) || 60),
  };
}

function pushLog(entry) {
  state.log = [entry, ...state.log].slice(0, 60);
}

function priceAfter(current, pct) {
  const next = Math.round(current * (1 - pct / 100) * 100) / 100;
  return Math.max(MIN_PRICE, next);
}

/**
 * 跑一轮。
 * @param {{force?: boolean}} [opts]
 */
async function runOnce(opts = {}) {
  const opt = options();
  if (!opts.force && store.getSettings().automationPaused === true) {
    return { skipped: true, reason: '维护模式已暂停自动化' };
  }
  if (!opts.force && !autoWindow.inWindow()) {
    return { skipped: true, reason: `不在自动化时段（${autoWindow.describe()}）` };
  }
  if (!opts.force && !opt.enabled) return { skipped: true, reason: '阶梯降价未开启' };
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

    // 换号：上架只能替当前登录号操作，旧号的状态留着也没用
    if (state.sid !== sid) {
      state.sid = sid;
      state.items = {};
      save();
    }

    const map = await withTimeout(seller.fetchMyListings(sid, null), 25000, '读取挂单');
    const entries = Object.entries((map && map.map) || {});
    const alive = new Set(entries.map(([assetId]) => String(assetId)));

    // 已经卖掉/下架的挂单，去掉记录，避免状态无限增长
    for (const key of Object.keys(state.items)) {
      if (!alive.has(key)) delete state.items[key];
    }

    const now = Date.now();
    const candidates = [];
    for (const [assetId, l] of entries) {
      if (!l || !(l.price > 0)) continue;
      const createdAt = Number(l.createdAt) || 0;
      // Steam 的 created_at 是秒；没有就跳过，不能猜
      if (!createdAt) continue;
      const ageDays = Math.max(0, (now - createdAt * 1000) / 86400000);
      const desired = Math.min(opt.maxSteps, Math.floor(ageDays / opt.days));
      const rec = state.items[assetId] || { steps: 0 };
      if (desired <= (Number(rec.steps) || 0)) continue;

      const current = Number(l.price) || 0;
      const next = priceAfter(current, opt.stepPct);
      if (next >= current - 0.009) continue;

      // 成本保护：低于成本 × 风控比例就不降了，留给人工决定
      const cost = costs.get(sid, l.marketHashName);
      const limit = risk.limits();
      if (cost && Number(cost.cost) > 0 && limit.minCostRatio > 0) {
        const floor = Number(cost.cost) * limit.minCostRatio;
        if (next < floor) continue;
      }

      candidates.push({
        assetId: String(assetId),
        listingId: l.listingId,
        appId: l.appId,
        contextId: l.contextId,
        marketHashName: l.marketHashName,
        name: l.name || l.marketHashName,
        current,
        priceYuan: next,
        ageDays: Math.floor(ageDays),
        steps: Number(rec.steps) || 0,
      });
    }

    if (!candidates.length) {
      state.lastResult = { at: Date.now(), checked: entries.length, listed: 0 };
      save();
      return { checked: entries.length, listed: 0 };
    }

    const todo = candidates.slice(0, opt.maxPerRun);
    const items = todo.map((c) => ({
      assetId: c.assetId,
      appId: c.appId,
      contextId: c.contextId,
      marketHashName: c.marketHashName,
      name: c.name,
      priceYuan: c.priceYuan,
      // 传自己的当前价做价格保护基准：降 5% 远高于 70% 阈值，不会被误拦；
      // 真正的成本下限由风控 checkItem 负责
      lowestPrice: c.current,
      marketable: true,
      tradable: true,
    }));

    // Steam 没有改价接口，只能先下架再按新价重新上架。
    // 先跑一遍计划：被风控/成本下限拦下的不要下架，否则物品会白白躺在库存里。
    let built = null;
    try {
      built = await seller.buildPlan({ items, strategy: 'manual', guardMinRatio: 0, steamId: sid });
    } catch (err) {
      state.error = (err && err.message) || String(err);
      state.lastResult = { at: Date.now(), checked: entries.length, error: state.error };
      save();
      logger.warn('阶梯降价：生成计划失败', { message: state.error });
      return { error: state.error };
    }
    const executableIds = new Set(
      ((built && built.executable) || []).map((x) => String(x.assetId))
    );
    const toRemove = todo.filter((c) => executableIds.has(c.assetId));
    const blockedCount = todo.length - toRemove.length;

    let removed = 0;
    let removeFail = 0;
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
        removeFail++;
        logger.warn('阶梯降价：下架失败', { name: c.name, message: err && err.message });
      }
      if (i < toRemove.length - 1) await sleep(1100);
    }

    let run = null;
    let restoreError = '';
    if (reload.length) {
      // 下架后物品要过一会儿才回到库存，立刻重上架容易报"找不到物品"
      await sleep(1500);
      const clean = reload.map(({ original, ...x }) => x);
      try {
        run = await seller.runQueue({
          items: clean,
          strategy: 'manual',
          guardMinRatio: 0,
          steamId: sid,
          source: 'ladder',
        });
      } catch (err) {
        // 已经下架了就必须补回，绝不能把物品留在库存里没人管
        try {
          await seller.runQueue({
            items: reload.map(({ original, ...x }) => ({ ...x, priceYuan: original })),
            strategy: 'manual',
            guardMinRatio: 0,
            steamId: sid,
            source: 'ladder',
          });
          restoreError = '重新上架失败，已按原价补回';
        } catch (e2) {
          restoreError = `已下架但未能重新上架：${e2.message}，请在挂单页手动处理`;
        }
        state.error = restoreError;
        logger.warn('阶梯降价：重新上架失败', { message: restoreError });
      }
    }

    const okIds = new Set(
      ((run && run.executed) || [])
        .filter((x) => x.status === 'listed')
        .map((x) => String(x.assetId))
    );
    for (const c of todo) {
      if (!okIds.has(c.assetId)) continue;
      state.items[c.assetId] = {
        steps: c.steps + 1,
        at: Date.now(),
        from: c.current,
        to: c.priceYuan,
      };
      pushLog({
        at: Date.now(),
        name: c.name,
        from: c.current,
        to: c.priceYuan,
        ageDays: c.ageDays,
        status: 'ok',
      });
    }
    const okCount = okIds.size;
    state.lastResult = {
      at: Date.now(),
      checked: entries.length,
      candidates: candidates.length,
      removed,
      removeFail,
      listed: okCount,
      blocked: blockedCount + (Number(run && run.blocked && run.blocked.length) || 0),
      pendingConfirm: Number(run && run.pendingConfirm) || 0,
      error: restoreError,
    };
    save();

    if (restoreError) {
      notify.send('阶梯降价需要手动处理', restoreError);
    }

    if (okCount > 0) {
      notify.send(
        `阶梯降价 · 调整 ${okCount} 件`,
        todo
          .filter((c) => okIds.has(c.assetId))
          .slice(0, 4)
          .map((c) => `${c.name}：${c.current.toFixed(2)} → ${c.priceYuan.toFixed(2)}（挂了 ${c.ageDays} 天）`)
          .join('\n')
      );
    }
    logger.info('阶梯降价完成', { checked: entries.length, listed: okCount });
    return { checked: entries.length, candidates: candidates.length, listed: okCount, items: todo };
  } catch (err) {
    state.error = (err && err.message) || String(err);
    state.lastResult = { at: Date.now(), error: state.error };
    save();
    logger.warn('阶梯降价失败', { message: state.error });
    return { error: state.error };
  } finally {
    running = false;
    await sleep(0);
  }
}

function getState() {
  const opt = options();
  return {
    ...opt,
    sid: state ? state.sid : '',
    lastAt: state ? state.lastAt : 0,
    tracked: state ? Object.keys(state.items || {}).length : 0,
    lastResult: state ? state.lastResult : null,
    log: state ? state.log.slice(0, 30) : [],
    running,
    error: state ? state.error : '',
    paused: store.getSettings().automationPaused === true,
  };
}

function setEnabled(on) {
  store.setSettings({ ladderEnabled: !!on });
  logger.info('阶梯降价开关', { enabled: !!on });
  return { enabled: !!on };
}

function start() {
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
