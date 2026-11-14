'use strict';

/**
 * 最新热门游戏（每天自动拉取，替代旧版硬编码清单）
 *
 * ★ 为什么需要 ★
 * 旧版「最新热门挂机掉落游戏」是硬编码的 8 款游戏（Banana / Cats / Egg …），
 * 时间一长全是过时热点。这里改用 Steam 官方商店接口拉真实热点：
 *   1. featuredcategories —— 官方热销榜（top_sellers）+ 新品榜（new_releases），免 Key
 *   2. appdetails —— 过滤出游戏本体（排除 DLC / 工具），取中文名 / 发售日 / 价格
 *   3. CCU 在线人数 —— 可选展示，失败不阻塞
 * 结果缓存 12 小时写进 settings；拉取失败回落旧缓存，再不行回落内置清单，
 * 保证「最新热门」永远有内容。已知挂机游戏（CS2 / Banana 等）若上榜，
 * 会自动带上它们的掉落估算信息。
 */

const store = require('./store');
const logger = require('./logger');
const dict = require('./gameZhDict');
const storeSearch = require('./storeSearch');

const CHARTS_URL = 'https://store.steampowered.com/api/featuredcategories?cc=cn&l=schinese';
const CACHE_MS = 12 * 3600 * 1000;
const TAKE_SELLERS = 12;
const TAKE_NEW = 12;
const KEEP = 14;

let inflight = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cached() {
  const c = store.getSettings().hotIdleCache;
  return c && Array.isArray(c.games) && c.games.length ? c : null;
}

/** 同步读缓存：idleMarket.games() 用来决定要查哪些游戏的市场行情 */
function cachedGames() {
  const c = cached();
  return c ? c.games : null;
}

function fmtCcu(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)} 千`;
  return String(v);
}

async function fetchRetry(url, timeoutMs, retries = 1) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(600);
    }
  }
  throw lastErr || new Error('请求失败');
}

async function fetchFeatured() {
  const res = await fetchRetry(CHARTS_URL, 15000, 2);
  const j = await res.json();
  const sellers = ((j.top_sellers && j.top_sellers.items) || [])
    .slice(0, TAKE_SELLERS)
    .map((x, i) => ({ appId: Number(x.id), tag: 'hot', order: i }));
  const news = ((j.new_releases && j.new_releases.items) || [])
    .slice(0, TAKE_NEW)
    .map((x, i) => ({ appId: Number(x.id), tag: 'new', order: i }));
  return { sellers, news };
}

async function appDetail(appId) {
  const res = await fetchRetry(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=cn&l=schinese&filters=basic,price_overview,release_date`,
    12000,
    1
  );
  const j = await res.json();
  const d = j[String(appId)];
  if (!d || !d.success || !d.data) throw new Error('商店无数据');
  return d.data;
}

async function ccuOf(appId) {
  const res = await fetchRetry(
    `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
    9000,
    1
  );
  const j = await res.json();
  const n = j && j.response && Number(j.response.player_count);
  return Number.isFinite(n) ? n : null;
}

async function build() {
  const { sellers, news } = await fetchFeatured();
  const seen = new Map();
  for (const c of [...sellers, ...news]) {
    if (c.appId > 0 && !seen.has(c.appId)) seen.set(c.appId, c);
  }
  const registry = new Map(storeSearch.getIdleDropGames().map((g) => [Number(g.appId), g]));

  const games = [];
  for (const c of seen.values()) {
    if (games.length >= KEEP) break;
    try {
      const d = await appDetail(c.appId);
      if (d.type !== 'game') continue; // 只要游戏本体，排除 DLC / 工具 / 预告
      const en = d.name || '';
      const zhDict = dict.zhByApp(c.appId);
      const name = zhDict || en;
      const reg = registry.get(c.appId);
      const tag = c.tag === 'new' ? '新上架' : '热销';
      games.push({
        appId: c.appId,
        name,
        en,
        zhName: zhDict || (/[\u4e00-\u9fa5]/.test(en) ? en : ''),
        category: reg && reg.category ? reg.category : d.is_free ? '免费热门' : tag,
        statusTag: 'hot',
        status: '',
        releaseDate: (d.release_date && d.release_date.date) || '',
        dropInterval: reg && reg.dropInterval ? reg.dropInterval : '',
        dropsPerDay: reg ? Number(reg.dropsPerDay) || 0 : 0,
        hasMarket: true,
        avgPrice: d.is_free ? '免费' : d.price_overview ? d.price_overview.final_formatted : '—',
        desc:
          (reg && reg.desc) ||
          (c.tag === 'new'
            ? 'Steam 新品榜上榜游戏，社区市场活跃。'
            : 'Steam 热销榜上榜游戏，社区市场活跃。'),
        tips: (reg && reg.tips) || '点「市场」看当前可交易的掉落物品与低价。',
        tag: c.tag,
        order: c.order,
      });
    } catch (e) {
      // 单个游戏失败直接跳过，不影响整批
    }
    await sleep(200);
  }
  if (!games.length) throw new Error('商店热点解析为空');

  // 在线人数并发补齐（api.steampowered.com 间歇抽风，失败就不显示在线数）
  const ccuResults = await Promise.allSettled(games.map((g) => ccuOf(g.appId)));
  games.forEach((g, i) => {
    const v = ccuResults[i];
    const ccu = v.status === 'fulfilled' ? v.value : null;
    g.ccu = ccu;
    g.status = ccu ? `在线 ${fmtCcu(ccu)} 人` : '';
  });

  // 热销在前、新品在后；同榜内按官方顺序
  games.sort((a, b) => (a.tag === 'hot' ? 0 : 1) - (b.tag === 'hot' ? 0 : 1) || (a.order || 0) - (b.order || 0));

  const out = { at: Date.now(), games, source: 'featuredcategories' };
  try {
    store.setSettings({ hotIdleCache: out });
  } catch { /* 写盘失败只影响下次 */ }
  return out;
}

async function getHotIdleGames(force) {
  const c = cached();
  if (!force && c && Date.now() - c.at < CACHE_MS) return c;
  if (inflight) return inflight;
  inflight = build()
    .catch((e) => {
      logger.warn('热门榜拉取失败', { message: e && e.message });
      if (c) return c; // 旧缓存兜底
      // 内置清单兜底：页面永远有内容
      return { at: 0, games: storeSearch.getIdleDropGames(), source: 'fallback' };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

module.exports = { getHotIdleGames, cachedGames };
