'use strict';

/**
 * Ubisoft 账号游戏库（Ubiservices 公开 API）
 *
 * ★ 怎么拿到「我账号里的游戏」★
 * Ubisoft Connect 客户端背后是一组公开 HTTPS 接口（public-ubiservices）：
 *   1. POST /v3/profiles/sessions        —— 邮箱+密码（Basic 认证）换会话 ticket
 *      开了两步验证的账号会返回 2FA 票据，需要再提交一次验证码
 *   2. GET  /v1/profiles/{userId}/ownedgames —— 带 ticket 列出账号拥有的全部游戏
 *
 * 凭据只在本机使用：ticket 与账号信息写进 settings.ubiAccount（不存密码——
 * 密码只在登录当次请求里出现，随后丢弃；ticket 有效期约 90 天，过期重新登录）。
 *
 * ★ 网络说明 ★
 * public-ubiservices.ice.ubisoft.com 在国内多数网络直连不通（与 Steam 社区一个待遇），
 * 请求走 Chromium 网络栈并按「登录窗口代理 → Windows 系统代理 → 自动探测本机代理」
 * 三级策略取代理，探测到可用代理会自动记住。
 *
 * 实现于 2.6.76；若 Ubisoft 调整接口字段（2FA 流程尤其可能变），
 * 日志里会有完整错误返回，反馈给开发者即可快速修正。
 */

const { net, session } = require('electron');
const store = require('./store');
const logger = require('./logger');

const API_HOST = 'https://public-ubiservices.ice.ubisoft.com';
const OWNED_HOST = 'https://api-ubiservices.ubisoft.com';
const UBI_APP_ID = 'c6e3563a-386b-45fc-93a1-1c39b220c4b7';

let apiSes = null;

async function getApiSession(proxy) {
  if (!apiSes) apiSes = session.fromPartition('persist:plat-ubisoft-api');
  try {
    if (proxy) await apiSes.setProxy({ mode: 'fixed_servers', proxyRules: proxy });
    else await apiSes.setProxy({ mode: 'system' });
  } catch { /* 失败跟随默认 */ }
  return apiSes;
}

/** 三级代理策略下的 net.fetch（与更新下载同款） */
async function ubiFetch(url, opts = {}) {
  const configured = String(store.getSettings().loginProxy || '').trim();
  const ses = await getApiSession(configured || undefined);
  try {
    return await net.fetch(url, { ...opts, session: ses });
  } catch (e) {
    if (configured) throw e; // 已配置代理还不通：按原错误抛
    // 自动探测本机代理重试一次
    let det = null;
    try {
      det = await require('./proxyDetect').detectProxy();
    } catch { /* ignore */ }
    if (det && det.found) {
      const ses2 = await getApiSession(det.proxy);
      try {
        const res = await net.fetch(url, { ...opts, session: ses2 });
        try {
          store.setSettings({ loginProxy: det.proxy });
        } catch { /* ignore */ }
        logger.info('Ubisoft 接口自动启用本机代理', { proxy: det.proxy });
        return res;
      } catch (e2) {
        throw e2;
      }
    }
    throw e;
  }
}

/* ------------------------------- 账号会话 ------------------------------- */

function account() {
  const a = store.getSettings().ubiAccount;
  return a && a.userId && a.ticket
    ? a
    : null;
}

function saveAccount(a) {
  store.setSettings({ ubiAccount: a });
}

/** 网络类错误的人话提示：育碧接口域名国内直连不通是常态，指向代理设置 */
function netErrMsg(e) {
  const raw = (e && e.message) || String(e || '');
  if (/NAME_NOT_RESOLVED|ERR_NAME|ERR_CONNECTION|TIMED_OUT|ERR_TIMED_OUT|Failed to fetch|reset|refused|aborted/i.test(raw)) {
    return '连不上育碧服务器（' + raw + '）。育碧接口域名国内直连不通是常态，需要代理才能登录：① 开启 Clash / v2rayN 并打开「系统代理」；② 或在软件「设置 → 登录窗口代理」里填代理端口（如 127.0.0.1:7890）；配置好后重新点「登录」。（UU 加速器是进程级、只加速 Steam 客户端，对育碧接口无效）';
  }
  return raw;
}

