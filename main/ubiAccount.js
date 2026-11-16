'use strict';

/**
 * Ubisoft 账号游戏库（Ubiservices 公开 API，2026 版）
 *
 * ★ 登录通道（两条，主推官方窗口）★
 *   1. 官方登录窗口（loginWeb）：内嵌 connect.ubisoft.com 官方登录页，
 *      与玩家在浏览器登录官网完全同一页面（真浏览器指纹，DataDome 反爬天然放行，
 *      国内多数网络可直连，无需 Clash）。登录成功后官方会 302 到
 *      connect.ubisoft.com/change_domain/<JSON>，JSON 里带 ticket /
 *      rememberMeTicket / userId / sessionId（GOG Galaxy 育碧插件同款方案），
 *      主进程拦截该跳转即可拿到会话票据。
 *   2. 邮箱+密码直连（loginPassword）：POST public-ubiservices.ubi.com/v3/profiles/sessions
 *      （Basic 认证）。注意：2026 起该网关有 DataDome 反爬，纯接口请求可能被拦，
 *      被拦时错误信息会指向官方窗口登录。
 *
 * ★ 拉游戏库 ★
 *   POST /v1/profiles/me/uplay/graphql（Lutris 同款 AllGames 查询），
 *   返回 data.viewer.ownedGames.nodes[]（id / spaceId / name / coverUrl）。
 *   旧版用的 api-ubiservices.ubisoft.com/ownedgames 域名已不再解析（DNS 均无记录）。
 *
 * ★ 网络说明 ★
 *   正确的接口域名是 public-ubiservices.ubi.com（.ubi.com，国内多数网络直连可达，
 *   走 CloudFront 新加坡节点）；2.6.77 及之前用的 public-ubiservices.ice.ubisoft.com
 *   实测无 DNS 记录，这是此前「连不上育碧服务器」的根因。
 *   接口请求仍保留「登录窗口代理 → 系统代理 → 自动探测本机代理」三级兜底。
 *
 * 凭据只在本机使用：ticket / rememberMeTicket 写进 settings.ubiAccount，
 * 不存密码；rememberMeTicket 长期有效（约 90 天），票据过期自动用其续期。
 */

const { net, session, BrowserWindow, shell } = require('electron');
const store = require('./store');
const logger = require('./logger');

const API_HOST = 'https://public-ubiservices.ubi.com';
// Lutris（活跃维护的开源平台聚合器）使用的俱乐部应用标识
const CLUB_APPID = '82b650c0-6cb3-40c0-9f41-25a53b62b206';
const GENOME_ID = '42d07c95-9914-4450-8b38-267c4e462b21';
const LOGIN_URL = `https://connect.ubisoft.com/login?appId=${CLUB_APPID}&genomeId=${GENOME_ID}&lang=zh-cn&nextUrl=${encodeURIComponent('https://connect.ubisoft.com/ready')}`;
const UA_CONNECT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) UbisoftConnect/157.0 Core/1.55.0';
const PARTITION = 'persist:plat-ubisoft';

const GRAPHQL_QUERY = JSON.stringify({
  operationName: 'AllGames',
  variables: { owned: true },
  query: 'query AllGames {'
    + 'viewer {'
    + '    id'
    + '    ...ownedGamesList'
    + '  }'
    + '}'
    + 'fragment gameProps on Game {'
    + '  id'
    + '  spaceId'
    + '  name'
    + '  coverUrl'
    + '  backgroundUrl'
    + '  bannerUrl'
    + '}'
    + 'fragment ownedGameProps on Game {'
    + '  ...gameProps'
    + '  viewer {'
    + '    meta {'
    + '      id'
    + '      ownedPlatformGroups {'
    + '        id'
    + '        name'
    + '        type'
    + '      }'
    + '    }'
    + '  }'
    + '}'
    + 'fragment ownedGamesList on User {'
    + '  ownedGames: games(filterBy: {isOwned: true}) {'
    + '    totalCount'
    + '    nodes {'
    + '      ...ownedGameProps'
    + '    }'
    + '  }'
    + '}',
});

