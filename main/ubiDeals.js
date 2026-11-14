'use strict';

/**
 * 平台促销清单（Ubisoft / EA / 暴雪战网）
 *
 * ★ 数据源说明 ★
 * - Ubisoft 官方商店接口已停用（410），Ubisoft Connect 库/促销需登录凭据；
 * - EA App、暴雪战网同样没有公开免登录接口。
 * 三家都走 CheapShark 聚合源（免费无 Key，美元报价）：
 *   - Uplay（Ubisoft）storeID=13，当前活跃；
 *   - Origin（EA）storeID=8，EA 转向 EA App 后已被聚合源停用，暂无返回；
 *   - Blizzard Shop storeID=31，同样处于停用状态。
 * 停用源返回空数组时安静返回（不算错误）——聚合源恢复收录后自动出数据。
 *
 * 结果给「游戏库 → 平台标签页」展示；每日促销页另有同源标签。
 */

const logger = require('./logger');

const TTL = 20 * 60 * 1000;
const UA = `SteamDesk/${require('../package.json').version} (desktop app)`;

const PLATFORMS = {
  ubisoft: { storeId: '13', label: 'Ubisoft', size: 30, silentEmpty: false },
  ea: { storeId: '8', label: 'EA', size: 20, silentEmpty: true },
  blizzard: { storeId: '31', label: '暴雪战网', size: 20, silentEmpty: true },
};

const caches = new Map(); // platform -> { at, items }
const inflights = new Map();

const NON_GAME = /(^|[\s:(])(upgrade|dlc|season pass|soundtrack|expansion|add-?on|beta)([\s:)]|$)/i;

async function fetchList(platform) {
  const cfg = PLATFORMS[platform];
  const res = await fetch(
    `https://www.cheapshark.com/api/1.0/deals?storeID=${cfg.storeId}&pageSize=${cfg.size}&sortBy=Deal%20Rating`,
    {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const items = [];
  for (const d of Array.isArray(j) ? j : []) {
    const sale = Number(d.salePrice);
    const normal = Number(d.normalPrice);
    const save = Math.round(Number(d.savings) || 0);
    if (!(sale >= 0) || !(normal > 0) || save < 10) continue;
    if (NON_GAME.test(String(d.title || ''))) continue;
    items.push({
      title: d.title || '游戏',
      image: d.thumb || '',
      salePrice: sale,
      normalPrice: normal,
      discount: Math.min(99, save),
      url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealID || '')}`,
      steamAppId: d.steamAppID ? Number(d.steamAppID) : 0,
    });
  }
  // 停用的聚合源返回空：安静返回空列表，聚合恢复后自动出数据
  if (!items.length && cfg.silentEmpty) {
    return { at: Date.now(), items, empty: true };
  }
  if (!items.length) throw new Error(`${cfg.label}（Uplay）促销为空`);
  return { at: Date.now(), items };
}

async function list(platform, force) {
  const key = String(platform || '').toLowerCase();
  if (!PLATFORMS[key]) throw new Error(`未知平台：${platform}`);
  const hit = caches.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit;
  if (inflights.has(key)) return inflights.get(key);
  const p = fetchList(key)
    .then((r) => {
      caches.set(key, r);
      return r;
    })
    .finally(() => {
      inflights.delete(key);
    });
  inflights.set(key, p);
  return p;
}

function clearCache() {
  caches.clear();
}

module.exports = { list, clearCache, PLATFORMS };
