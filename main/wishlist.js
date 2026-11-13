'use strict';

/**
 * Steam 愿望单批量查价
 *
 * 愿望单本身是公开页面数据（store.steampowered.com/wishlist/profiles/<steamid>/wishlistdata），
 * 用 persist:steam 的会话去读，公开愿望单不需要额外 API Key。
 * 一次最多查 40 个游戏（每个游戏一个 appdetails 请求，带间隔），避免把商店接口打太快。
 */

const session = require('./session');
const store = require('./store');
const logger = require('./logger');
const { queryStorePrice } = require('./storeSearch');

const MAX_ITEMS = 40;
const GAP_MS = 280;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function steamId() {
  const live = await session.getSession().catch(() => null);
  return (live && live.steamId) || '';
}

/** 读愿望单：返回 [{appId,name}]，私有愿望单会抛出可读的错误 */
async function list() {
  const sid = await steamId();
  if (!sid) {
    throw Object.assign(new Error('还没有登录 Steam 网页会话，登录后才能读取愿望单'), {
      code: 'E_NO_SESSION',
    });
  }
  const url = `https://store.steampowered.com/wishlist/profiles/${encodeURIComponent(sid)}/wishlistdata/?p=0`;
  let res;
  try {
    res = await session.authFetch(url, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(new Error(`读取愿望单失败：${(e && e.message) || 'timeout'}`), {
      code: 'E_NET',
    });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`读取愿望单失败：HTTP ${res.status}`), { code: 'E_HTTP' });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const ct = res.headers.get('content-type') || '无 Content-Type';
    const head = text.slice(0, 160).replace(/\s+/g, ' ');
    const html = /<html|<!doctype|login/i.test(text.slice(0, 400));
    throw new Error(
      html
        ? '读取愿望单失败：Steam 返回了登录/隐私页面，请确认已登录，且愿望单在隐私设置里是「公开」'
        : `读取愿望单失败：返回的不是 JSON（HTTP ${res.status}，${ct}）：${head}`
    );
  }
  // 私有愿望单 / 空愿望单通常返回 [] 或 {success:2}
  if (Array.isArray(json) || (json && Number(json.success) === 2)) {
    return { steamId: sid, total: 0, items: [], empty: true };
  }
  if (!json || typeof json !== 'object') {
    throw new Error('愿望单返回格式不对（可能被要求登录）');
  }
  const items = Object.entries(json)
    .map(([id, v]) => ({
      appId: Number(id),
      name: (v && v.name) || `App ${id}`,
      priority: Number(v && v.priority) || 0,
    }))
    .filter((x) => x.appId > 0)
    .sort((a, b) => a.priority - b.priority);

  if (!items.length) return { steamId: sid, total: 0, items: [], empty: true };
  return {
    steamId: sid,
    total: items.length,
    // ids 是完整愿望单，给促销页打「愿望单」标记用；items 只查前 40 个的价格
    ids: items.map((x) => x.appId),
    items: items.slice(0, MAX_ITEMS).map((x) => ({ appId: x.appId, name: x.name })),
  };
}

/** 给愿望单里的游戏逐个查商店价（延迟队列，40 个约 15 秒） */
async function prices(list) {
  const arr = (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS);
  const region = String(store.getSettings().storeRegion || 'CN');
  const out = [];
  for (const it of arr) {
    const appId = Number(it && it.appId);
    if (!appId) continue;
    try {
      const p = await queryStorePrice(appId, { region });
      out.push({
        appId,
        name: p.name || (it && it.name) || `App ${appId}`,
        finalPriceFormatted: p.finalPriceFormatted,
        initialPriceFormatted: p.initialPriceFormatted,
        finalPriceYuan: p.finalPriceYuan,
        discountPercent: p.discountPercent || 0,
        comingSoon: !!p.comingSoon,
        isFree: !!p.isFree,
        currency: p.currency,
      });
    } catch (e) {
      out.push({
        appId,
        name: (it && it.name) || `App ${appId}`,
        error: (e && e.message) || '查价失败',
      });
    }
    await sleep(GAP_MS);
  }
  logger.info('愿望单批量查价', { region, count: out.length });
  return { region, items: out };
}

module.exports = { list, prices, MAX_ITEMS };
