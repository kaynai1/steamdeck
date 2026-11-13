'use strict';

/**
 * Epic 已拥有游戏库
 *
 * 1) library-service 里拿"我拥有的条目"（需要账号 bearer）
 * 2) catalog-public-service 批量补标题、封面、类型（同一个 bearer）
 * 3) 失败时退回 library 记录里的字段，保证至少有名字可显示
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');

const PARTITION = 'persist:epic';
const UA =
  'EpicGamesLauncher/17.0.0-38338133+++Portal+Release-Live Windows/10.0.22631.1.768.64bit';
const LIB_ITEMS = 'https://library-service.live.use1a.on.epicgames.com/library/api/public/items';
const CATALOG = 'https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace';

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

async function tokenFor(accountId) {
  const claim = require('./epicClaim');
  const list = await claim.list();
  const acc = list.accounts.find((a) => a.accountId === accountId);
  if (!acc) throw err('E_EPIC_LOGIN', '没有这个 Epic 账号');
  // claim 内部会处理续期；这里借它的 ensure 逻辑
  const tokens = await claim._ensureAccount(accountId);
  return tokens;
}

function auth(token) {
  return {
    Authorization: `bearer ${token.accessToken}`,
    'User-Agent': UA,
    Accept: 'application/json',
  };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 200) };
  }
}

/** 请求库里的一页（cursor 为空就是第一页） */
async function fetchPage(t, cursor) {
  const u = new URL(LIB_ITEMS);
  u.searchParams.set('includeMetadata', 'true');
  if (cursor) u.searchParams.set('cursor', cursor);
  const res = await fetch(u.toString(), { headers: auth(t), signal: AbortSignal.timeout(15000) });
  const json = await readJson(res);
  if (res.status === 401) throw err('E_EPIC_LOGIN', 'Epic 登录已过期，请重新登录');
  if (!res.ok) {
    throw err('E_EPIC_LIB', `读取 Epic 库失败：${json.errorMessage || `HTTP ${res.status}`}`);
  }
  const list = json.records || [];
  const next = (json.responseMetadata && json.responseMetadata.nextCursor) || '';
  return { list, next };
}

/** cursor 实际是 base64 的 {"offset":N}，据此推算下一页位置 */
function cursorAt(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function offsetOf(cursor) {
  try {
    const j = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    return Number(j.offset) || 0;
  } catch {
    return 0;
  }
}

/**
 * 拉取某个账号的全部库条目。
 * Epic 一页只给 100 条，400 多个游戏原先要串行等 5 次往返；
 * cursor 只是 base64 的 {"offset":N}，所以直接按 offset 一次并发拉 6 页，
 * 一轮就能把常见规模的库拉完。offset 超过库长度的那几页返回空，不影响结果。
 */
async function fetchRecords(accountId) {
  const t = await tokenFor(accountId);
  const out = [];
  const STEP = 100;
  const BATCH = 6;
  const MAX_PAGES = 24;
  let offset = 0;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const batchStart = offset;
    const offsets = [];
    for (let k = 0; k < BATCH && pages + k < MAX_PAGES; k++) offsets.push(batchStart + k * STEP);
    const res = await Promise.all(
      offsets.map((o) => fetchPage(t, o ? cursorAt(o) : '').catch(() => ({ list: [], next: '', failed: true })))
    );
    let any = false;
    let lastWithData = null;
    for (const p of res) {
      pages += 1;
      if (p.failed || !p.list.length) continue;
      any = true;
      out.push(...p.list);
      lastWithData = p;
    }
    // 这一批里最后一页都没有 nextCursor，就说明已经到库尾
    if (!any || !lastWithData || !lastWithData.next) break;
    offset = Math.max(batchStart + STEP * BATCH, offsetOf(lastWithData.next));
    if (offset >= MAX_PAGES * STEP) break;
  }
  return { token: t, records: out };
}

/* ---------------------------- 目录信息（标题 / 封面） ---------------------------- */

/*
 * 目录接口按 namespace 分开查，一个 400 款的库会变成上百次请求，全部补齐要 20 秒左右。
 * 这里做三件事：
 *   1) 目录结果按 ns:catalogItemId 落盘缓存 7 天，第二次打开直接命中；
 *   2) 同一个域名最多 6 个请求同时在飞，避免几百个连接互相排队；
 *   3) 分批补齐，每补完一批就把已解析的条目推给界面，先看到列表再慢慢出封面。
 */
