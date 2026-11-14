'use strict';

/**
 * 免费游戏聚合（Steam / Epic / GOG）
 *
 * 数据来源与它们的边界：
 *   1) Epic 官方促销接口（免费、无需登录、支持 zh-CN）
 *      能精确拿到中文名、原价、结束时间，以及"下周预告"。
 *   2) GamerPower 聚合接口（免费、无需 key）
 *      Steam 的限时免费/密钥发放、GOG 的赠送都靠它；
 *      Steam 商店自己没有"正在赠送"的公开接口，只能这样取。
 *      GOG 用它的公开搜索接口拿不到赠送活动，所以也走 GamerPower。
 *
 * 这里只负责"发现 + 链接"，不做代领：
 * 代领需要各平台登录态和结账接口，属于另一套东西，也更容易踩到平台规则。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TTL = 15 * 60 * 1000;
const CACHE_MS = TTL;

let cache = null; // { at, items, errors }
let inflight = null;

function errText(err) {
  return (err && err.message) || String(err);
}

async function getJson(url, timeout = 12000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'E_HTTP' });
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('返回内容不是 JSON'), { code: 'E_PARSE' });
  }
}

/** GamerPower 偶尔会抽风或限流，失败重试一次再放弃 */
async function getJsonRetry(url, timeout = 15000, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await getJson(url, timeout);
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 900));
    }
  }
  throw last;
}

/* ---------------------------------- Epic --------------------------------- */

function epicOffers(el) {
  const p = el && el.promotions;
  if (!p) return [];
  const out = [];
  const groups = [
    ['current', p.promotionalOffers],
    ['upcoming', p.upcomingPromotionalOffers],
  ];
  for (const [kind, list] of groups) {
    if (!Array.isArray(list)) continue;
    for (const group of list) {
      const offers = (group && group.promotionalOffers) || [];
      for (const o of offers) {
        // discountPercentage === 0 才是"免费送"，打折促销也会出现在这里
        const pct = o && o.discountSetting && Number(o.discountSetting.discountPercentage);
        if (pct !== 0) continue;
        out.push({ kind, startAt: Date.parse(o.startDate) || 0, endAt: Date.parse(o.endDate) || 0 });
      }
    }
  }
  return out;
}

function epicUrl(el) {
  const map = el.catalogNs && Array.isArray(el.catalogNs.mappings) ? el.catalogNs.mappings[0] : null;
  const slug = (map && (map.pageSlug || map.productSlug)) || el.productSlug || el.urlSlug || '';
  return slug
    ? `https://store.epicgames.com/zh-CN/p/${slug}`
    : 'https://store.epicgames.com/zh-CN/free-games';
}

function epicImage(el) {
  const imgs = Array.isArray(el.keyImages) ? el.keyImages : [];
  const pick = (t) => imgs.find((i) => i && i.type === t && i.url);
  const hit =
    pick('OfferImageTall') ||
    pick('Thumbnail') ||
    pick('OfferImageWide') ||
    pick('DieselStoreFrontWide') ||
    imgs.find((i) => i && i.url);
  return hit ? hit.url : '';
}

function epicWorth(el) {
  const p = el && el.price && el.price.totalPrice;
  if (!p) return '';
  const fmt = p.fmtPrice || {};
  // 原价（赠送前）才是用户关心的"值多少钱"
  return fmt.originalPrice && fmt.originalPrice !== '0' ? fmt.originalPrice : '';
}