let apiSes = null;

async function getApiSession(proxy) {
  if (!apiSes) apiSes = session.fromPartition(PARTITION + '-api');
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
  return a && a.userId && (a.ticket || a.rememberMeTicket) ? a : null;
}

function saveAccount(a) {
  store.setSettings({ ubiAccount: a });
}

/** DataDome 反爬响应特征 */
function isCaptchaBody(text) {
  return /captcha-delivery|datadome|x-dd-b/i.test(String(text || ''));
}

/** 网络类错误的人话提示 */
function netErrMsg(e) {
  const raw = (e && e.message) || String(e || '');
  if (/NAME_NOT_RESOLVED|ERR_NAME|ERR_CONNECTION|TIMED_OUT|ERR_TIMED_OUT|Failed to fetch|reset|refused|aborted/i.test(raw)) {
    return '连不上育碧服务器（' + raw + '）。推荐用「打开育碧官方登录窗口」登录——和官网登录同一页面，国内多数网络可直连、无需 Clash；接口直连则需系统代理。';
  }
  return raw;
}

/** 从 URL 中解析登录票据（三种形态：change_domain/<JSON>、URL 片段 JSON、查询参数） */
function parseTicketUrl(raw) {
  const url = String(raw || '');
  if (!/rememberMeTicket|change_domain|"?ticket"?=/.test(url)) return null;
  // 形态①：connect.ubisoft.com/change_domain/<编码后的 JSON>（GOG Galaxy 同款）
  let m = url.match(/change_domain\/(.+)$/);
  if (m) {
    let payload = '';
    try { payload = decodeURIComponent(m[1]); } catch { payload = m[1]; }
    try {
      const arr = JSON.parse(payload.startsWith('[') ? payload : `[${payload}]`);
      if (Array.isArray(arr)) {
        const hit = arr.find((x) => x && (x.ticket || x.rememberMeTicket));
        if (hit) return hit;
      } else if (payload && typeof payload === 'object') {
        if (payload.ticket || payload.rememberMeTicket) return payload;
      }
    } catch { /* 继续尝试其他形态 */ }
  }
  // 形态②：URL 各段里形如 JSON 的片段（包括 URL 编码过的）
  for (const seg of url.split(/[/?&#]/)) {
    if (!seg || (!seg.includes('%7B') && !seg.includes('{'))) continue;
    try {
      const dec = decodeURIComponent(seg);
      const s = dec.startsWith('[') || dec.startsWith('{') ? dec : `[${dec}]`;
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        const hit = arr.find((x) => x && (x.ticket || x.rememberMeTicket));
        if (hit) return hit;
      } else if (arr && typeof arr === 'object' && (arr.ticket || arr.rememberMeTicket)) {
        return arr;
      }
    } catch { /* 试下一段 */ }
  }
  // 形态③：查询参数 ?ticket=...&rememberMeTicket=...&userId=...
  try {
    const q = new URL(url).searchParams;
    const ticket = q.get('ticket') || '';
    const rm = q.get('rememberMeTicket') || '';
    if (ticket || rm) {
      return {
        ticket,
        rememberMeTicket: rm,
        userId: q.get('userId') || '',
        sessionId: q.get('sessionId') || '',
        nameOnPlatform: q.get('nameOnPlatform') || q.get('username') || '',
      };
    }
  } catch { /* URL 非法则忽略 */ }
  return null;
}

/** 把解析出的票据保存为账号会话（loginWeb 与浏览器登录取票共用） */
async function saveAuth(auth, via) {
  const acc = {
    userId: String(auth.userId || ''),
    ticket: auth.ticket ? String(auth.ticket) : '',
    rememberMeTicket: auth.rememberMeTicket ? String(auth.rememberMeTicket) : '',
    sessionId: auth.sessionId ? String(auth.sessionId) : '',
    name: String(auth.nameOnPlatform || auth.username || ''),
    at: Date.now(),
    via,
  };
  saveAccount(acc);
  if (!acc.ticket && acc.rememberMeTicket) {
    try { await refreshTicket(); } catch (e) {
      logger.warn('Ubisoft rm_v1 换票失败（拉库时会重试）', { msg: String(e.message || e).slice(0, 160) });
    }
  }
  return { ok: true, name: (account() && account().name) || acc.name, userId: acc.userId };
}

/** 供用户在默认浏览器登录后回填地址，直接提取票据（绕开内嵌窗口被风控拦截的问题）
 *  背景：2026-11 实测部分家庭/机房出口 IP（如 120.242.40.60）被育碧 DataDome 拉黑，
 *  内嵌窗口怎么开都是「访问暂时受限」；但用户自己的浏览器有 Cookie/指纹信任能正常登。
 *  登录成功后地址栏 URL（change_domain/... 或 ready?rememberMeTicket=...）带票据，
 *  复制粘贴回来即可完成会话提取。 */
function openBrowserLogin() {
  return shell.openExternal(LOGIN_URL);
}

async function loginFromUrl(rawUrl) {
  const auth = parseTicketUrl(rawUrl);
  if (!auth) {
    throw new Error('这个网址里没有登录票据：请复制「登录成功后浏览器地址栏」的完整网址（会包含 change_domain 或 rememberMeTicket 字样）；若登录后地址栏已经变成普通页面，请重新登录一次并在跳转完成瞬间复制。');
  }
  logger.info('Ubisoft 浏览器取票登录成功', { userId: auth.userId });
  return saveAuth(auth, 'browser');
}

/** 官方登录窗口：内嵌 connect.ubisoft.com 官方页面，拦截 change_domain 跳转拿票据 */
async function loginWeb(parent) {
  // ① 先把分区切到直连，并等它真正生效——否则窗口打开瞬间的请求仍会走系统代理（Clash 机房 IP）→ 被育碧风控
  const ses = session.fromPartition(PARTITION);
  try { await ses.setProxy({ mode: 'direct' }); } catch { /* ignore */ }
  // ② 只清「会话类」Cookie（UserID/sid/Ubi-Webauth 等，避免上次登录态干扰），
  //    保留 DataDome / ubid_main / 同意类 Cookie——它们携带反爬信任，清掉会让每次登录都重新被风控考核
  try {
    const cookies = await ses.cookies.get({});
    const SESSION_RE = /^(UserID|Ubi-Webauth|twoStepSid)$/i;
    for (const c of cookies) {
      if (!SESSION_RE.test(c.name)) continue;
      const dom = String(c.domain || '').replace(/^\./, '');
      if (dom.endsWith('ubisoft.com') || dom.endsWith('ubi.com')) {
        await ses.cookies.remove(`https://${dom}${c.path || '/'}`, c.name).catch(() => {});
      }
    }
  } catch { /* ignore */ }

  return new Promise((resolve, reject) => {
    let settled = false;
    let poll = null;
    let win = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch { /* ignore */ }
      fn(arg);
    };

    try {
      win = new BrowserWindow({
        width: 500,
        height: 720,
        parent: parent || undefined,
        title: '登录 Ubisoft（官方页面）',
        autoHideMenuBar: true,
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
    } catch (e) {
      finish(reject, e);
      return;
    }

    // 加载失败时把具体错误显示给用户（方便排查，而不是白屏）
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (settled || code === -3) return; // -3 = ABORTED（导航中断，如重定向）
      finish(reject, Object.assign(new Error(`育碧官方登录页加载失败（${desc || code}）${url ? '：' + String(url).slice(0, 80) : ''}`), { code: 'E_LOAD' }));
    });

    /** 从 URL 中解析登录票据（模块级函数，与浏览器取票共用） */
    const parseLocal = parseTicketUrl;

    const handleUrl = async (raw) => {
      const auth = parseLocal(raw);
      if (!auth) return;
      logger.info('Ubisoft 官方窗口登录成功', { userId: auth.userId, hasTicket: !!auth.ticket });
      finish(resolve, await saveAuth(auth, 'web'));
    };

    win.webContents.on('will-navigate', (_e, url) => { handleUrl(url); });
    win.webContents.on('did-navigate', (_e, url) => { handleUrl(url); });
    win.webContents.on('did-navigate-in-page', (_e, url) => { handleUrl(url); });
    // 风控页检测：页面没有登录表单（邮箱/密码输入框）且出现风控文案 → 注入提示条但不关窗。
    // 注意不能用标题判断是否登录页：DataDome 风控页的标题仍然是「登录 | Ubisoft WebAuth」。
    win.webContents.on('did-finish-load', () => {
      try {
        if (settled || win.isDestroyed()) return;
        win.webContents.executeJavaScript(`(function(){
          var t = (document.body && document.body.innerText) || '';
          var captcha = /访问暂时受限|我不是机器人|are you a robot|robot check|unusual traffic/i.test(t);
          var hasForm = !!document.querySelector('input[type=email],input[type=password]');
          return captcha && !hasForm;
        })()`, true)
          .then((needBanner) => {
            if (!needBanner || settled) return;
            logger.warn('育碧窗口命中风控页，注入提示（不关窗）');
            win.webContents.executeJavaScript(`(
              function(){
                if (document.getElementById('sdnet-notice')) return 0;
                var d = document.createElement('div');
                d.id = 'sdnet-notice';
                d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b45309;color:#fff;font:12px/1.5 system-ui,sans-serif;padding:9px 12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer';
                d.textContent = '⚠ 育碧风控拦截了当前网络出口（共享/机房 IP 常见）。若本页有「我不是机器人」验证，完成后可继续登录；若没有验证入口，请关闭本窗，改用弹窗里的「用我的浏览器登录」按钮（在你能正常登录育碧的浏览器里完成后，把地址栏网址粘贴回来）。点此关闭提示。';
                d.onclick = function(){ d.remove(); };
                (document.body || document.documentElement).appendChild(d);
                return 1;
              }
            )()`, true).catch(() => {});
          })
          .catch(() => {});
      } catch { /* ignore */ }
    });
    poll = setInterval(() => {
      try {
        if (!win.isDestroyed()) handleUrl(win.webContents.getURL());
      } catch { /* ignore */ }
    }, 700);

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        if (poll) clearInterval(poll);
        reject(Object.assign(new Error('已关闭 Ubisoft 登录窗口'), { code: 'E_CANCELLED' }));
      }
    });

    win.loadURL(LOGIN_URL).catch((e) => {
      const raw = (e && e.message) || String(e || '加载失败');
      const hint = /NAME_NOT_RESOLVED|ERR_NAME|TIMED_OUT|ERR_CONNECTION|refused/i.test(raw)
        ? `育碧官方登录页打不开（${raw}）。请开启系统代理（Clash / v2rayN）或在「设置 → 登录窗口代理」填好代理端口后重试。`
        : `育碧官方登录页打开失败：${raw}`;
      finish(reject, Object.assign(new Error(hint), { code: 'E_LOAD' }));
    });
  });
}