/** 邮箱+密码登录。2FA 账号返回 { need2fa: true, raw }，等待验证码提交。 */
async function loginPassword(email, password) {
  const basic = Buffer.from(`${String(email || '')}:${String(password || '')}`).toString('base64');
  let res;
  try {
    res = await ubiFetch(`${API_HOST}/v3/profiles/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ubi-AppId': UBI_APP_ID,
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({ rememberMe: true }),
    });
  } catch (e) {
    throw new Error(netErrMsg(e));
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 非结构化响应按文本处理 */ }

  if (res.status === 401 || res.status === 403) {
    throw new Error(json && json.message ? String(json.message) : '邮箱或密码不正确');
  }
  if (!res.ok) {
    // 2FA 相关错误通常带特殊错误码/票据字段
    if (json && (json.twoFactorAuthenticationTicket || json.twoFa || /two.?factor|2fa/i.test(text))) {
      return { need2fa: true, raw: json };
    }
    throw new Error(`育碧接口返回 HTTP ${res.status}${json && json.message ? '：' + json.message : ''}`);
  }
  if (json && json.twoFactorAuthenticationTicket) {
    return { need2fa: true, raw: json };
  }
  if (!json || !json.ticket || !json.userId) {
    throw new Error('育碧登录返回异常（缺少 ticket），可能接口已调整，请反馈日志');
  }
  saveAccount({
    userId: String(json.userId),
    ticket: String(json.ticket),
    name: json.nameOnPlatform || json.username || email,
    at: Date.now(),
    via: 'password',
  });
  return { ok: true, userId: String(json.userId) };
}

/** 提交 2FA 验证码（ Ubisoft 常见路径 /v3/profiles/sessions/2fa/ ；
 *  不同时期字段不同，失败时把原始返回带回来便于修正） */
async function login2fa(code) {
  let res;
  try {
    res = await ubiFetch(`${API_HOST}/v3/profiles/sessions/2fa/${encodeURIComponent(String(code || ''))}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ubi-AppId': UBI_APP_ID,
      },
      body: JSON.stringify({ rememberMe: true }),
    });
  } catch (e) {
    throw new Error(netErrMsg(e));
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`两步验证提交失败（HTTP ${res.status}）：${(json && json.message) || text.slice(0, 160)}`);
  }
  if (!json || !json.ticket) throw new Error('两步验证后未拿到会话，接口可能已调整，请反馈日志');
  saveAccount({
    userId: String(json.userId || (account() && account().userId) || ''),
    ticket: String(json.ticket),
    name: (json.nameOnPlatform || (account() && account().name) || '').toString(),
    at: Date.now(),
    via: '2fa',
  });
  return { ok: true, userId: json.userId };
}

/** 退出：清掉本机保存的会话 */
function logoutAccount() {
  store.setSettings({ ubiAccount: null });
  return { ok: true };
}

/* ------------------------------- 账号游戏库 ------------------------------- */

const LIB_TTL = 6 * 3600 * 1000;
let libCache = null;

/** 拉账号拥有的全部游戏（ownedgames，走代理 + 6 小时缓存） */
async function fetchLibrary(force) {
  const acc = account();
  if (!acc) return { loggedIn: false, items: [] };
  if (!force && libCache && Date.now() - libCache.at < LIB_TTL) return { loggedIn: true, items: libCache.items, fromCache: true };

  let res;
  try {
    res = await ubiFetch(`${OWNED_HOST}/v1/profiles/${acc.userId}/ownedgames?locale=zh-CN`, {
      headers: {
        'Ubi-AppId': UBI_APP_ID,
        Authorization: `Ubi_v1 t=${acc.ticket}`,
      },
    });
  } catch (e) {
    throw new Error(netErrMsg(e));
  }
  if (res.status === 401) {
    // ticket 过期：提示重新登录
    return { loggedIn: false, expired: true, items: [] };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`育碧库接口返回 HTTP ${res.status}${text.slice(0, 120)}`);
  }
  const json = await res.json();
  const raw = Array.isArray(json) ? json : json && json.games ? json.games : json && json.ownedGames ? json.ownedGames : [];
  const items = (Array.isArray(raw) ? raw : [])
    .map((g) => ({
      appId: Number(g.gameId || g.appId || g.id) || 0,
      title: String(g.name || g.title || g.spaceName || `App ${g.gameId || ''}`).trim(),
      image: g.imageUrl || g.image || '',
      platform: 'Ubisoft',
    }))
    .filter((g) => g.title);
  libCache = { at: Date.now(), items };
  logger.info('育碧账号库已更新', { count: items.length });
  return { loggedIn: true, items, fromCache: false };
}

function status() {
  const acc = account();
  return {
    loggedIn: !!acc,
    userId: acc ? acc.userId : '',
    name: acc ? acc.name : '',
    via: acc ? acc.via : '',
    at: acc ? acc.at : 0,
  };
}

module.exports = { loginPassword, login2fa, logoutAccount, fetchLibrary, status, account };
