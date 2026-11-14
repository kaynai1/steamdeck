'use strict';

/**
 * 挂机掉落游戏的真实行情
 *
 * 以前这一栏是一份写死的文案（「¥0.03 ~ ¥1,000+」），对判断值不值得挂没有用。
 * 这里改成查 Steam 社区市场的实时数据：
 *   - 该游戏在市场上的最低在售价（按价格升序取前 10 条）
 *   - 市场可搜到的条数、最低价物品名
 *   - 最低价物品的 24 小时成交量（走已有的 priceoverview，有 10 分钟缓存）
 *
 * 数据只读公开页面，不需要登录；每个游戏 1~2 个请求，缓存 10 分钟，
 * 避免刷新时把 Steam 市场接口打满。
 */

const store = require('./store');
const logger = require('./logger');
const session = require('./session');
const { getIdleDropGames } = require('./storeSearch');
const hotIdle = require('./hotIdle');

const TTL = 10 * 60 * 1000;
const GAP_MS = 600;
const cache = new Map(); // appId -> { at, data }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function watched() {
  const list = store.getSettings().idleWatchApps;
  return Array.isArray(list) ? list : [];
}

/** 内置/热门清单 + 用户自己加的游戏，按 appId 去重 */
function games() {
  const map = new Map();
  // 优先用每日自动拉取的热门榜（featuredcategories 热销/新品榜），
  // 还没拉到过时回落内置清单
  const hot = hotIdle.cachedGames();
  const source = Array.isArray(hot) && hot.length ? hot : getIdleDropGames();
  for (const g of source) {
    const appId = Number(g.appId);
    if (appId) map.set(appId, { appId, name: g.name, builtin: true });
  }
  for (const w of watched()) {
    const appId = Number(w && w.appId ? w.appId : w);
    if (!appId) continue;
    map.set(appId, { appId, name: (w && w.name) || `App ${appId}`, builtin: false });
  }
  return [...map.values()];
}

async function searchCheapest(appId) {
  const u = new URL('https://steamcommunity.com/market/search/render/');
  u.searchParams.set('query', '');
  u.searchParams.set('start', '0');
  u.searchParams.set('count', '10');
  u.searchParams.set('search_descriptions', '0');
  u.searchParams.set('sort_column', 'price');
  u.searchParams.set('sort_dir', 'asc');
  u.searchParams.set('appid', String(appId));
  u.searchParams.set('norender', '1');

  // 必须走 Electron 的会话请求：它跟着系统代理走（国内直连社区接口经常超时），
  // 也自带 persist:steam 的 Cookie；退出登录的用户同样能读公开市场。
  let res;
  try {
    res = await session.authFetch(u.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    throw Object.assign(new Error(`连接 Steam 社区失败：${(e && e.message) || 'timeout'}`), {
      code: 'E_NET',
    });
  }
  if (res.status === 429) throw Object.assign(new Error('Steam 市场限流了，过几分钟再刷新'), { code: 'E_RATE_LIMIT' });
  if (!res.ok) throw new Error(`Steam 市场返回 HTTP ${res.status}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Steam 市场返回的不是 JSON（可能被要求登录）');
  }
  if (!json || json.success !== true) throw new Error('Steam 市场没有返回结果');
  const results = Array.isArray(json.results) ? json.results : [];
  return {
    total: Number(json.total_count) || results.length,
    results,
  };
}

async function statsFor(game, force) {
  const appId = Number(game.appId);
  const hit = cache.get(appId);
  if (!force && hit && Date.now() - hit.at < TTL) {
    return { ...hit.data, name: game.name, builtin: game.builtin, cached: true };
  }

  const base = {
    appId,
    name: game.name,
    builtin: game.builtin,
    at: Date.now(),
    total: 0,
    lowestText: '',
    lowestName: '',
    lowestCents: 0,
    lowestHash: '',
    volume: null,
    error: '',
  };

  try {
    const { total, results } = await searchCheapest(appId);
    base.total = total;
    // Steam 偶尔会返回 ¥0.00 的单条挂单（挂不了价或异常单），
    // 拿它当「最低在售」会误导读数，所以只取有正常价格的条目。
    const priced = results.filter((r) => Number(r.sell_price) > 0);
    const list = priced.length ? priced : results;
    const first = list[0];
    if (first) {
      base.lowestText = first.sell_price_text || '';
      base.lowestName = first.name || first.hash_name || '';
      base.lowestCents = Number(first.sell_price) || 0;
      base.lowestHash = first.hash_name || '';
      base.cheapest = list.slice(0, 3).map((r) => ({
        name: r.name || r.hash_name || '',
        price: r.sell_price_text || '',
        listings: Number(r.sell_listings) || 0,
      }));
    }
    // 24 小时成交量需要再查一次单件行情，那会让整页多等十几秒；
    // 这里只保留市场搜索能直接给出的数据，成交量在物品详情里看。
  } catch (e) {
    base.error = (e && e.message) || '读取失败';
    logger.warn('挂机行情读取失败', { appId, message: base.error });
  }

  cache.set(appId, { at: Date.now(), data: base });
  return base;
}

async function all(opts = {}) {
  const list = games();
  const out = [];
  let netFails = 0;
  for (let i = 0; i < list.length; i++) {
    const one = await statsFor(list[i], !!opts.force);
    out.push(one);
    // 连续两个都连不上，后面的就不用再等超时了，直接标出来
    netFails = one.error ? netFails + 1 : 0;
    if (netFails >= 2) {
      for (const rest of list.slice(i + 1)) {
        out.push({
          appId: Number(rest.appId),
          name: rest.name,
          builtin: rest.builtin,
          at: Date.now(),
          total: 0,
          lowestText: '',
          lowestName: '',
          cheapest: [],
          error: '社区接口连不上，稍后点「刷新行情」再试',
        });
      }
      break;
    }
    if (i < list.length - 1) await sleep(GAP_MS);
  }
  return out;
}

function addWatch(appId, name) {
  const id = Number(appId);
  if (!id || id <= 0) throw Object.assign(new Error('AppID 不对'), { code: 'E_BAD_APPID' });
  const s = store.getSettings();
  const list = Array.isArray(s.idleWatchApps) ? s.idleWatchApps.slice() : [];
  if (list.some((w) => Number(w && w.appId ? w.appId : w) === id)) {
    return { added: false, list };
  }
  list.push({ appId: id, name: String(name || `App ${id}`).slice(0, 80), at: Date.now() });
  store.setSettings({ idleWatchApps: list.slice(0, 30) });
  logger.info('加入挂机监控', { appId: id, name });
  return { added: true, list };
}

function removeWatch(appId) {
  const id = Number(appId);
  const s = store.getSettings();
  const list = (Array.isArray(s.idleWatchApps) ? s.idleWatchApps : []).filter(
    (w) => Number(w && w.appId ? w.appId : w) !== id
  );
  store.setSettings({ idleWatchApps: list });
  return { added: false, list };
}

function clearCache() {
  cache.clear();
}

module.exports = { games, statsFor, all, addWatch, removeWatch, clearCache };