/** 邮箱+密码登录（接口直连）。2FA 账号返回 { need2fa: true, raw }。 */
async function loginPassword(email, password) {
  const basic = Buffer.from(`${String(email || '')}:${String(password || '')}`).toString('base64');
  let res;
  try {
    res = await ubiFetch(`${API_HOST}/v3/profiles/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Ubi-AppId': CLUB_APPID,
        'Ubi-RequestedPlatformType': 'uplay',
        Authorization: `Basic ${basic}`,
        'User-Agent': UA_CONNECT,
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

  if (isCaptchaBody(text)) {
    throw new Error('育碧接口的反爬拦截了这次直连登录（DataDome 验证）。请点「打开育碧官方登录窗口」，用官方页面登录即可（和官网登录完全一样，无需代理）。');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(json && json.message ? String(json.message) : '邮箱或密码不正确');
  }
  if (!res.ok) {
    if (json && (json.twoFactorAuthenticationTicket || json.twoFa || /two.?factor|2fa/i.test(text))) {
      return { need2fa: true, raw: json };
    }
    throw new Error(`育碧接口返回 HTTP ${res.status}${json && json.message ? '：' + json.message : ''}`);
  }
  if (json && json.twoFactorAuthenticationTicket) {
    // 2FA 票据存起来，提交验证码时要用
    twoFaTicket = json.twoFactorAuthenticationTicket;
    return { need2fa: true, raw: json };
  }
  if (!json || !json.ticket || !json.userId) {
    throw new Error('育碧登录返回异常（缺少 ticket），可能接口已调整，请反馈日志');
  }
  saveAccount({
    userId: String(json.userId),
    ticket: String(json.ticket),
    sessionId: json.sessionId ? String(json.sessionId) : '',
    rememberMeTicket: json.rememberMeTicket ? String(json.rememberMeTicket) : '',
    name: json.nameOnPlatform || json.username || email,
    at: Date.now(),
    via: 'password',
  });
  return { ok: true, userId: String(json.userId) };
}

let twoFaTicket = '';

/** 提交 2FA 验证码 */
async function login2fa(code) {
  const body = twoFaTicket
    ? { twoFactorAuthenticationTicket: twoFaTicket, code: String(code || ''), rememberMe: true }
    : { rememberMe: true };
  let res;
  try {
    res = await ubiFetch(`${API_HOST}/v3/profiles/sessions/2fa/${encodeURIComponent(String(code || ''))}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Ubi-AppId': CLUB_APPID,
        'Ubi-RequestedPlatformType': 'uplay',
        ...(twoFaTicket ? { 'Ubi-2FATicket': twoFaTicket } : {}),
        'User-Agent': UA_CONNECT,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(netErrMsg(e));
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* ignore */ }
  if (isCaptchaBody(text)) {
    throw new Error('育碧接口的反爬拦截了验证码提交（DataDome）。请改用「打开育碧官方登录窗口」，官方页面会自己处理两步验证。');
  }
  if (!res.ok) {
    throw new Error(`两步验证提交失败（HTTP ${res.status}）：${(json && json.message) || text.slice(0, 160)}`);
  }
  if (!json || !json.ticket) throw new Error('两步验证后未拿到会话，接口可能已调整，请反馈日志');
  twoFaTicket = '';
  saveAccount({
    userId: String(json.userId || (account() && account().userId) || ''),
    ticket: String(json.ticket),
    sessionId: json.sessionId ? String(json.sessionId) : '',
    rememberMeTicket: json.rememberMeTicket ? String(json.rememberMeTicket) : '',
    name: (json.nameOnPlatform || (account() && account().name) || '').toString(),
    at: Date.now(),
    via: '2fa',
  });
  return { ok: true, userId: json.userId };
}

/** 用现有票据/rememberMeTicket 续期会话 */
async function refreshTicket() {
  const acc = account();
  if (!acc) throw new Error('未登录');
  const auth = acc.ticket ? `Ubi_v1 t=${acc.ticket}` : `rm_v1 t=${acc.rememberMeTicket}`;
  let res;
  try {
    res = await ubiFetch(`${API_HOST}/v3/profiles/sessions`, {
      method: acc.ticket ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Ubi-AppId': CLUB_APPID,
        'Ubi-RequestedPlatformType': 'uplay',
        Authorization: auth,
        'User-Agent': UA_CONNECT,
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
  if (isCaptchaBody(text)) throw new Error('育碧接口反爬拦截（DataDome），请重新用官方窗口登录');
  if (!res.ok || !json || !json.ticket) {
    throw new Error(`票据续期失败（HTTP ${res.status}）`);
  }
  saveAccount({
    ...acc,
    userId: String(json.userId || acc.userId),
    ticket: String(json.ticket),
    sessionId: json.sessionId ? String(json.sessionId) : (acc.sessionId || ''),
    rememberMeTicket: json.rememberMeTicket ? String(json.rememberMeTicket) : (acc.rememberMeTicket || ''),
    at: Date.now(),
  });
  return true;
}

/** 退出：清掉本机保存的会话 */
function logoutAccount() {
  store.setSettings({ ubiAccount: null });
  libCache = null;
  return { ok: true };
}

/* ------------------------------- 账号游戏库 ------------------------------- */

const LIB_TTL = 6 * 3600 * 1000;
let libCache = null;

/** 拉账号拥有的全部游戏（GraphQL AllGames，6 小时缓存） */
async function fetchLibrary(force) {
  const acc = account();
  if (!acc) return { loggedIn: false, items: [] };
  if (!force && libCache && Date.now() - libCache.at < LIB_TTL) {
    return { loggedIn: true, items: libCache.items, fromCache: true };
  }

  // 票据缺失（比如官方窗口只给到 rememberMeTicket）先续一次
  if (!acc.ticket && acc.rememberMeTicket) {
    try { await refreshTicket(); } catch { /* 拉库时会带错误返回 */ }
  }

  const run = async () => {
    const cur = account();
    return ubiFetch(`${API_HOST}/v1/profiles/me/uplay/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Ubi-AppId': CLUB_APPID,
        Authorization: `Ubi_v1 t=${cur.ticket}`,
        ...(cur.sessionId ? { 'Ubi-SessionId': cur.sessionId } : {}),
        'User-Agent': UA_CONNECT,
      },
      body: GRAPHQL_QUERY,
    });
  };

  let res;
  try {
    res = await run();
  } catch (e) {
    throw new Error(netErrMsg(e));
  }
  let text = await res.text();

  // 票据过期：续期后重试一次
  if (res.status === 401) {
    try {
      await refreshTicket();
      res = await run();
      text = await res.text();
    } catch (e) {
      return { loggedIn: false, expired: true, items: [], message: String(e.message || e) };
    }
  }
  if (isCaptchaBody(text)) {
    throw new Error('育碧接口的反爬拦截了游戏库请求（DataDome）。稍后重试，或重新用「官方登录窗口」登录一次。');
  }
  if (!res.ok) {
    throw new Error(`育碧库接口返回 HTTP ${res.status}${text.slice(0, 120)}`);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('育碧库接口返回非 JSON，接口可能已调整，请反馈日志');
  }
  const nodes = json && json.data && json.data.viewer && json.data.viewer.ownedGames && Array.isArray(json.data.viewer.ownedGames.nodes)
    ? json.data.viewer.ownedGames.nodes
    : [];
  const items = nodes
    .map((g) => ({
      appId: Number(g.spaceId || g.id) || 0,
      title: String(g.name || `Space ${g.spaceId || g.id || ''}`).trim(),
      image: String(g.coverUrl || g.backgroundUrl || g.bannerUrl || ''),
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
    loggedIn: !!(acc && acc.ticket),
    userId: acc ? acc.userId : '',
    name: acc ? acc.name : '',
    via: acc ? acc.via : '',
    at: acc ? acc.at : 0,
    hasRemember: !!(acc && acc.rememberMeTicket),
  };
}

module.exports = { loginPassword, login2fa, loginWeb, loginFromUrl, openBrowserLogin, logoutAccount, fetchLibrary, refreshTicket, status, account };
