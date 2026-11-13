'use strict';

/**
 * 每日促销：Steam 今日特惠 + GOG 折扣榜
 *
 * 数据源都是公开页面接口，不需要登录、不需要 API Key：
 *   - Steam: store.steampowered.com/api/featuredcategories（首页特惠位 + specials）
 *   - GOG:   catalog.gog.com/v1/catalog?price=discounted（按热度取折扣商品）
 *
 * 结果缓存 20 分钟；区服跟随「设置 → 查价与挂机 → 商店价格区服」。
 * 只做展示与跳转，不代购；Steam 的条目可以一键加成价格提醒。
 */

const store = require('./store');
const logger = require('./logger');
const itad = require('./itad');

const TTL = 20 * 60 * 1000;
const LOW_TTL = 12 * 60 * 60 * 1000;
const CHEAPSHARK_UA = `SteamDesk/${require('../package.json').version} (desktop app)`;

const REGIONS = {
  CN: { cc: 'CN', lang: 'schinese', gog: ['CN', 'CNY', 'zh-Hans'] },
  HK: { cc: 'HK', lang: 'english', gog: ['HK', 'HKD', 'en-US'] },
  TW: { cc: 'TW', lang: 'tchinese', gog: ['TW', 'TWD', 'zh-Hant'] },
  US: { cc: 'US', lang: 'english', gog: ['US', 'USD', 'en-US'] },
  JP: { cc: 'JP', lang: 'japanese', gog: ['JP', 'JPY', 'ja-JP'] },
};

const cache = new Map(); // region -> { at, data }

function region() {
  const r = String(store.getSettings().storeRegion || 'CN').toUpperCase();
  return REGIONS[r] ? r : 'CN';
}

function money(cents, currency) {
  const n = Number(cents) || 0;
  const cur = String(currency || 'CNY');
  if (cur === 'JPY') return `¥${Math.round(n).toLocaleString('zh-CN')}`;
  const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : cur === 'HKD' ? 'HK$' : cur === 'TWD' ? 'NT$' : '';
  return `${sym}${(n / 100).toFixed(2)}`;
}

function endsText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return `至 ${d.getMonth() + 1}月${d.getDate()}日`;
}

