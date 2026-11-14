'use strict';

/**
 * 游戏玩家与市场统计
 *
 * 数据源全部走 Steam 官方免费接口（不需要任何 Key）：
 *   1. 当前在线人数：https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=N
 *      —— 单个游戏一个请求，无 Key、无频率限制文档，加 10 分钟缓存 + 2 次重试
 *   2. 名称 / 价格：store.steampowered.com/api/appdetails（storeSearch 里已有）
 *
 * 热门榜用一份内置的常见游戏清单逐个查在线人数（Steam 官方 charts
 * 接口无公开 JSON，SteamSpy 有 Cloudflare 拦截，稳定可用的就是 CCU 接口）。
 */

const storeSearch = require('./storeSearch');

/** 内置热门清单（偏交易/挂卡用户关心的游戏 + 大众热门） */
const POPULAR = [
  { appId: 730, name: 'Counter-Strike 2' },
  { appId: 570, name: 'Dota 2' },
  { appId: 440, name: 'Team Fortress 2' },
  { appId: 252490, name: 'Rust' },
  { appId: 2923300, name: 'Banana' },
  { appId: 2977660, name: 'Cats' },
  { appId: 3014060, name: 'Egg' },
  { appId: 304930, name: 'Unturned' },
  { appId: 578080, name: 'PUBG: BATTLEGROUNDS' },
  { appId: 1172470, name: 'Apex Legends' },
  { appId: 1085660, name: 'Teamfight Tactics' },
  { appId: 271590, name: 'Grand Theft Auto V' },
  { appId: 1245620, name: 'ELDEN RING' },
  { appId: 2358720, name: 'Black Myth: Wukong' },
  { appId: 1091500, name: 'Cyberpunk 2077' },
  { appId: 431960, name: 'Wallpaper Engine' },
  { appId: 105600, name: 'Terraria' },
  { appId: 413150, name: 'Stardew Valley' },
  { appId: 367520, name: 'Hollow Knight' },
  { appId: 550, name: 'Left 4 Dead 2' },
  { appId: 400, name: 'Portal' },
  { appId: 220, name: 'Half-Life 2' },
  { appId: 1086940, name: 'Baldur’s Gate 3' },
  { appId: 1938010, name: 'Counter-Strike 2 (老 AppID)' },
  { appId: 1623730, name: 'Palworld' },
  { appId: 594650, name: 'Hunt: Showdown' },
  { appId: 1174180, name: 'Steam Deck 工具' },
  { appId: 1517290, name: 'Yu-Gi-Oh! Master Duel' },
  { appId: 1085440, name: 'Duck Hunt' },
];

const CACHE_MS = 10 * 60 * 1000;
let popularCache = { at: 0, rows: [] };
const ccuCache = new Map(); // appId -> { at, ccu }

async function fetchJsonRetry(url, retries = 2, timeoutMs = 9000) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    }
  }
  throw lastErr || new Error('请求失败');
}

/** 单个游戏的当前在线人数（带缓存与重试） */
async function ccuOf(appId) {
  const id = Number(appId);
  if (!id) throw new Error('AppID 不对');
  const hit = ccuCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ccu;
  const json = await fetchJsonRetry(
    `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${id}`
  );
  const n = json && json.response && Number(json.response.player_count);
  if (!Number.isFinite(n)) throw new Error('接口返回异常');
  ccuCache.set(id, { at: Date.now(), ccu: n });
  return n;
}

/** 热门在线榜（并发查全部，失败行标注但不出局） */
async function popular() {
  if (popularCache.rows.length && Date.now() - popularCache.at < CACHE_MS) {
    return { at: popularCache.at, fromCache: true, rows: popularCache.rows };
  }
  const results = await Promise.allSettled(POPULAR.map((g) => ccuOf(g.appId)));
  const rows = POPULAR.map((g, i) => {
    const r = results[i];
    return r.status === 'fulfilled'
      ? { ok: true, ...g, ccu: r.value }
      : { ok: false, ...g, ccu: 0, error: (r.reason && r.reason.message) || '查询失败' };
  }).sort((a, b) => (b.ok ? b.ccu : -1) - (a.ok ? a.ccu : -1));
  popularCache = { at: Date.now(), rows };
  return { at: popularCache.at, fromCache: false, rows };
}

/**
 * 单游戏统计：在线人数 + 商店基本信息（名称/价格/发售）。
 * 支持名称或 AppID 输入。
 */
async function lookup(term) {
  const q = String(term || '').trim();
  if (!q) throw new Error('请输入游戏名或 AppID');
  const price = await storeSearch.queryStorePrice(q, { region: 'CN' }).catch(() => null);
  const appId = price ? price.appId : Number(q);
  if (!appId || Number.isNaN(appId)) throw new Error('未找到匹配的游戏');
  const ccu = await ccuOf(appId).catch(() => null);
  return {
    appId,
    name: price ? price.name : `App ${appId}`,
    ccu,
    price: price || null,
  };
}

module.exports = { popular, lookup, ccuOf, POPULAR };