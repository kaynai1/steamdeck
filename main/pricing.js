'use strict';

/**
 * 智能定价建议
 *
 * 只看"当前最低在售价"容易被短期压价带偏，这里把近 7 天 / 30 天的
 * 成交价分位数也算进来：
 *   快速出手价 = min(当前最低 -0.01, 近 7 天 p25, 近 30 天 p25)
 *   保守价     = 近 30 天 p50（没有就用 7 天 p50 / 当前最低）
 *
 * 分位数来自 Steam 官方 /market/pricehistory/，需要社区登录态。
 * 结果缓存 30 分钟，避免批量操作时反复打接口。
 */

const market = require('./market');

const CACHE_MS = 30 * 60 * 1000;
const MAX_ITEMS = 12;
const GAP_MS = 450;

const cache = new Map(); // "appId:hash" -> { at, data }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 网络不通时 bridge 通道可能长时间不返回，这里加个硬超时 */
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

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function windowStats(points, days, now) {
  const cutoff = now - days * 86400000;
  const prices = (points || [])
    .filter((p) => p.t >= cutoff && Number(p.price) > 0)
    .map((p) => Number(p.price))
    .sort((a, b) => a - b);
  if (!prices.length) return { n: 0, p25: 0, p50: 0 };
  return {
    n: prices.length,
    p25: percentile(prices, 0.25),
    p50: percentile(prices, 0.5),
  };
}

async function suggestOne(appId, hashName) {
  const key = `${appId}:${hashName}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let quote = null;
  try {
    quote = await withTimeout(market.quoteOne(appId, hashName), 12000, '查当前最低价');
  } catch {
    quote = null;
  }
  let hist = null;
  try {
    hist = await withTimeout(market.priceHistory(appId, hashName), 12000, '查历史成交');
  } catch {
    hist = null;
  }

  const now = Date.now();
  const d7 = windowStats(hist && hist.points, 7, now);
  const d30 = windowStats(hist && hist.points, 30, now);
  const lowest = Number(quote && quote.lowest) || 0;

  const fastCandidates = [];
  if (lowest > 0) fastCandidates.push(Math.round((lowest - 0.01) * 100) / 100);
  if (d7.p25 > 0) fastCandidates.push(d7.p25);
  if (d30.p25 > 0) fastCandidates.push(d30.p25);
  const fast = fastCandidates.length ? Math.max(0.03, Math.min(...fastCandidates)) : 0;

  let safe = 0;
  if (d30.p50 > 0) safe = d30.p50;
  else if (d7.p50 > 0) safe = d7.p50;
  else if (lowest > 0) safe = lowest;
  safe = safe > 0 ? Math.max(0.03, Math.round(safe * 100) / 100) : 0;

  const data = {
    appId,
    marketHashName: hashName,
    lowest,
    fast,
    safe,
    median7: d7.p50,
    median30: d30.p50,
    samples7: d7.n,
    samples30: d30.n,
    volume30: (hist && hist.last30Volume) || 0,
    hasHistory: !!(hist && hist.points && hist.points.length),
    at: now,
  };
  cache.set(key, { at: now, data });
  return data;
}

/**
 * @param {Array<{appId:number, hashName:string}>} list
 */
async function suggest(list) {
  const seen = new Set();
  const out = [];
  for (const it of (list || []).slice(0, MAX_ITEMS)) {
    const appId = Number(it && it.appId) || 753;
    const hashName = String((it && it.hashName) || '').trim();
    if (!hashName) continue;
    const key = `${appId}:${hashName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      out.push(await suggestOne(appId, hashName));
    } catch (err) {
      out.push({
        appId,
        marketHashName: hashName,
        lowest: 0,
        fast: 0,
        safe: 0,
        error: (err && err.message) || '查价失败',
      });
    }
    await sleep(GAP_MS);
  }
  return { items: out, at: Date.now() };
}

module.exports = { suggest };