const CAT_TTL = 7 * 24 * 60 * 60 * 1000;
let catCache = null;
let catSavedAt = 0;

function catCacheFile() {
  try {
    const dir = store.baseDir;
    return dir ? path.join(dir, 'epic-catalog-cache.json') : null;
  } catch {
    return null;
  }
}

function ensureCatCache() {
  if (catCache) return;
  catCache = {};
  const file = catCacheFile();
  if (!file) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object') catCache = data;
  } catch {
    /* 没缓存或文件损坏：当作空，后面会重写 */
  }
}

function saveCatCache(force) {
  if (!catCache) return;
  if (!force && Date.now() - catSavedAt < 3000) return;
  const file = catCacheFile();
  if (!file) return;
  catSavedAt = Date.now();
  try {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(catCache), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 写不进去不影响显示 */
  }
}

function cachedMeta(ns, id) {
  ensureCatCache();
  const c = catCache[`${ns}:${id}`];
  if (!c || !c.at || Date.now() - c.at > CAT_TTL) return null;
  return { title: c.t || '', image: c.i || '', type: '', desc: c.d || '' };
}

/** 并发跑一组任务，limit 是同时在飞的数量 */
async function pool(jobs, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await worker(job);
    }
  });
  await Promise.all(runners);
}

/**
 * 批量补目录信息：标题、封面、简介，结果写进 info（key = ns:id）。
 * @param {Map} info 已有的结果会被跳过
 * @param {string[]} [onlyNamespaces] 只补这些 namespace
 */
