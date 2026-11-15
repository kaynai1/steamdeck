'use strict';

/**
 * 暴雪战网账号游戏库（account.battle.net 非官方接口）
 *
 * ★ 背景 ★
 * 暴雪没有公开的「我的游戏」API（官方 Battle.net 开发者接口只有游戏数据、
 * 没有账号游戏清单）。但 account.battle.net/games 页面背后有一个 JSON 接口：
 *   GET https://account.battle.net/api/games-and-subs
 * 带登录会话 Cookie + XSRF 头就能返回账号拥有的全部游戏
 * （gameAccounts / classicGames / modernGames / consoleGames 四段）。
 * 开源参考：Ogrods/BAKLOG（github.com/Ogrods/BAKLOG，2026 活跃维护）。
 *
 * ★ 本软件的做法 ★
 * 用户先在「账号管理 / 游戏库」用内嵌官方窗口登录 battle.net
 * （main/platformLogin.js，Cookie 存在 persist:plat-blizzard 分区），
 * 之后直接用该分区会话请求 games-and-subs：Cookie 自动携带，
 * XSRF-TOKEN Cookie 原样回填到 X-XSRF-TOKEN 头（双提交校验）。
 * 网络走 Chromium 栈（net.fetch + 分区会话），battle.net 国内直连可达。
 *
 * 凭据说明：本模块只读分区里的 Cookie，不保存也不导出任何凭据。
 */

const { net, session } = require('electron');
const logger = require('./logger');

const PARTITION = 'persist:plat-blizzard';
const GAMES_API = 'https://account.battle.net/api/games-and-subs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_MIN_LEN = 24;

const LIB_TTL = 6 * 3600 * 1000;
let libCache = null;

function getSession() {
  return session.fromPartition(PARTITION);
}

async function battleCookies() {
  const ses = getSession();
  return ses.cookies.get({ domain: 'battle.net' }).catch(() => []);
}

/** 登录态：分区里存在足够长的会话类 Cookie（与 platformLogin 同标准） */
async function loggedIn() {
  const cookies = await battleCookies();
  return cookies.some((c) => /token|session|auth/i.test(c.name) && String(c.value || '').length >= COOKIE_MIN_LEN);
}

/** 清理暴雪标题里的商标符号与多余空白 */
function cleanName(raw) {
  return String(raw || '')
    .replace(/[®™©]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim();
}

function pick(item, keys) {
  for (const k of keys) {
    const v = item[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

/** 解析 games-and-subs 响应（四段合并 + 按名字去重） */
function parseGames(json) {
  const sections = ['gameAccounts', 'classicGames', 'modernGames', 'consoleGames'];
  const seen = new Set();
  const items = [];
  if (!json || typeof json !== 'object') return items;
  for (const sec of sections) {
    const arr = Array.isArray(json[sec]) ? json[sec] : [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const title = cleanName(pick(it, ['localizedGameName', 'title', 'displayName', 'name']));
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const lastMs = Number(it.lastPlayedDateMillis) || 0;
      items.push({
        appId: String(pick(it, ['titleId', 'productId', 'id']) || title),
        title,
        image: '',
        lastPlayed: lastMs > 0 ? lastMs : 0,
        status: String(it.gameAccountStatus || ''),
        platform: '暴雪战网',
      });
    }
  }
  return items;
}

/** 探测会话真伪：games-and-subs 返回 200 才算已登录（10 秒缓存） */
let verifyCache = { at: 0, result: null };
async function verifySession() {
  if (verifyCache.result && Date.now() - verifyCache.at < 10000) return verifyCache.result;
  let result = { ok: false, loggedIn: false };
  try {
    const ses = getSession();
    const cookies = await battleCookies();
    const xsrf = cookies.find((c) => c.name === 'XSRF-TOKEN');
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://account.battle.net/games',
      'User-Agent': UA,
    };
    if (xsrf) {
      try { headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf.value); } catch { headers['X-XSRF-TOKEN'] = xsrf.value; }
    }
    const res = await net.fetch(GAMES_API, { headers, session: ses });
    result = { ok: true, loggedIn: res.status === 200 };
  } catch {
    result = { ok: false, loggedIn: false };
  }
  verifyCache = { at: Date.now(), result };
  return result;
}

/** 拉账号拥有的全部游戏（games-and-subs，6 小时缓存） */
async function fetchLibrary(force) {
  if (!force && libCache && Date.now() - libCache.at < LIB_TTL) {
    return { ...libCache.result, fromCache: true };
  }
  if (!(await loggedIn())) return { loggedIn: false, items: [] };

  const ses = getSession();
  const cookies = await battleCookies();
  const xsrf = cookies.find((c) => c.name === 'XSRF-TOKEN');
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://account.battle.net/games',
    'User-Agent': UA,
  };
  if (xsrf) {
    try { headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf.value); } catch { headers['X-XSRF-TOKEN'] = xsrf.value; }
  }

  let res;
  try {
    res = await net.fetch(GAMES_API, { headers, session: ses });
  } catch (e) {
    throw new Error(`连不上暴雪账号接口（${(e && e.message) || e}）。account.battle.net 国内一般可直连；若失败可开系统代理后重试。`);
  }
  if (res.status === 401 || res.status === 403) {
    libCache = null;
    return { loggedIn: false, expired: true, items: [] };
  }
  if (!res.ok) {
    throw new Error(`暴雪账号接口返回 HTTP ${res.status}（非官方接口偶尔抽风，稍后再试）`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error('暴雪账号接口返回非 JSON，会话可能过期，请重新登录战网');
  }
  const items = parseGames(json);
  if (!items.length) {
    logger.warn('暴雪 games-and-subs 返回了空清单', { keys: Object.keys(json || {}).join(',') });
  }
  const result = { loggedIn: true, items };
  libCache = { at: Date.now(), result };
  logger.info('暴雪账号库已更新', { count: items.length });
  return { ...result, fromCache: false };
}

/** 退出：清 Cookie（复用 platformLogin）+ 清缓存 */
async function logout() {
  libCache = null;
  verifyCache = { at: 0, result: null };
  const pl = require('./platformLogin');
  return pl.logout('blizzard');
}

function clearCache() {
  libCache = null;
  verifyCache = { at: 0, result: null };
}

module.exports = { fetchLibrary, loggedIn, verifySession, logout, clearCache };