async function getJson(url, headers) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...(headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function steamDeals(cfg) {
  const j = await getJson(
    `https://store.steampowered.com/api/featuredcategories?cc=${cfg.cc}&l=${cfg.lang}`
  );
  const raw = [];
  // 首页大图位（0~4）+ 每日特惠
  for (const k of ['0', '1', '2', '3', '4']) {
    if (j[k] && Array.isArray(j[k].items)) raw.push(...j[k].items);
  }
  if (j.specials && Array.isArray(j.specials.items)) raw.push(...j.specials.items);

  const seen = new Set();
  const out = [];
  for (const it of raw) {
    const id = Number(it && it.id);
    if (!id || seen.has(id)) continue;
    if (!it.discounted || !(Number(it.discount_percent) > 0)) continue;
    seen.add(id);
    out.push({
      source: 'steam',
      appId: id,
      name: it.name || `App ${id}`,
      image: it.header_image || it.large_capsule_image || '',
      finalText: money(Number(it.final_price) || 0, it.currency),
      originalText: money(Number(it.original_price) || 0, it.currency),
      finalCents: Number(it.final_price) || 0,
      discount: Number(it.discount_percent) || 0,
      currency: it.currency || 'CNY',
      endsAt: Number(it.discount_expiration) ? Number(it.discount_expiration) * 1000 : 0,
      url: `https://store.steampowered.com/app/${id}/`,
    });
  }
  return out.sort((a, b) => b.discount - a.discount);
}

async function gogDeals(cfg) {
  const [country, currency, locale] = cfg.gog;
  const j = await getJson(
    `https://catalog.gog.com/v1/catalog?limit=60&order=desc:trending&price=discounted&countryCode=${country}&locale=${locale}&currencyCode=${currency}`
  );
  const items = Array.isArray(j && j.products) ? j.products : [];
  const out = [];
  for (const p of items) {
    const pr = p && p.price;
    if (!pr) continue;
    // DLC / 捆绑包不放进「游戏促销」，价格口径不一样
    if (p.productType && p.productType !== 'game') continue;
    const pct = Math.abs(parseInt(String(pr.discount || '').replace(/[^\d-]/g, ''), 10) || 0);
    const final = Number(pr.finalMoney && pr.finalMoney.amount);
    if (!(pct > 0) || !(final > 0)) continue;
    const link = String(p.storeLink || '');
    out.push({
      source: 'gog',
      appId: null,
      name: p.title || 'GOG 游戏',
      image: p.coverHorizontal || p.coverVertical || '',
      finalText: pr.final || `${final} ${currency}`,
      originalText: pr.base || '',
      finalCents: Math.round(final * 100),
      discount: pct,
      currency,
      endsAt: 0,
      url: /^https?:/i.test(link) ? link : `https://www.gog.com${link || `/game/${p.slug || ''}`}`,
    });
  }
  return out.sort((a, b) => b.discount - a.discount);
}

/**
 * Epic / Humble / Fanatical：通过 CheapShark 的公开聚合接口取折扣。
 * Epic 自己的 GraphQL 被 Cloudflare 拦（Node 和 Electron 都是 403），
 * CheapShark 的报价是美元，卡片上会标明。
 */
async function cheapSharkDeals() {
  const stores = [
    ['25', 'epic', 24],
    ['11', 'humble', 10],
    ['15', 'fanatical', 10],
  ];
  // CheapShark 不区分本体和 DLC/升级包，按标题把明显不是游戏本体的条目挡掉
  const NON_GAME = /(^|[\s:(])(upgrade|dlc|season pass|soundtrack|expansion|add-?on|beta)([\s:)]|$)/i;
  const out = [];
  const errors = [];
  for (const [storeId, source, size] of stores) {
    try {
      const j = await getJson(
        `https://www.cheapshark.com/api/1.0/deals?storeID=${storeId}&pageSize=${size}&sortBy=Deal%20Rating`,
        { 'User-Agent': CHEAPSHARK_UA }
      );
      for (const d of Array.isArray(j) ? j : []) {
        const sale = Number(d.salePrice);
        const normal = Number(d.normalPrice);
        const save = Math.round(Number(d.savings) || 0);
        if (!(sale >= 0) || !(normal > 0) || save < 10) continue;
        if (NON_GAME.test(String(d.title || ''))) continue;
        out.push({
          source,
          appId: null,
          name: d.title || '游戏',
          image: d.thumb || '',
          finalText: `$${sale.toFixed(2)}`,
          originalText: `$${normal.toFixed(2)}`,
          finalCents: Math.round(sale * 100),
          discount: Math.min(99, save),
          currency: 'USD',
          endsAt: 0,
          url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealID || '')}`,
        });
      }
    } catch (e) {
      errors.push(`${source}：${(e && e.message) || '读取失败'}`);
      logger.warn('CheapShark 促销读取失败', { source, message: e && e.message });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { items: out, errors };
}

/** 可选：配了 ITAD Key 时，给 Steam 促销标「史低」——每个游戏两次请求，缓存 12 小时 */
const lowCache = new Map();

function markHistoryLow(d, low) {
  if (!low || !(Number(low.amount) > 0)) return;
  if (low.currency && d.currency && low.currency !== d.currency) return;
  d.histLowText = low.text || `¥${Number(low.amount).toFixed(2)}`;
  d.histLowAmount = Number(low.amount);
  d.isHistLow = d.finalCents / 100 <= Number(low.amount) + 0.005;
}

async function addHistoryLow(steam) {
  if (!itad.status().configured) return;
  for (const d of steam.slice(0, 15)) {
    const hit = lowCache.get(d.appId);
    if (hit && Date.now() - hit.at < LOW_TTL) {
      if (hit.low) markHistoryLow(d, hit.low);
      continue;
    }
    try {
      const r = await itad.historyLow(d.appId);
      const low = r && r.found && r.low ? r.low : null;
      lowCache.set(d.appId, { at: Date.now(), low });
      if (low) markHistoryLow(d, low);
    } catch {
      /* 单个游戏查不到史低就跳过 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function all(opts = {}) {
  const reg = region();
  const hit = cache.get(reg);
  if (!opts.force && hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };

  const cfg = REGIONS[reg];
  const errors = [];
  let steam = [];
  let gog = [];
  let other = [];
  try {
    steam = await steamDeals(cfg);
  } catch (e) {
    errors.push(`Steam：${(e && e.message) || '读取失败'}`);
    logger.warn('Steam 每日特惠读取失败', { message: e && e.message });
  }
  try {
    gog = await gogDeals(cfg);
  } catch (e) {
    errors.push(`GOG：${(e && e.message) || '读取失败'}`);
    logger.warn('GOG 折扣读取失败', { message: e && e.message });
  }
  try {
    const cheap = await cheapSharkDeals();
    other = cheap.items;
    errors.push(...cheap.errors);
  } catch (e) {
    errors.push(`其他平台：${(e && e.message) || '读取失败'}`);
  }

  await addHistoryLow(steam).catch(() => {});

  const data = {
    at: Date.now(),
    region: reg,
    steam,
    gog,
    other,
    total: steam.length + gog.length + other.length,
    itadOn: itad.status().configured,
    errors,
  };
  // 全部来源都失败时不缓存，方便用户点刷新重试
  if (steam.length || gog.length || other.length) cache.set(reg, { at: Date.now(), data });
  return data;
}

function clearCache() {
  cache.clear();
}

module.exports = { all, clearCache };
