'use strict';

/**
 * IsThereAnyDeal 史低查询（可选）
 *
 * Steam 官方接口不提供历史最低价，这里接 ITAD 的公开 API：
 *   1. 用自己的 Steam AppID 换 ITAD 内部 id：/games/lookup/v1
 *   2. 取历史最低：/games/historylow/v1（按国家返回各商店的低价记录）
 *
 * 需要用户自己在 isthereanydeal.com 申请免费 API Key，存在加密区；
 * 没配 Key 时整块功能不出现，也不会发任何请求。
 */

const { net } = require('electron');
const store = require('./store');
const logger = require('./logger');

const API = 'https://api.isthereanydeal.com';
const TIMEOUT_MS = 12000;

function key() {
  try {
    return store.readSecret('store:itadKey') || '';
  } catch {
    return '';
  }
}

async function getJson(url) {
  // 用 Electron 的 net：跟着系统代理走，和浏览器行为一致
  const res = await net.fetch(url, {
    headers: { 'User-Agent': 'SteamDesk/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 通常是网关错误页 */
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 120) || `HTTP ${res.status}`;
    throw Object.assign(new Error(`ITAD 返回 ${res.status}：${msg}`), { code: 'E_ITAD_HTTP' });
  }
  return json;
}

function moneyText(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  if (currency === 'CNY') return `¥${n.toFixed(2)}`;
  if (currency === 'USD') return `$${n.toFixed(2)}`;
  if (currency === 'EUR') return `€${n.toFixed(2)}`;
  return `${n.toFixed(2)} ${currency || ''}`.trim();
}

/** 查史低；没配 Key 返回 {configured:false} */
async function historyLow(appId) {
  const k = key();
  if (!k) return { configured: false };
  const id = Number(appId);
  if (!id) throw Object.assign(new Error('AppID 不对'), { code: 'E_BAD_APPID' });

  const lookup = await getJson(
    `${API}/games/lookup/v1?key=${encodeURIComponent(k)}&appid=${encodeURIComponent(String(id))}`
  );
  if (!lookup || lookup.found !== true || !lookup.game || !lookup.game.id) {
    return { configured: true, found: false, message: 'ITAD 没有收录这个游戏' };
  }
  const gameId = lookup.game.id;
  const country = String(store.getSettings().storeRegion || 'CN') === 'CN' ? 'CN' : 'US';
  const lows = await getJson(
    `${API}/games/historylow/v1?key=${encodeURIComponent(k)}&id=${encodeURIComponent(gameId)}&country=${country}`
  );
  const arr = Array.isArray(lows) ? lows : [];
  if (!arr.length) return { configured: true, found: true, low: null };

  // 优先 Steam（shop id 61），否则取金额最低的一条
  let pick = arr.find((x) => x && x.shop && (Number(x.shop.id) === 61 || /steam/i.test(x.shop.name || '')));
  if (!pick) {
    pick = arr
      .filter((x) => x && x.price && Number(x.price.amount) > 0)
      .sort((a, b) => Number(a.price.amount) - Number(b.price.amount))[0];
  }
  if (!pick || !pick.price) return { configured: true, found: true, low: null };

  const low = {
    amount: Number(pick.price.amount) || 0,
    currency: pick.price.currency || '',
    text: moneyText(pick.price.amount, pick.price.currency),
    shop: (pick.shop && pick.shop.name) || 'Steam',
    at: pick.timestamp ? Date.parse(pick.timestamp) || 0 : 0,
    url: lookup.game.url || '',
  };
  logger.info('ITAD 史低', { appId: id, low: low.text });
  return { configured: true, found: true, low, title: lookup.game.title || '' };
}

function status() {
  return { configured: !!key() };
}

module.exports = { historyLow, status };