async function enrich(t, records, onlyNamespaces, info) {
  const out = info || new Map();
  const allow = Array.isArray(onlyNamespaces) && onlyNamespaces.length
    ? new Set(onlyNamespaces)
    : null;
  ensureCatCache();
  const byNs = new Map();
  for (const r of records) {
    if (!r.namespace || !r.catalogItemId) continue;
    if (allow && !allow.has(r.namespace)) continue;
    const key = `${r.namespace}:${r.catalogItemId}`;
    if (out.has(key)) continue;
    const hit = cachedMeta(r.namespace, r.catalogItemId);
    if (hit) {
      out.set(key, hit);
      continue;
    }
    if (!byNs.has(r.namespace)) byNs.set(r.namespace, new Set());
    byNs.get(r.namespace).add(r.catalogItemId);
  }

  // 不同 namespace 互不依赖，但同一个域名并发太高只会互相排队，6 个刚好
  await pool([...byNs], 6, async ([ns, idsRaw]) => {
    const ids = [...idsRaw];
    // 每批最多 50 个，避免 URL 过长
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      // 账号地区与 CN 不一致时，目录接口可能取不到封面；再退回美区试一次
      let json = null;
      for (const [country, locale] of [['CN', 'zh-CN'], ['US', 'en-US']]) {
        const u = new URL(`${CATALOG}/${encodeURIComponent(ns)}/bulk/items`);
        u.searchParams.set('country', country);
        u.searchParams.set('locale', locale);
        for (const id of chunk) u.searchParams.append('id', id);
        try {
          const res = await fetch(u.toString(), {
            headers: auth(t),
            signal: AbortSignal.timeout(20000),
          });
          if (!res.ok) continue;
          const j = await readJson(res);
          if (j && Object.keys(j).length) {
            json = j;
            break;
          }
        } catch { /* 换下一个地区 */ }
      }
      try {
        for (const [id, item] of Object.entries(json || {})) {
          if (!item || typeof item !== 'object') continue;
          const imgs = Array.isArray(item.keyImages) ? item.keyImages : [];
          const pick = (type) => (imgs.find((x) => x && x.type === type && x.url) || {}).url;
          const anyImg = (imgs.find((x) => x && x.url) || {}).url || '';
          const img =
            pick('OfferImageTall') ||
            pick('DieselGameBoxTall') ||
            pick('Thumbnail') ||
            pick('DieselStoreFrontTall') ||
            pick('DieselGameBox') ||
            pick('OfferImageWide') ||
            pick('Featured') ||
            anyImg;
          const meta = {
            title: item.title || '',
            image: img ? String(img).replace(/^\/\//, 'https://') : '',
            type: item.productSlug ? '' : '',
            desc: String(item.description || '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 160),
          };
          out.set(`${ns}:${id}`, meta);
          catCache[`${ns}:${id}`] = { t: meta.title, i: meta.image, d: meta.desc, at: Date.now() };
        }
      } catch {
        /* 补信息失败不影响列表 */
      }
    }
  });
  saveCatCache(false);
  return out;
}

/**
 * 把库记录整理成界面条目。
 * onlyKnown=true 时跳过还没补到目录信息的记录（渐进加载阶段先只显示解析好的）。
 */
function buildItems(records, info, onlyKnown) {
  const seen = new Set();
  const items = [];
  for (const r of records) {
    if (!r || r.active === false) continue;
    const key = `${r.namespace}:${r.catalogItemId}`;
    if (seen.has(key)) continue;
    const meta = info.get(key) || null;
    if (onlyKnown && !meta) continue;
    seen.add(key);
    const title =
      (meta && meta.title) ||
      r.appName ||
      r.entitlementName ||
      (r.metadata && (r.metadata.entitlementName || r.metadata.appName)) ||
      String(r.catalogItemId || '').slice(0, 12);
    items.push({
      id: key,
      title,
      image: (meta && meta.image) || '',
      desc: (meta && meta.desc) || '',
      namespace: r.namespace || '',
      catalogItemId: r.catalogItemId || '',
      appName: r.appName || '',
      // 从库里点开商店页；没有 slug 就用搜索
      url: `https://store.epicgames.com/zh-CN/search?q=${encodeURIComponent(title)}`,
    });
  }
  items.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'));
  return items;
}

/**
 * @param {string} accountId
 * @param {{namespaces?: string[]}} [opts] 只补这些 namespace 的目录信息（判定是否拥有时用，能少发很多请求）
 * @param {(p:{items:Array,total:number,done:boolean})=>void} [onProgress] 渐进加载回调
 */
async function fetchLibrary(accountId, opts = {}, onProgress) {
  const t0 = Date.now();
  const { token, records } = await fetchRecords(accountId);
  const t1 = Date.now();
  const info = new Map();

  // 先用磁盘里已有的目录缓存铺一遍：重启后打开游戏库基本是秒出
  const allow = Array.isArray(opts.namespaces) && opts.namespaces.length
    ? new Set(opts.namespaces)
    : null;
  for (const r of records) {
    if (!r.namespace || !r.catalogItemId) continue;
    if (allow && !allow.has(r.namespace)) continue;
    const hit = cachedMeta(r.namespace, r.catalogItemId);
    if (hit) info.set(`${r.namespace}:${r.catalogItemId}`, hit);
  }
  const emit = (done) => {
    if (!onProgress) return;
    try {
      const items = buildItems(records, info, !done);
      onProgress({ items, total: items.length, done });
    } catch {
      /* 推送失败不影响最终返回 */
    }
  };
  emit(false);

  // 每 50 条记录补一批目录，补完就推一次，界面边等边出
  const CHUNK = 50;
  for (let i = 0; i < records.length; i += CHUNK) {
    await enrich(token, records.slice(i, i + CHUNK), opts.namespaces, info);
    if (i + CHUNK < records.length) emit(false);
  }

  const items = buildItems(records, info, false);
  saveCatCache(true);
  const t2 = Date.now();
  if (process.env.SD_TIMING) console.error(`[epic] records=${records.length} fetch=${t1 - t0}ms enrich=${t2 - t1}ms ns=${(opts.namespaces || []).length}`);
  emit(true);
  return { accountId, total: items.length, items, at: Date.now() };
}

/* --------------------------- 已拥有判定（领取用） --------------------------- */

// 判定「有没有买过」只看标题 + namespace。缓存按账号落盘：
// 打开免费页、重启软件都不必再等整库和目录接口跑完，只有手动刷新或领取后才重新拉。
const ownCache = new Map();
const OWN_TTL = 3 * 60 * 60 * 1000;
let diskLoaded = false;

function ownCacheFile() {
  try {
    const dir = store.baseDir;
    return dir ? path.join(dir, 'epic-owned-cache.json') : null;
  } catch {
    return null;
  }
}

function ensureDiskCache() {
  if (diskLoaded) return;
  diskLoaded = true;
  const file = ownCacheFile();
  if (!file) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, rec] of Object.entries(data || {})) {
      if (rec && rec.at && Array.isArray(rec.items)) ownCache.set(id, rec);
    }
  } catch {
    /* 没缓存或文件损坏：当作没有，用完会重写 */
  }
}

