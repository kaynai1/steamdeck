'use strict';

const store = require('./store');
const logger = require('./logger');
const dict = require('./gameZhDict');

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
const MISS_TTL = 7 * 24 * 3600 * 1000; // 查不到的名字记空 7 天，避免每次都重查

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
  const now = Date.now();
  let dictHits = 0;
  for (const raw of Array.isArray(appIds) ? appIds : []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0 || asked.includes(id)) continue;
    asked.push(id);
    // ① 内置词典优先：官方接口对 ETS2 / Project Zomboid 这类游戏没有中文名字字段；
    //    词典是人工校对的准真值，永远覆盖缓存里的英文/空记录
    const dictZh = dict.zhByApp(id);
    if (dictZh) {
      if (!c[String(id)] || c[String(id)].zh !== dictZh) {
        c[String(id)] = { zh: dictZh, at: now, src: 'dict' };
        dictHits++;
      }
      continue;
    }
    const hit = c[String(id)];
    // 有中文名直接用；查不到的空记录 7 天内不重查
    if (hit && (hit.zh || now - (hit.at || 0) < MISS_TTL)) continue;
    want.push(id);
    if (want.length >= MAX_PER_RUN) break;
  }
  if (dictHits) persist();

  // 同一时间只跑一个解析任务，重复点击直接复用
  if (want.length) {
    if (inflight) await inflight.catch(() => {});
    const now2 = Date.now();
    const still = want.filter((id) => {
      const hit = c[String(id)];
      return !(hit && (hit.zh || now2 - (hit.at || 0) < MISS_TTL));
    });
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
        // 接口对"已下架/区域不可见/隐藏应用"的 app 会直接不回，记成空名避免每次重试
        for (const id of chunk) {
          if (!got[String(id)] && !c[String(id)]) c[String(id)] = { zh: '', at: Date.now() };
        }
        persist();
      } catch (err) {
        // 单批失败不影响其它批次；失败的不写缓存，下次还能再试
        logger.warn('appNames 批次失败', { message: err && err.message });
      }
      if (i + BATCH < want.length) await sleep(GAP_MS);
    }
    return got;
  } finally {
    inflight = null;
  }
}

/* ------------------------- 标题 → 中文名（促销/免费卡用） -------------------------
 * 每日促销的 GOG/Epic 卡和免费领取的活动没有 Steam AppID，只有标题。
 * 链路：商店搜索（英文名）拿 AppID → 与标题做相似度校验防错译 → GetItems 拿中文名。
 * 结果落进 settings.zhTitles 永久缓存（键是归一化标题）。
 */

const TITLE_TTL = 30 * 24 * 3600 * 1000;
let titleCache = null;
let titleInflight = null;

function loadTitleCache() {
  if (titleCache) return titleCache;
  const s = store.getSettings() || {};
  titleCache = Object.assign({}, s.zhTitles || {});
  return titleCache;
}

function persistTitles() {
  try {
    store.setSettings({ zhTitles: titleCache });
  } catch { /* 写盘失败只影响下次启动 */ }
}

function normKey(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

/** 相似度校验：归一化后互相包含（至少 4 字符）或相等，防搜索命中别的游戏 */
function similarEnough(a, b) {
  const x = normKey(a);
  const y = normKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 4 && (long.includes(short) || short.includes(long));
}

async function storeSearchOne(title) {
  const url =
    'https://store.steampowered.com/api/storesearch/?term=' +
    encodeURIComponent(title) +
    '&l=english&cc=cn';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`商店搜索返回 ${res.status}`);
  const json = await res.json();
  const items = (json && json.items) || [];
  if (!items.length) return null;
  return { appId: Number(items[0].id), en: String(items[0].name || '') };
}

/**
 * 批量解析标题 → 中文名。
 * 词典命中与缓存命中「立即返回」；新标题的商店搜索在后台跑
 * （商店接口时常超时，不能让整批结果陪着等），渲染层会延迟重试拾取。
 * @returns {Promise<Object<string,string>>} 原标题 → 中文名（本次能立即确定的）
 */
