'use strict';

const { EventEmitter } = require('events');
const store = require('./store');
const session = require('./session');
const bridge = require('./steamBridge');
const archive = require('./archive');

const emitter = new EventEmitter();

/**
 * 行情查价队列。
 * 关键约束（实践数据）：
 *   - priceoverview 没有官方配额，但大约每分钟 20 次之后开始返回 429 / 空
 *   - 必须串行、间隔 ≥1.5s、同一商品缓存 ≥10 分钟
 *   - currency=23 是人民币，参数固定，否则按服务器地区返回美元
 */

let running = false;
let cancelFlag = false;
let lastProgress = { total: 0, done: 0, ok: 0, fail: 0, state: 'idle', message: '' };

function emitProgress(patch) {
  lastProgress = { ...lastProgress, ...patch };
  emitter.emit('progress', lastProgress);
  return lastProgress;
}

function queueStats() {
  return { ...lastProgress, running };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 解析 "¥ 1,286.00" / "$1,286.00" 之类的字符串为数字 */
function parsePrice(str) {
  if (str === null || str === undefined) return null;
  if (typeof str === 'number') return str;
  const cleaned = String(str).replace(/[^\d.,]/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 解析 "1,234" 成交量为数字 */
function parseVolume(str) {
  if (!str) return 0;
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 关键：Steam 社区物品（753/6 拿到的卡牌、背景、表情）在 Steam 市场上挂在
 * 社区物品大类 appid=753 下，格式为 "游戏AppID-物品HashName"，如 "221040-:bar_closed:"。
 * 必须以 753 作为主查 ID，并同时支持带/不带前缀的真实市场名字容错。
 */
function appCandidatesFor(appId, hashName) {
  const base = Number(appId) || 730;
  const out = [];
  const m = /^(\d+)-/.exec(String(hashName || ''));

  if (base === 753 || m) {
    // 753 社区物品（卡牌、背景、表情）在市场上的 appid 永远是 753
    out.push(753);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n !== 753) out.push(n);
    }
  } else {
    out.push(base);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
    if (base !== 753) out.push(753);
  }
  return [...new Set(out)];
}

/** 市场所属 appid（前端也用它给每件物品打 appid，避免整批用同一个） */
function marketAppIdOf(appId, hashName) {
  return appCandidatesFor(appId, hashName)[0];
}

const PRICE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchPriceOverview(appId, hashName) {
  const url = new URL('https://steamcommunity.com/market/priceoverview/');
  url.searchParams.set('appid', String(appId));
  url.searchParams.set('currency', '23'); // 人民币
  url.searchParams.set('market_hash_name', hashName);

  /**
   * ★ priceoverview 是公开接口，不需要登录 ★
   * 之前所有查价都强制走 bridge（隐藏浏览器窗口）：
   *   - 窗口没起来 / 社区首页被墙时，整批查价直接失败；
   *   - 每查一次都要过一次 executeJavaScript，慢且容易被串行队列拖住。
   * 实测直连（带 UA + Referer + 人民币 currency）稳定返回 200，
   * 所以现在先直连，直连失败才回落到页面通道。
   */
  const directInit = {
    headers: {
      'User-Agent': PRICE_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `https://steamcommunity.com/market/listings/${appId}/${encodeURIComponent(hashName)}`,
    },
    signal: AbortSignal.timeout(8000),
  };

  let res = null;
  let directErr = null;

  try {
    res = await fetch(url.toString(), directInit);
  } catch (err) {
    directErr = err;
  }

  if (!res || !res.ok) {
    // 直连失败（网络/代理/401/403/5xx）→ 用社区页面通道再试一次
    if (!res || res.status === 401 || res.status === 403 || res.status >= 500) {
      try {
        res = await bridge.communityFetch(url.toString(), {
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        directErr = null;
      } catch (err) {
        if (!res) throw Object.assign(new Error(`查价请求失败：${err.message}`), { code: 'E_NET', appId });
      }
    }
  }

  if (!res) {
    throw Object.assign(new Error(`查价请求失败：${(directErr && directErr.message) || '无响应'}`), {
      code: 'E_NET',
      appId,
    });
  }

  if (res.status === 429) {
    throw Object.assign(new Error('查价被限流（429）'), { code: 'E_RATE_LIMIT', retryable: true, appId });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`查价接口返回 ${res.status}`), { code: 'E_HTTP', appId, status: res.status });
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return json;
}

/**
 * Steam 市场订单簿（新市场页用的接口）：
 *   GET /market/orderbook?q=Load&qp=[appId,"market_hash_name"]
 * 返回 data.data：
 *   amtMaxBuyOrder  最高求购价（分）—— 想立刻卖出时能成交的价格
 *   amtMinSellOrder 最低在售价（分）
 *   cBuyOrders / cSellOrders  求购单数 / 在售单数
 *   eCurrency       币种，23 = 人民币
 * 必须在社区页面通道里发：直连会被服务器按 IP 地区返回欧元/美元。
 */
const ORDERBOOK_TTL = 10 * 60 * 1000;
const orderBookCache = new Map();

async function orderBookOne(appId, hashName) {
  const key = `${appId}:${hashName}`;
  const hit = orderBookCache.get(key);
  if (hit && Date.now() - hit.at < ORDERBOOK_TTL) return { ...hit, cached: true };

  const candidates = appCandidatesFor(appId, hashName);
  let lastErr = null;
  for (const cand of candidates) {
    try {
      const qp = encodeURIComponent(JSON.stringify([Number(cand), hashName]));
      const url = `https://steamcommunity.com/market/orderbook?q=Load&qp=${qp}`;
      const res = await bridge.communityFetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw Object.assign(new Error(`订单簿返回 ${res.status}`), { code: 'E_HTTP' });
      const json = await res.json();
      const d = json && json.data && json.data.data;
      if (!d) continue;
      const out = {
        appId: Number(cand),
        marketHashName: hashName,
        currency: Number(d.eCurrency) || 0,
        buy: Number(d.amtMaxBuyOrder) > 0 ? Number(d.amtMaxBuyOrder) / 100 : 0,
        buyCount: Number(d.cBuyOrders) || 0,
        sell: Number(d.amtMinSellOrder) > 0 ? Number(d.amtMinSellOrder) / 100 : 0,
        sellCount: Number(d.cSellOrders) || 0,
        at: Date.now(),
      };
      orderBookCache.set(key, out);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw Object.assign(new Error((lastErr && lastErr.message) || '读取求购价失败'), {
    code: (lastErr && lastErr.code) || 'E_ORDERBOOK',
  });
}

/**
 * Steam 官方市场历史成交数据（价格中位数 + 日成交量）。
 *
 * 接口：/market/pricehistory/?appid=..&market_hash_name=..
 * 必须带社区登录态，返回：
 *   { success:true, prices:[ ["Nov 09 2025 01: +0", 0.49, "123"], ... ],
 *     price_prefix:"¥", price_suffix:"" }
 * 日期是 UTC 的 "MMM DD YYYY HH: +0"，要自己拼成可解析的 ISO 串。
 */
function parseHistoryDate(str) {
  const m = String(str || '').match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):/);
  if (!m) return null;
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const mo = months[m[1]];
  if (mo === undefined) return null;
  return Date.UTC(Number(m[3]), mo, Number(m[2]), Number(m[4]));
}

async function priceHistory(appId, hashName, opts = {}) {
  const candidates = appCandidatesFor(appId, hashName);
  const tried = [];
  let lastError = null;

  for (const cand of candidates) {
    tried.push(cand);
    const url = new URL('https://steamcommunity.com/market/pricehistory/');
    url.searchParams.set('appid', String(cand));
    url.searchParams.set('market_hash_name', hashName);
    url.searchParams.set('currency', '23');
    url.searchParams.set('language', 'schinese');

    let res;
    try {
      res = await bridge.communityFetch(url.toString(), {
        headers: { Accept: 'application/json, text/plain, */*' },
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (res.status === 429) {
      throw Object.assign(new Error('行情历史接口被限流（429），请稍后再试'), { code: 'E_RATE_LIMIT' });
    }
    if (!res.ok) {
      lastError = Object.assign(new Error(`历史行情接口返回 ${res.status}`), { code: 'E_HTTP' });
      continue;
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    // 未登录时 Steam 返回 success:false（或 HTML 登录页），继续试下一个 appid 没意义
    if (!json || json.success !== true || !Array.isArray(json.prices)) {
      lastError = Object.assign(
        new Error(
          'Steam 未返回历史行情。该接口需要已登录的社区会话，请先在「账号管理」网页登录；若已登录仍失败，通常是该物品没有成交记录。'
        ),
        { code: 'E_NO_LOGIN_OR_NO_DATA' }
      );
      continue;
    }

    const points = [];
    for (const row of json.prices) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const ts = parseHistoryDate(row[0]);
      const price = Number(row[1]);
      if (!ts || !Number.isFinite(price) || price <= 0) continue;
      points.push({
        t: ts,
        price: Math.round(price * 100) / 100,
        volume: parseInt(String(row[2] || 0).replace(/[^\d]/g, ''), 10) || 0,
      });
    }
    if (!points.length) {
      lastError = Object.assign(new Error('该物品暂无历史成交记录'), { code: 'E_NO_DATA' });
      continue;
    }
    points.sort((a, b) => a.t - b.t);

    const prices = points.map((p) => p.price);
    const sum = prices.reduce((s, n) => s + n, 0);
    const mid = [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)];
    return {
      appId: cand,
      marketHashName: hashName,
      points,
      currency: json.price_prefix || '¥',
      pricePrefix: json.price_prefix || '¥',
      priceSuffix: json.price_suffix || '',
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round((sum / prices.length) * 100) / 100,
      median: Math.round(mid * 100) / 100,
      latest: prices[prices.length - 1],
      last30Volume: points
        .filter((p) => p.t >= Date.now() - 30 * 86400000)
        .reduce((s, p) => s + p.volume, 0),
      totalPoints: points.length,
      triedAppIds: tried,
      at: Date.now(),
    };
  }

  throw Object.assign(
    new Error((lastError && lastError.message) || '无法获取市场历史行情'),
    { code: (lastError && lastError.code) || 'E_HISTORY', detail: { tried } }
  );
}

async function quoteOne(appId, hashName, opts = {}) {
  const cacheKey = `${appId}:${hashName}`;

  if (!opts.force) {
    const cached = store.getQuote(cacheKey);
    if (cached && !cached.stale && cached.state === 'ok') return { ...cached, cached: true };
  }

  const candidates = appCandidatesFor(appId, hashName);
  const tried = [];
  let lastError = null;

  for (const cand of candidates) {
    if (cancelFlag) break;
    tried.push(cand);
    try {
      const json = await fetchPriceOverview(cand, hashName);

      if (json && json.success === true) {
        const lowest = parsePrice(json.lowest_price);
        const median = parsePrice(json.median_price);
        // success 但没有任何价格字段：视为该 appid 下无此商品，继续试下一个
        if (lowest === null && median === null) continue;

        const result = {
          marketHashName: hashName,
          appId: cand,
          lowest,
          median,
          volume: parseVolume(json.volume),
          lowestText: json.lowest_price || null,
          medianText: json.median_price || null,
          state: 'ok',
          at: Date.now(),
        };
        store.setQuote(cacheKey, result);
        // 每天每个物品留一条快照，长期形成自己的价格序列
        archive.recordQuote(result.appId, hashName, result);
        return result;
      }
    } catch (err) {
      // 限流直接抛，继续试只会撞更多墙
      if (err.code === 'E_RATE_LIMIT') throw err;
      lastError = err;
    }
  }

  const result = {
    marketHashName: hashName,
    appId: candidates[0],
    lowest: null,
    median: null,
    volume: 0,
    state: lastError ? 'error' : 'no-data',
    message: lastError
      ? lastError.message
      : '该物品在市场上没有挂单（或未开通市场）',
    triedAppIds: tried,
    at: Date.now(),
  };
  store.setQuote(cacheKey, result);
  return result;
}

/**
 * 批量查价：串行 + 间隔 + 缓存命中跳过。
 * hashNames 里可以是字符串，也可以是 {hashName, appId}。
 */
async function quoteMany(appId, hashNames) {
  if (running) {
    throw Object.assign(new Error('已有查价任务在进行中，请等它完成'), { code: 'E_BUSY' });
  }
  const settings = store.getSettings();
  const list = (hashNames || []).filter(Boolean);
  if (!list.length) return { results: [], total: 0 };

  running = true;
  cancelFlag = false;
  const results = new Array(list.length);
  let done = 0;
  let ok = 0;
  let fail = 0;

  /**
   * 并发查价（轻量）。
   * 直连 priceoverview 后单次耗时主要在等待网络，串行会把"等待"白白叠加；
   * 这里改成 3 个 worker + 全局最小间隔（默认仍由 quoteIntervalMs 控制），
   * 遇到 429 时全体暂停 20 秒再继续，避免连续撞墙。
   */
  const concurrency = Math.min(4, Math.max(2, Number(settings.quoteConcurrency) || 3));
  const perReqGap = Math.max(350, Math.round((Number(settings.quoteIntervalMs) || 1800) / 3));
  let nextAllowedAt = 0;
  let pausedUntil = 0;
  let idx = 0;

  const gate = async () => {
    for (;;) {
      const now = Date.now();
      const wait = Math.max(nextAllowedAt - now, pausedUntil - now);
      if (wait <= 0) break;
      await sleep(Math.min(wait, 1500));
      if (cancelFlag) return;
    }
    nextAllowedAt = Date.now() + perReqGap;
  };

  emitProgress({ total: list.length, done: 0, ok: 0, fail: 0, state: 'running', message: '开始查价' });

  async function worker() {
    for (;;) {
      if (cancelFlag) return;
      const i = idx++;
      if (i >= list.length) return;

      const entry = list[i];
      const name = typeof entry === 'string' ? entry : entry.hashName;
      const app = typeof entry === 'string' ? appId : entry.appId || appId;
      if (!name) {
        results[i] = null;
        done++;
        continue;
      }

      await gate();
      if (cancelFlag) return;

      let attempt = 0;
      let finished = false;
      while (!finished && attempt < 3) {
        attempt++;
        try {
          const q = await quoteOne(app, name);
          // 顺手取一次订单簿：最高求购价就是"想马上卖掉能拿到多少"的价格。
          // 失败不影响挂单行情，表格里显示 — 就行。
          if (q && q.state !== 'error') {
            await gate();
            if (cancelFlag) return;
            try {
              const ob = await orderBookOne(app, name);
              q.buy = ob.buy;
              q.buyCount = ob.buyCount;
              q.buyCurrency = ob.currency;
            } catch (err) {
              q.buy = null;
              q.buyCurrency = 0;
            }
          }
          results[i] = q;
          if (q.state === 'ok') ok++;
          else fail++;
          finished = true;
        } catch (err) {
          if (err.code === 'E_RATE_LIMIT' && attempt < 3) {
            // 全体退避：这段时间内所有 worker 都不再发请求
            pausedUntil = Date.now() + 20000;
            emitProgress({ message: '触发 Steam 限流，暂停 20 秒后继续…' });
            await sleep(20000);
            continue;
          }
          results[i] = {
            marketHashName: name,
            appId: app,
            lowest: null,
            median: null,
            volume: 0,
            state: err.code === 'E_RATE_LIMIT' ? 'rate-limited' : 'error',
            message: err.message,
            at: Date.now(),
          };
          fail++;
          finished = true;
        }
      }

      done++;
      emitProgress({
        done,
        ok,
        fail,
        state: 'running',
        message: `查价中 ${done}/${list.length}`,
      });
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    store.saveCache();
    const state = cancelFlag ? 'cancelled' : 'done';
    emitProgress({ state, message: cancelFlag ? '已取消' : `完成，成功 ${ok} 件` });
    return {
      results: results.filter(Boolean),
      total: list.length,
      ok,
      fail,
      cancelled: cancelFlag,
    };
  } finally {
    running = false;
    cancelFlag = false;
  }
}

function cancelQuotes() {
  cancelFlag = true;
}

/**
 * Steam 市场手续费（人民币，单位：分）。
 * 实测规则：
 *   Steam 5% + 发行商 10%，两边各自向下取整，且各自最低 ¥0.07。
 *   低价物品几乎全是按最低档收：挂 0.30 的买家实付里，0.14 都是手续费。
 *   例：卖家到手 16 分 → 1 + 7 → 买家付 30 分；到手 85 分 → 7 + 8 → 买家付 100 分。
 */
const FEE_MIN_CENTS = 7;

function feeCentsOfSeller(sellerCents) {
  const s = Math.max(0, Math.floor(Number(sellerCents) || 0));
  const steam = Math.max(FEE_MIN_CENTS, Math.floor(s * 0.05));
  const publish = Math.max(FEE_MIN_CENTS, Math.floor(s * 0.1));
  return steam + publish;
}

/** 卖家到手（分）→ 买家实付（分） */
function grossCentsOf(sellerCents) {
  const s = Math.max(0, Math.floor(Number(sellerCents) || 0));
  if (!s) return 0;
  return s + feeCentsOfSeller(s);
}

/**
 * 买家实付（分）→ 卖家到手（分）。
 * 手续费按到手金额算，不能直接减，用二分找"不超过实付"的最大到手额。
 */
function sellerCentsFor(grossCents) {
  const g = Math.max(0, Math.floor(Number(grossCents) || 0));
  if (!g) return 0;
  let lo = 0;
  let hi = g;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (grossCentsOf(mid) <= g) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 给定买家实付价（元），算出卖家到手（元） */
function netOf(priceYuan) {
  if (!Number.isFinite(priceYuan) || priceYuan <= 0) return 0;
  return sellerCentsFor(Math.round(priceYuan * 100)) / 100;
}

/** 反算：希望到手 netYuan，买家应实付多少 */
function grossFor(netYuan) {
  if (!Number.isFinite(netYuan) || netYuan <= 0) return 0;
  return grossCentsOf(Math.round(netYuan * 100)) / 100;
}

module.exports = {
  quoteOne,
  quoteMany,
  orderBookOne,
  priceHistory,
  parseHistoryDate,
  queueStats,
  cancelQuotes,
  netOf,
  grossFor,
  feeCentsOfSeller,
  sellerCentsFor,
  marketAppIdOf,
  appCandidatesFor,
  parsePrice,
  parseVolume,
  on: emitter.on.bind(emitter),
};
