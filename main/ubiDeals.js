'use strict';

/**
 * Ubisoft（Uplay）促销清单
 *
 * ★ 数据源说明 ★
 * Ubisoft 官方商店接口已停用（store.ubisoft.com API 返回 410），
 * Ubisoft Connect 的库/促销接口需要登录凭据且随时变更。
 * 这里走 CheapShark 的 Uplay 聚合源（storeID=13，免费无 Key）：
 * 拉当前 Uplay 商店的折扣商品（美元报价），给「游戏库 → Ubisoft」
 * 标签页展示。无需登录 Ubisoft 账号。
 *
 * 免费领取说明：Ubisoft 的免费游戏活动（如 Connect 限时领取）
 * 没有稳定的公开接口；GamerPower 的 ubisoft 平台当前也无活动。
 * 免费领取页保持 Steam / Epic / GOG 三源。
 */

const logger = require('./logger');

const TTL = 20 * 60 * 1000;
const UA = `SteamDesk/${require('../package.json').version} (desktop app)`;
const STORE_ID = '13'; // CheapShark: Uplay

let cache = null; // { at, items }
let inflight = null;

const NON_GAME = /(^|[\s:(])(upgrade|dlc|season pass|soundtrack|expansion|add-?on|beta)([\s:)]|$)/i;

async function fetchList() {
  const res = await fetch(
    `https://www.cheapshark.com/api/1.0/deals?storeID=${STORE_ID}&pageSize=30&sortBy=Deal%20Rating`,
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
      title: d.title || 'Ubisoft 游戏',
      image: d.thumb || '',
      salePrice: sale,
      normalPrice: normal,
      discount: Math.min(99, save),
      url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealID || '')}`,
      steamAppId: d.steamAppID ? Number(d.steamAppID) : 0,
    });
  }
  if (!items.length) throw new Error('Ubisoft（Uplay）促销为空');
  return { at: Date.now(), items };
}

async function list(force) {
  if (!force && cache && Date.now() - cache.at < TTL) return cache;
  if (inflight) return inflight;
  inflight = fetchList()
    .then((r) => {
      cache = r;
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function clearCache() {
  cache = null;
}

module.exports = { list, clearCache, _isError: (e) => logger.warn('Ubisoft 促销读取失败', { message: e && e.message }) };
