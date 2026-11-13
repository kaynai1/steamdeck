'use strict';

/**
 * Steam 市场成交历史（这个账号本人的记录）
 *
 * 用的是网页端「我的市场历史」在用的接口：
 *   GET https://steamcommunity.com/market/myhistory/render/?query=&start=&count=&norender=1
 * 它认 persist:steam 里的登录 Cookie，和软件是否卖出无关——
 * 只要这个号在 Steam 市场上买过/卖过，这里都能读到，包含用手机、网页、其它工具卖出的。
 *
 * 返回 JSON 里 events 是时间线，purchases/listings/assets 是关联数据：
 *   event_type 3 = 我卖出，4 = 我买入
 *   purchases["<listingid>_<purchaseid>"] 给出买家、到手金额
 *   listings[listingid] 给出挂单价和币种
 *   assets[appid][contextid][assetid] 给出物品名和图标 hash
 */

const session = require('./session');
const imageProxy = require('./imageProxy');
const archive = require('./archive');

// 接口接受大页，尽量少发请求：Steam 对这个地址限流很紧
const PAGE_SIZE = 500;
const MAX_PAGES = 12;
const CACHE_TTL = 5 * 60 * 1000;

let cache = null; // { at, steamId, total, truncated, items }

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Steam 市场内部币种 id 是 2000 + 钱包币种 id。
 * 只列常见币种，没收录的就用「数字 + 币种 id」显示，不猜。
 */
const CURRENCY = {
  1: '$',
  2: '£',
  3: '€',
  4: 'CHF ',
  5: '₽',
  6: 'zł ',
  7: 'R$ ',
  8: '¥',
  9: 'kr ',
  10: 'Rp ',
  11: 'RM ',
  12: '₱ ',
  13: 'S$ ',
  14: '฿ ',
  15: '₫ ',
  16: '₩ ',
  17: '₺ ',
  18: '₴ ',
  19: 'MX$ ',
  20: 'C$ ',
  21: 'A$ ',
  22: 'NZ$ ',
  23: '¥',
  24: '₹ ',
  25: 'CLP$ ',
  26: 'S/ ',
  27: 'COL$ ',
  28: 'R ',
  29: 'HK$ ',
  30: 'NT$ ',
  31: 'SR ',
  32: 'AED ',
  33: 'ARS$ ',
  34: '₪',
  35: 'Br ',
  36: '₸ ',
  37: 'KD ',
  38: 'QR ',
  39: '₡',
  40: '$U ',
};

function moneyText(cents, currencyId) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return '';
  const id = Number(currencyId) % 2000;
  const sym = CURRENCY[id];
  const num = (n / 100).toFixed(2);
  return sym ? `${sym}${num}` : `${num} (${Number(currencyId)})`;
}

/** 从 steamLoginSecure 里取 SteamID64，用来在界面标明这是哪个账号 */
function steamIdOf(cookies) {
  const raw = (cookies && cookies.steamLoginSecure) || '';
  try {
    return decodeURIComponent(String(raw)).split('||')[0] || '';
  } catch {
    return '';
  }
}

/** 把一页 JSON 展开成统一的行 */
function joinPage(j) {
  const out = [];
  const assets = j.assets || {};
  const purchases = j.purchases || {};
  const listings = j.listings || {};
  for (const e of j.events || []) {
    if (!e || !e.listingid) continue;
    const pk = `${e.listingid}_${e.purchaseid}`;
    const p = purchases[pk] || null;
    const l = listings[e.listingid] || null;
    // assets 里存的是「挂单时的资产 id」，买单/卖单都一样；
    // purchases.asset 是成交后的新资产 id，查不到名字，只能作兜底。
    const a = (l && l.asset) || (p && p.asset) || null;
    const appid = a && Number(a.appid);
    const ctx = (a && String(a.contextid || '2')) || '2';
    const aid = a && a.id;
    const info = appid && assets[appid] && assets[appid][ctx] && assets[appid][ctx][aid];

    const kind = e.event_type === 3 ? 'sell' : e.event_type === 4 ? 'buy' : 'other';
    const priceCents = l ? Number(l.original_price) || 0 : 0;
    const currency = l ? Number(l.currencyid) || 0 : 0;
    const receivedCents = p ? Number(p.received_amount) || 0 : 0;
    const receivedCurrency = p ? Number(p.received_currencyid) || 0 : 0;

    out.push({
      id: pk,
      time: Number(e.time_event) || 0,
      dateText: e.date_event || '',
      kind,
      appid: appid || 0,
      name: (info && (info.name || info.market_name)) || '未知物品',
      marketHashName: (info && info.market_hash_name) || '',
      icon: info && info.icon_url ? imageProxy.ecoUrl(info.icon_url) : '',
      priceCents,
      priceText: moneyText(priceCents, currency),
      currency,
      // 卖出时额外给出实际到手的钱（Steam 会把手续费算在里面）
      receivedCents,
      receivedCurrency,
      receivedText: kind === 'sell' ? moneyText(receivedCents, receivedCurrency) : '',
      actor: e.steamid_actor || '',
      failed: !!(p && p.failed),
    });
  }
  return out;
}