async function resolveTitles(titles) {
  const c = loadTitleCache();
  const now = Date.now();
  const out = {};
  const want = [];
  const asked = [];
  let dictChanged = 0;
  for (const raw of Array.isArray(titles) ? titles : []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const key = normKey(t);
    if (!key || asked.includes(key)) continue;
    asked.push(key);
    // ① 词典命中立即返回（准真值，覆盖旧英文/空记录）
    const dictZh = dict.zhByTitle(t) || dict.zhByTitle(dict.cleanGiveawayTitle(t));
    if (dictZh) {
      const hit = c[key];
      if (!hit || hit.zh !== dictZh) {
        c[key] = { zh: dictZh, at: now, src: 'dict' };
        dictChanged++;
      }
      out[t] = dictZh;
      continue;
    }
    // ② 已缓存（含 30 天内的空记录）直接用
    const hit = c[key];
    if (hit && now - (hit.at || 0) < TITLE_TTL) {
      if (hit.zh) out[t] = hit.zh;
      continue;
    }
    want.push({ title: t, key });
  }
  if (dictChanged || asked.length) persistTitles();
  // ③ 未缓存的新标题转后台搜索；同一时间只跑一批
  if (want.length && !titleInflight) {
    const still = want.filter(({ key }) => {
      const hit = c[key];
      return !(hit && Date.now() - (hit.at || 0) < TITLE_TTL);
    });
    if (still.length) titleInflight = runTitleBatches(still).catch(() => {});
  }
  return out;
}

async function runTitleBatches(want) {
  const c = loadTitleCache();
  const got = {};
  try {
    // ① 词典先筛：命中直接入缓存，剩下的进商店搜索
    const searched = []; // { title, key, searchTitle }
    for (const { title, key } of want) {
      const dictZh = dict.zhByTitle(title) || dict.zhByTitle(dict.cleanGiveawayTitle(title));
      if (dictZh) {
        c[key] = { zh: dictZh, at: Date.now(), src: 'dict' };
        got[title] = dictZh;
        continue;
      }
      // 免费卡标题常带 Steam Key Giveaway 尾巴，搜索前先洗掉
      searched.push({ title, key, searchTitle: dict.cleanGiveawayTitle(title) || title });
    }
    if (want.length) persistTitles();

    // ② 商店搜索并发 3，拿 AppID 与英文名
    const results = new Map(); // key → { title, searchTitle, hit }
    let idx = 0;
    const worker = async () => {
      while (idx < searched.length) {
        const item = searched[idx++];
        try {
          const hit = await storeSearchOne(item.searchTitle);
          results.set(item.key, { title: item.title, searchTitle: item.searchTitle, hit });
        } catch (err) {
          logger.warn('商店搜索失败', { title: item.title, message: err && err.message });
          results.set(item.key, { title: item.title, searchTitle: item.searchTitle, hit: null });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    // ③ 相似度校验后，把所有命中的 AppID 汇总成一次 GetItems 批量拿中文名
    const ids = [];
    const mapping = new Map(); // appId → [{ title, key, en }]
    for (const { title, key, searchTitle, hit } of results.values()) {
      if (hit && hit.appId && similarEnough(searchTitle, hit.en)) {
        ids.push(hit.appId);
        if (!mapping.has(hit.appId)) mapping.set(hit.appId, []);
        mapping.get(hit.appId).push({ title, key, en: hit.en });
      } else {
        // 搜索无结果或相似度不过关：记空，30 天内不再试
        c[key] = { zh: '', at: Date.now() };
      }
    }
    let zhMap = {};
    if (ids.length) {
      try {
        zhMap = await resolveMany(ids);
      } catch (err) {
        logger.warn('批量取中文名失败', { message: err && err.message });
      }
    }
    for (const [appId, arr] of mapping) {
      const zh = zhMap[String(appId)];
      for (const { title, key, en } of arr) {
        if (zh) {
          c[key] = { zh, appId, en, at: Date.now() };
          got[title] = zh;
        } else {
          c[key] = { zh: '', appId, en, at: Date.now() };
        }
      }
    }
    persistTitles();
    return got;
  } finally {
    titleInflight = null;
  }
}

module.exports = { nameOf, resolveMany, resolveTitles, _cache: () => loadCache(), _titleCache: () => loadTitleCache() };