function saveDiskCache() {
  const file = ownCacheFile();
  if (!file) return;
  try {
    const data = Object.fromEntries(ownCache);
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 缓存写不进去不影响功能 */
  }
}

/** 标题归一化：去掉书名号、标点、空格，大小写不敏感 */
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[《》「」『』【】\[\]()（）:：\-–—_·,.，。!！?？'"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 只有"基础名 + 版本/资料片后缀"这种才可能是没买，别把 DLC 当成本体
const EDITION_RE = /版|包|dlc|季票|资料片|升级|扩展|edition|pack|pass|upgrade|bundle/i;

function titleHit(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length < 4 || !l.includes(s)) return false;
  return !EDITION_RE.test(l.replace(s, ' '));
}

/**
 * 免费条目的 offerId 与库里的 catalogItemId 不是同一个值，
 * 所以按「namespace + 标题」判定是否已经拥有。
 */
function offerOwned(rec, offer) {
  const ns = String((offer && offer.namespace) || '');
  return (rec.items || []).some(
    (i) =>
      (!ns || !i.namespace || ns === i.namespace) && titleHit(offer.title, i.title)
  );
}

async function ownedFor(accountId, opts = {}) {
  ensureDiskCache();
  const want = [...new Set((Array.isArray(opts.namespaces) ? opts.namespaces : []).filter(Boolean))];
  const hit = ownCache.get(accountId);
  const fresh = hit && hit.at && Date.now() - hit.at < OWN_TTL;
  const covered = hit && want.every((ns) => (hit.namespaces || []).includes(ns));
  if (!opts.force && fresh && (!want.length || covered)) return hit;

  // 只补免费条目所在的 namespace，而不是整库几百个条目逐个查目录
  const lib = await fetchLibrary(accountId, want.length ? { namespaces: want } : {});
  const prevItems = hit && Array.isArray(hit.items) ? hit.items : [];
  const prevNs = hit && Array.isArray(hit.namespaces) ? hit.namespaces : [];
  const items = want.length
    ? prevItems
        .filter((i) => !want.includes(i.namespace))
        .concat(lib.items.map((i) => ({ title: i.title, namespace: i.namespace })))
    : lib.items.map((i) => ({ title: i.title, namespace: i.namespace }));
  const rec = {
    at: Date.now(),
    total: lib.total,
    namespaces: want.length
      ? [...new Set(prevNs.concat(want))]
      : [...new Set(lib.items.map((i) => i.namespace).filter(Boolean))],
    items,
  };
  ownCache.set(accountId, rec);
  saveDiskCache();
  return rec;
}

/**
 * 给一批免费条目判定"哪个号已经拥有"。
 * @param {string[]|null} accountIds 不传则用所有参与领取的号
 * @param {Array<{offerId, namespace, title}>} offers
 */
async function matchOffers(accountIds, offers, opts = {}) {
  const list = (Array.isArray(offers) ? offers : []).filter((o) => o && o.offerId);
  let ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : [];
  if (!ids.length) {
    const st = await require('./epicClaim').list();
    ids = (st.accounts || []).filter((a) => a.enabled !== false).map((a) => a.accountId);
  }

  const owned = new Map();
  const per = [];
  // 多个号并行查，别一个等一个
  const namespaces = [...new Set(list.map((o) => o.namespace).filter(Boolean))];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const rec = await ownedFor(id, { ...opts, namespaces });
        per.push({ accountId: id, total: rec.total });
        for (const o of list) {
          if (!offerOwned(rec, o)) continue;
          if (!owned.has(o.offerId)) owned.set(o.offerId, []);
          owned.get(o.offerId).push(id);
        }
      } catch (e) {
        per.push({ accountId: id, error: e.message });
      }
    })
  );
  per.sort((a, b) => ids.indexOf(a.accountId) - ids.indexOf(b.accountId));
  return {
    accounts: per,
    owned: [...owned.entries()].map(([offerId, by]) => ({ offerId, accountIds: by })),
    at: Date.now(),
  };
}

module.exports = { fetchLibrary, matchOffers, ownedFor, offerOwned, titleHit };