/**
 * 读取这个登录账号的全部成交历史。
 * @param {{force?: boolean}} [opts]
 */
async function myHistory(opts = {}) {
  const cookies = await session.readStoreCookies();
  if (!cookies.steamLoginSecure) {
    throw err('E_STEAM_LOGIN', '还没有登录 Steam 网页会话，先在账号管理里「网页登录取 Cookie」');
  }
  const steamId = steamIdOf(cookies);
  // pages 用于"只看最新几条"的场景（自动补货 / 日报），不能污染完整历史缓存
  const short = !!opts.pages;
  const maxPages = short ? Math.max(1, Math.min(MAX_PAGES, Number(opts.pages) || 1)) : MAX_PAGES;
  if (!short && !opts.force && cache && cache.at && Date.now() - cache.at < CACHE_TTL && cache.steamId === steamId) {
    return cache;
  }

  const items = [];
  let total = 0;
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const u = new URL('https://steamcommunity.com/market/myhistory/render/');
    u.searchParams.set('query', '');
    u.searchParams.set('start', String(start));
    u.searchParams.set('count', String(PAGE_SIZE));
    u.searchParams.set('norender', '1');
    u.searchParams.set('cc', 'CN');
    u.searchParams.set('l', 'schinese');

    const res = await session.authFetch(u.toString(), {
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (res.status === 401 || res.status === 403) {
      throw err('E_STEAM_LOGIN', 'Steam 登录已过期，请重新登录后再看成交历史');
    }
    if (res.status === 429) {
      throw err('E_STEAM_LIMIT', 'Steam 暂时限流了，过几分钟再打开就能读到');
    }
    if (!res.ok) throw err('E_STEAM_HTTP', `Steam 返回 HTTP ${res.status}`);

    let j = null;
    try {
      j = await res.json();
    } catch {
      throw err('E_STEAM_PARSE', 'Steam 返回的不是 JSON（可能被要求重新登录）');
    }
    if (!j || j.success !== true) {
      throw err('E_STEAM_LOGIN', 'Steam 没有返回成交数据，请确认网页登录仍然有效');
    }

    total = Number(j.total_count) || total;
    const rows = joinPage(j);
    items.push(...rows);
    if (!rows.length) break;
    start += PAGE_SIZE;
    if (start >= total) break;
    // Steam 对这个接口限流很敏感，翻页之间留一点间隔
    await new Promise((r) => setTimeout(r, 700));
  }

  // 翻页边界可能重复，按交易 id 去重，再按时间倒序
  const seen = new Set();
  const list = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    list.push(it);
  }
  list.sort((a, b) => b.time - a.time);

  const result = {
    at: Date.now(),
    steamId,
    total,
    truncated: total > list.length,
    items: list,
  };
  if (!short) cache = result;
  // 顺手并入本地归档：Steam 只给有限页，归档后才有完整历史
  try {
    archive.ingestTrades(steamId, list);
  } catch {
    /* 归档失败不影响本次读取 */
  }
  // 顺手把买入记录回填成本库（只补缺失项，不动手工填过的）
  try {
    require('./costs').ingestBuys(steamId, list);
  } catch {
    /* 成本回填失败不影响本次读取 */
  }
  return result;
}

/** 只取最新的几十条成交（自动补货与日报用），不写完整历史缓存 */
function recentHistory() {
  return myHistory({ pages: 1, force: true });
}

function clearCache() {
  cache = null;
}

module.exports = { myHistory, recentHistory, clearCache };