function parseEpic(json) {
  const els =
    (json && json.data && json.data.Catalog && json.data.Catalog.searchStore &&
      json.data.Catalog.searchStore.elements) ||
    [];
  const now = Date.now();
  const items = [];
  for (const el of els) {
    const offers = epicOffers(el);
    if (!offers.length) continue;
    // 当前在送优先；否则取最近一场预告
    const cur = offers.filter((o) => o.startAt <= now && now < o.endAt).sort((a, b) => a.endAt - b.endAt)[0];
    const next = offers.filter((o) => o.startAt > now).sort((a, b) => a.startAt - b.startAt)[0];
    const o = cur || next;
    if (!o) continue;
    items.push({
      id: 'epic-' + (el.id || el.productSlug || el.title),
      // 一键领取要用：Epic 的 offerId 就是这里的 id，namespace 单独给
      offerId: el.id || '',
      namespace: el.namespace || '',
      platform: 'epic',
      title: String(el.title || '').trim(),
      worth: epicWorth(el),
      image: epicImage(el),
      url: epicUrl(el),
      desc: String(el.description || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      endAt: o.endAt || null,
      startAt: o.startAt || null,
      upcoming: !cur,
      source: 'epic',
    });
  }
  return items;
}

/* ------------------------------- GamerPower ------------------------------- */

function gpTime(s) {
  if (!s || s === 'N/A') return null;
  // 接口给的是 UTC 时间，形如 "2026-11-12 23:59:00"
  const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

function cleanHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGamerPower(list, platform) {
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  const out = [];
  for (const x of list) {
    if (!x || !x.title) continue;
    if (x.status && x.status !== 'Active') continue;
    const endAt = gpTime(x.end_date);
    if (endAt && endAt <= now) continue;
    // 平台字段是 "PC, Steam" 这种，必须真包含才算
    const tags = String(x.platforms || '').toLowerCase();
    const label = { steam: 'steam', epic: 'epic', gog: 'gog' }[platform];
    if (label && !tags.includes(label)) continue;
    out.push({
      id: `gp-${platform}-${x.id}`,
      platform,
      title: cleanHtml(x.title),
      worth: x.worth && x.worth !== 'N/A' ? String(x.worth) : '',
      image: x.image || x.thumbnail || '',
      url: x.open_giveaway_url || x.gamerpower_url || '',
      desc: cleanHtml(x.description).slice(0, 180),
      type: String(x.type || ''),
      endAt,
      startAt: null,
      upcoming: false,
      source: 'gamerpower',
    });
  }
  return out;
}

/* --------------------------------- 汇总 ---------------------------------- */

const PLATFORM_ORDER = { epic: 0, steam: 1, gog: 2 };

function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\((steam|epic games|gog)[^)]*\)/g, '')
    .replace(/[^a-z0-9一-龥]+/g, '');
}

function mergeItems(groups) {
  const seen = new Map();
  for (const group of groups) {
    for (const it of group) {
      if (!it || !it.title) continue;
      const key = it.platform + '::' + normTitle(it.title);
      const prev = seen.get(key);
      // 同一个活动 Epic 官方数据更全，保留 source=epic 的那条
      if (!prev) {
        seen.set(key, it);
        continue;
      }
      if (prev.source !== 'epic' && it.source === 'epic') seen.set(key, it);
    }
  }
  const items = [...seen.values()];
  items.sort((a, b) => {
    // 领取中排前面，其次按截止时间（没截止的垫底）
    if (a.upcoming !== b.upcoming) return a.upcoming ? 1 : -1;
    if (a.endAt && b.endAt) return a.endAt - b.endAt;
    if (a.endAt) return -1;
    if (b.endAt) return 1;
    return String(a.title).localeCompare(String(b.title));
  });
  return items;
}

async function fetchAll() {
  const errors = [];
  const jobs = [
    getJson(
      'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN',
      15000
    )
      .then((j) => parseEpic(j))
      .catch((err) => {
        errors.push({ platform: 'epic', message: errText(err) });
        return [];
      }),
    getJsonRetry('https://www.gamerpower.com/api/giveaways?platform=steam', 15000)
      .then((j) => parseGamerPower(j, 'steam'))
      .catch((err) => {
        errors.push({ platform: 'steam', message: errText(err) });
        return [];
      }),
    getJsonRetry('https://www.gamerpower.com/api/giveaways?platform=gog', 15000)
      .then((j) => parseGamerPower(j, 'gog'))
      .catch((err) => {
        errors.push({ platform: 'gog', message: errText(err) });
        return [];
      }),
    // Ubisoft 限免活动（GamerPower ubisoft 源）：平时返回 201/空数组，有活动时自动出现
    getJsonRetry('https://www.gamerpower.com/api/giveaways?platform=ubisoft', 15000)
      .then((j) => parseGamerPower(j, 'ubisoft'))
      .catch(() => {
        /* Ubisoft 平时无活动（接口返回 201 status=0），不算错误，静默跳过 */
        return [];
      }),
    // EA（origin）限免活动：同样平时无活动，有活动时自动出现
    getJsonRetry('https://www.gamerpower.com/api/giveaways?platform=origin', 15000)
      .then((j) => parseGamerPower(j, 'origin'))
      .catch(() => {
        return [];
      }),
    // 暴雪战网（battlenet）限免活动
    getJsonRetry('https://www.gamerpower.com/api/giveaways?platform=battlenet', 15000)
      .then((j) => parseGamerPower(j, 'battlenet'))
      .catch(() => {
        return [];
      }),
  ];
  const groups = await Promise.all(jobs);
  const items = mergeItems(groups);
  return { at: Date.now(), items, errors };
}

/** 列免费游戏；force=true 时忽略缓存 */
async function list(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = fetchAll()
    .then((r) => {
      cache = r;
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

module.exports = {
  list,
  // 测试用
  _parseEpic: parseEpic,
  _parseGamerPower: parseGamerPower,
  _mergeItems: mergeItems,
  _normTitle: normTitle,
  _ttl: TTL,
  _platformOrder: PLATFORM_ORDER,
};
