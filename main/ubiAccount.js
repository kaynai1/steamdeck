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

const { net, session, BrowserWindow } = require('electron');
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

/** 官方登录窗口：内嵌 connect.ubisoft.com 官方页面，拦截 change_domain 跳转拿票据 */
async function loginWeb(parent) {
  // ① 先把分区切到直连，并等它真正生效——否则窗口打开瞬间的请求仍会走系统代理（Clash 机房 IP）→ 被育碧风控
  const ses = session.fromPartition(PARTITION);
  try { await ses.setProxy({ mode: 'direct' }); } catch { /* ignore */ }
  // ② 清掉该分区上之前的育碧 Cookie：DataDome 风控 Cookie 会“记住”上次被判机器人的状态，不清会继续弹"访问暂时受限"
  try {
    const cookies = await ses.cookies.get({});
    for (const c of cookies) {
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

    /** 从 URL 中解析登录票据 JSON */
    const parseTicketUrl = (raw) => {
      const url = String(raw || '');
      if (!url.includes('rememberMeTicket') && !url.includes('change_domain')) return null;
      let payload = '';
      const m = url.match(/change_domain\/(.+)$/);
      if (m) {
        try { payload = decodeURIComponent(m[1]); } catch { payload = m[1]; }
        try {
          const arr = JSON.parse(payload.startsWith('[') ? payload : `[${payload}]`);
          if (Array.isArray(arr)) return arr.find((x) => x && (x.ticket || x.rememberMeTicket)) || null;
        } catch { /* 继续尝试其他形态 */ }
      }
      // 兜底：URL 各段里找形如 JSON 的片段
      for (const seg of url.split(/[/?&#]/)) {
        if (!seg || (!seg.includes('%7B') && !seg.includes('{'))) continue;
        try {
          const dec = decodeURIComponent(seg);
          const s = dec.startsWith('[') || dec.startsWith('{') ? dec : `[${dec}]`;
          const arr = JSON.parse(s);
          if (Array.isArray(arr)) return arr.find((x) => x && (x.ticket || x.rememberMeTicket)) || null;
          if (arr && (arr.ticket || arr.rememberMeTicket)) return arr;
        } catch { /* 试下一段 */ }
      }
      return null;
    };

    const handleUrl = async (raw) => {
      const auth = parseTicketUrl(raw);
      if (!auth) return;
      logger.info('Ubisoft 官方窗口登录成功', { userId: auth.userId, hasTicket: !!auth.ticket });
      const acc = {
        userId: String(auth.userId || ''),
        ticket: auth.ticket ? String(auth.ticket) : '',
        rememberMeTicket: auth.rememberMeTicket ? String(auth.rememberMeTicket) : '',
        sessionId: auth.sessionId ? String(auth.sessionId) : '',
        name: String(auth.nameOnPlatform || auth.username || ''),
        at: Date.now(),
        via: 'web',
      };
      saveAccount(acc);
      // 只有 rememberMeTicket 时立刻换一张正式会话票据（失败不阻塞，拉库时会再试）
      if (!acc.ticket && acc.rememberMeTicket) {
        try { await refreshTicket(); } catch (e) {
          logger.warn('Ubisoft rm_v1 换票失败（拉库时会重试）', { msg: String(e.message || e).slice(0, 160) });
        }
      }
      finish(resolve, { ok: true, name: (account() && account().name) || acc.name, userId: acc.userId });
    };

    win.webContents.on('will-navigate', (_e, url) => { handleUrl(url); });
    win.webContents.on('did-navigate', (_e, url) => { handleUrl(url); });
    win.webContents.on('did-navigate-in-page', (_e, url) => { handleUrl(url); });
    // 风控页检测：育碧反爬拦截时页面显示「访问暂时受限 / 我不是机器人」，直接给出人话指引
    win.webContents.on('did-finish-load', () => {
      try {
        if (win.isDestroyed()) return;
        win.webContents.executeJavaScript(`(document.title||'')+'|'+((document.body&&document.body.innerText)||'').slice(0,400)`)
          .then((t) => {
            const s = String(t || '');
            const isCaptcha = /访问暂时受限|我不是机器人|are you a robot|robot check/i.test(s);
            const isLoginPage = /Ubisoft WebAuth|WebAuth|登录 创建账号/i.test(s);
            if (isCaptcha && !isLoginPage) {
              finish(reject, Object.assign(new Error('育碧风控把当前网络识别成了机器人访问（出口 IP 多为代理/加速器的机房 IP，例如香港节点）。请完全退出 Clash / v2rayN（包括系统代理和 TUN 模式）后重试——官网页面直连家庭宽带即可登录。若页面里有「我不是机器人」验证，也可先完成验证再登。'), { code: 'E_CAPTCHA' }));
            }
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

module.exports = { loginPassword, login2fa, loginWeb, logoutAccount, fetchLibrary, refreshTicket, status, account };
