'use strict';

/**
 * GOG 已拥有游戏库
 *
 * GOG 没有给桌面端用的公开库接口，只有网页端在用的
 *   GET https://www.gog.com/account/getFilteredProducts?mediaType=1&page=N
 * 它认 Cookie，所以：
 *   1) 用一个内嵌窗口让用户登录 www.gog.com（Cookie 留在 persist:gog 分区）
 *   2) 之后所有请求都走 Electron 的 session.fetch，自动带上这份 Cookie
 */

const PARTITION = 'persist:gog';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LIB = 'https://www.gog.com/account/getFilteredProducts?mediaType=1&page=';

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

function sesFetch(url, init = {}) {
  const { session } = require('electron');
  const ses = session.fromPartition(PARTITION);
  if (ses && typeof ses.fetch === 'function') return ses.fetch(url, init);
  return fetch(url, init);
}

/**
 * GOG 图片常见写法是协议相对的 //images.gog.com/…；
 * 页面跑在 file:// 下会被解析成本地路径，必须补成 https。
 */
function absUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `https://www.gog.com${s}`;
  return s;
}

function headers(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

async function page(n) {
  const res = await sesFetch(LIB + n, {
    headers: headers(),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 403 || res.status === 401) {
    throw err('E_GOG_LOGIN', 'GOG 未登录或登录已过期，请重新登录');
  }
  if (!res.ok) throw err('E_GOG_HTTP', `GOG 返回 HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.products)) {
    throw err('E_GOG_PARSE', 'GOG 库返回格式不认识（可能改版了）');
  }
  return json;
}

async function status() {
  try {
    const j = await page(1);
    return { linked: true, total: Number(j.totalResults) || (j.products || []).length };
  } catch (e) {
    return { linked: false, error: e.code === 'E_GOG_LOGIN' ? '' : e.message };
  }
}

/** 打开 GOG 登录窗口；登录成功后自动关闭 */
function openLoginWindow(parent) {
  const { BrowserWindow } = require('electron');
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      parent: parent || undefined,
      title: '登录 GOG',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
      fn(arg);
    };

    // 登录完成后 Cookie 就有了，轮询库里第一页即可判断
    timer = setInterval(async () => {
      try {
        const st = await status();
        if (st.linked) finish(resolve, st);
      } catch { /* 继续等 */ }
    }, 2500);

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        if (timer) clearInterval(timer);
        reject(err('E_CANCELLED', '已关闭 GOG 登录窗口'));
      }
    });

    win.loadURL('https://www.gog.com/en/').catch((e) => finish(reject, err('E_GOG_LOAD', e.message)));
  });
}

/** 拉全部已拥有游戏（自动翻页） */
async function fetchLibrary() {
  const first = await page(1);
  const totalPages = Math.min(Number(first.totalPages) || 1, 40);
  const all = [...first.products];
  for (let n = 2; n <= totalPages; n++) {
    try {
      const j = await page(n);
      all.push(...j.products);
    } catch (e) {
      if (e.code === 'E_GOG_LOGIN') throw e;
      // 单页失败就停，已拿到的照常返回
      break;
    }
  }

  const seen = new Set();
  const items = [];
  for (const p of all) {
    const id = String(p.id || p.productId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String(p.title || '').trim();
    if (!title) continue;
    items.push({
      id: 'gog-' + id,
      title,
      image: absUrl(p.image || p.image_library || p.image_background || ''),
      desc: '',
      url: p.url ? `https://www.gog.com${p.url}` : 'https://www.gog.com/account',
      category: p.category || '',
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return { total: items.length, items, at: Date.now() };
}

/**
 * 领取当前 GOG 赠送（官方站内接口，认 Cookie）：
 *   GET https://www.gog.com/giveaway/claim
 * 成功后再访问会返回「已领取」，所以重复调用是安全的。
 */
async function claim() {
  const res = await sesFetch('https://www.gog.com/giveaway/claim', {
    headers: headers({ Accept: 'application/json, text/plain, */*' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw err('E_GOG_LOGIN', 'GOG 未登录，请先在游戏库的 GOG 页登录');
  }
  if (!res.ok) {
    return { ok: false, state: 'failed', message: `GOG 返回 HTTP ${res.status}` };
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 下面按纯文本判断 */ }

  if (json) {
    const word = String(json.status || json.message || json.result || '').toLowerCase();
    if (json.success === true || /^(ok|success|claimed)$/.test(word)) {
      return { ok: true, state: 'claimed', message: '已领取' };
    }
    if (/already|owned|claimed/i.test(word)) {
      return { ok: true, state: 'owned', message: '已在库中' };
    }
    return {
      ok: false,
      state: 'failed',
      message: String(json.message || json.status || 'GOG 没有返回可识别的结果').slice(0, 140),
    };
  }
  if (/^(ok|success)$/i.test(text.trim())) return { ok: true, state: 'claimed', message: '已领取' };
  if (/already|claimed/i.test(text)) return { ok: true, state: 'owned', message: '已在库中' };
  return { ok: false, state: 'failed', message: text.replace(/\s+/g, ' ').slice(0, 140) };
}

/** 退出：清掉 persist:gog 里的 Cookie；不影响 GOG 账号本身 */
async function logout() {
  libCache = null;
  const { session } = require('electron');
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData({ storages: ['cookies'] });
  } catch { /* ignore */ }
  return { ok: true };
}

/* --------------------------- 已拥有判定（领取用） --------------------------- */

let libCache = null; // { at, items }

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[《》「」『』【】\[\]()（）:：\-–—_·,.，。!！?？'"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

async function cachedLibrary(opts = {}) {
  if (!opts.force && libCache && Date.now() - libCache.at < 10 * 60 * 1000) return libCache;
  const lib = await fetchLibrary();
  libCache = { at: Date.now(), items: lib.items };
  return libCache;
}

/** 传入免费条目，返回已经拥有（库里标题能对上）的条目 id */
async function matchOffers(offers, opts = {}) {
  const list = (Array.isArray(offers) ? offers : []).filter((o) => o && o.id);
  const lib = await cachedLibrary(opts);
  return {
    owned: list
      .filter((o) => lib.items.some((i) => titleHit(o.title, i.title)))
      .map((o) => o.id),
    total: lib.items.length,
    at: lib.at,
  };
}

module.exports = { status, openLoginWindow, fetchLibrary, claim, logout, matchOffers };
