'use strict';

const store = require('./store');

/**
 * AppID → 中文游戏名
 *
 * ★ 为什么需要这个 ★
 * 游戏库的名字有两个来源，都不够用：
 *   1) 本地 appmanifest / localconfig.vdf 里的 name —— 只有"曾经安装/启动过"的才有，
 *      其余全是 `App 92`、`App 220` 这种占位符；
 *   2) Steam Web API 的 GetOwnedGames —— 名字是账号语言，且老游戏依然是英文。
 *
 * 这里走商店的批量接口 IStoreBrowseService/GetItems：
 *   - 一次可以问几十个 appid（appdetails 一次只稳一个，397 个游戏要几分钟）
 *   - context.language=schinese 让它直接回商店中文名
 *   - 不需要 API Key
 * 结果落进 settings.appNames 永久缓存，之后扫描零网络请求。
 */

const BATCH = 40;           // 一次问多少个（实测 40 稳定，再大响应变慢）
const MAX_PER_RUN = 600;    // 一次任务最多解析多少个，防止误传大数组打满请求
const GAP_MS = 260;         // 批次间隔，别把公开接口打限流

let cache = null;
let inflight = null;

function loadCache() {
  if (cache) return cache;
  const s = store.getSettings() || {};
  cache = Object.assign({}, s.appNames || {});
  return cache;
}

function persist() {
  try {
    store.setSettings({ appNames: cache });
  } catch { /* 写盘失败只影响下次启动，不影响本次显示 */ }
}

/** 同步查缓存：扫描游戏库时用它，命中就省一次网络往返 */
function nameOf(appId) {
  const c = loadCache();
  const hit = c[String(Number(appId))];
  return hit && hit.zh ? hit.zh : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchBatch(ids) {
  const input = {
    ids: ids.map((id) => ({ appid: Number(id) })),
    context: { language: 'schinese', country_code: 'CN', steam_realm: 'steam_global' },
    data_request: { include_basic_info: true },
  };
  const url =
    'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' +
    encodeURIComponent(JSON.stringify(input));

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`商店接口返回 ${res.status}`);
  const json = await res.json();
  const items = (json && json.response && json.response.store_items) || [];
  return items;
}

/**
 * 批量解析并缓存。已缓存的直接跳过。
 * @returns {Promise<Object<string,string>>} appId → 中文名（只含本次拿到的）
 */
async function resolveMany(appIds) {
  const c = loadCache();
  const want = [];
  const asked = [];
  for (const raw of Array.isArray(appIds) ? appIds : []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0 || asked.includes(id)) continue;
    asked.push(id);
    if (c[String(id)] && c[String(id)].zh) continue;
    want.push(id);
    if (want.length >= MAX_PER_RUN) break;
  }

  // 同一时间只跑一个解析任务，重复点击直接复用
  if (want.length) {
    if (inflight) await inflight.catch(() => {});
    const still = want.filter((id) => !(c[String(id)] && c[String(id)].zh));
    if (still.length && !inflight) inflight = runBatches(still);
    if (inflight) await inflight.catch(() => {}); // 单批失败已在内部吞掉
  }

  const out = {};
  for (const id of asked) {
    const hit = c[String(id)];
    if (hit && hit.zh) out[String(id)] = hit.zh;
  }
  return out;
}

async function runBatches(want) {
  const c = loadCache();
  const got = {};
  try {
    for (let i = 0; i < want.length; i += BATCH) {
      const chunk = want.slice(i, i + BATCH);
      try {
        const items = await fetchBatch(chunk);
        for (const it of items) {
          const id = Number(it && it.appid);
          const zh = it && typeof it.name === 'string' ? it.name.trim() : '';
          if (!id || !zh) continue;
          c[String(id)] = { zh, at: Date.now() };
          got[String(id)] = zh;
        }
        // 接口对"已下架/区域不可见"的 app 会直接不回，记成空名避免每次重试
        for (const id of chunk) {
          if (!got[String(id)] && !c[String(id)]) c[String(id)] = { zh: '', at: Date.now() };
        }
        persist();
      } catch (err) {
        // 单批失败不影响其它批次；失败的不写缓存，下次还能再试
        console.warn('[appNames] batch failed:', err.message);
      }
      if (i + BATCH < want.length) await sleep(GAP_MS);
    }
    return got;
  } finally {
    inflight = null;
  }
}

module.exports = { nameOf, resolveMany, _cache: () => loadCache() };
