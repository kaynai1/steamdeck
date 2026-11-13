'use strict';

const { BrowserWindow } = require('electron');
const session = require('./session');

/**
 * 社区请求通道（第三次重写，务必读完再改）
 *
 * ★ 为什么不能用主进程直接 fetch ★
 * 前两版都试过在主进程发请求：
 *   1) 手动拼 Cookie 头  → 合并过两域，凭证串值，401/400
 *   2) 按域隔离 + session.fetch → 仍然 401/400
 * 原因是 Steam 的社区接口校验的不只是 Cookie：
 *   - Origin / Referer 必须来自 steamcommunity.com
 *   - Sec-Fetch-Site 必须是 same-origin
 *   - 部分接口还会核对 UA 与浏览器指纹、以及 sitelicense / webTradeEligibility
 * 从 Node 侧伪造这些头，Steam 一律判定为"非浏览器会话"，直接 401 / 400。
 *
 * ★ 本模块的做法 ★
 * 打开一个（默认隐藏的）BrowserWindow，导航到 https://steamcommunity.com/，
 * 用 executeJavaScript 在页面上下文里调用 fetch。
 * 此时请求由 Chromium 自己发出，Cookie 由浏览器内核按域注入，
 * Origin / Referer / Sec-Fetch 全部天然正确 —— 和用户在网页上点按钮毫无区别。
 * 这是唯一稳定拿到登录态数据的方式。
 *
 * 该窗口与登录窗口共用 persist:steam 分区，因此登录一次即可复用。
 */

const COMMUNITY_HOME = process.env.STEAMDESK_BRIDGE_HOME || 'https://steamcommunity.com/';
const COMMUNITY_ORIGIN = (() => {
  try {
    return new URL(COMMUNITY_HOME).origin;
  } catch {
    return 'https://steamcommunity.com';
  }
})();

let win = null;
let readyPromise = null;
// 下一次打开通道时使用的入口页（默认社区首页；上架前会改成市场页）
let startUrl = null;
let chain = Promise.resolve();
let lastError = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function alive() {
  return !!win && !win.isDestroyed();
}

function destroy() {
  if (alive()) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  win = null;
  readyPromise = null;
}

function normalizeUrl(target) {
  if (/^https?:\/\//i.test(target)) return target;
  return COMMUNITY_ORIGIN + (String(target).startsWith('/') ? target : '/' + target);
}

/** 串行化：同一时刻只允许一个 executeJavaScript，避免互相打断 */
function enqueue(fn) {
  const run = chain.then(fn, fn);
  // 吞掉异常只用于维持队列，真实异常由 run 抛给调用者
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 在页面上下文里执行的取数函数。
 * 必须自包含（会被 toString 序列化后注入），不能引用外部变量。
 */
function inPageFetch(req) {
  return (async () => {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const init = {
        method,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        headers: req.headers && typeof req.headers === 'object' ? req.headers : {},
      };
      if (req.body !== null && req.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = req.body;
      }
      const res = await fetch(req.url, init);
      const text = await res.text();
      const headers = {};
      try {
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } catch (e) {
        /* ignore */
      }
      return {
        ok: !!res.ok,
        status: res.status,
        url: res.url,
        redirected: !!res.redirected,
        type: res.type,
        headers,
        body: text,
      };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  })();
}

/**
 * 在页面上下文里提交表单。
 *
 * ★ 为什么单独做一条通道 ★
 * sellitem / removelisting 这类接口的 sessionid 是**表单字段**，
 * Steam 会拿它和 Cookie 里的 sessionid 做比对。之前我们从加密存储里读
 * sessionid 再拼进表单，一旦 Cookie 在浏览器里轮换过（重新登录、手机令牌刷新），
 * 两边就对不上，Steam 直接回"session 校验失败"。
 * 现在改成：在页面里现读 document.cookie / g_sessionID，和浏览器实际发出的
 * Cookie 永远是同一份，杜绝这种错位。
 */
function inPagePostForm(req) {
  return (async () => {
    try {
      // 优先用页面上的 g_sessionID：它是 Steam 服务端根据"这个页面收到的 Cookie"下发的值，
      // 和网页自己点出售时发的完全一致；document.cookie 只作兜底（可能有同名的多路径 Cookie）。
      const m = document.cookie.match(/(?:^|; )sessionid=([^;]+)/);
      const sid =
        (typeof g_sessionID !== 'undefined' && g_sessionID ? String(g_sessionID) : '') ||
        (m && m[1]) ||
        '';
      const body = new URLSearchParams(req.fields || {});
      if (sid) body.set('sessionid', sid);
      const res = await fetch(req.url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        headers: req.headers || {},
        body: body.toString(),
      });
      const text = await res.text();
      return {
        ok: !!res.ok,
        status: res.status,
        url: res.url,
        redirected: !!res.redirected,
        body: text,
        sessionId: sid || '',
      };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  })();
}

/**
 * 提交表单到社区接口（sessionid 由页面自己补上）。
 * 通道窗口装不起来时退回 session.authFetch —— 那条路会自己拼 sessionid，
 * 虽然不如页面内准确，但总比整个上架功能直接不可用强。
 */
async function postForm(target, fields, options = {}) {
  try {
    return await postFormInPage(target, fields, options);
  } catch (err) {
    if (err && (err.code === 'E_BRIDGE' || err.code === 'E_BRIDGE_LOAD')) {
      const ses = await session.getSession();
      const sid = ses && ses.cookies ? ses.cookies.sessionid : '';
      const body = new URLSearchParams(fields || {});
      if (sid) body.set('sessionid', sid);
      const res = await session.authFetch(normalizeUrl(target), {
        method: 'POST',
        headers: { ...(options.headers || {}) },
        body: body.toString(),
      });
      try {
        res.channel = 'fallback';
        res.sessionIdLen = String(sid || '').length;
      } catch { /* Response 可能只读，标记失败不影响结果 */ }
      return res;
    }
    throw err;
  }
}

async function postFormInPage(target, fields, options = {}) {
  const url = normalizeUrl(target);
  const payload = { url, fields: fields || {}, headers: options.headers || {} };
  return enqueue(async () => {
    await ensure();
    if (!alive()) {
      throw Object.assign(new Error('会话通道未就绪，请重试'), { code: 'E_BRIDGE' });
    }
    const script = `(${inPagePostForm.toString()})(${JSON.stringify(payload)})`;
    let raw;
    try {
      raw = await win.webContents.executeJavaScript(script, true);
    } catch (err) {
      destroy();
      throw Object.assign(new Error(`会话通道请求失败：${err.message}`), { code: 'E_BRIDGE' });
    }
    if (!raw || typeof raw !== 'object') {
      throw Object.assign(new Error('会话通道返回为空'), { code: 'E_BRIDGE' });
    }
    if (raw.error) {
      throw Object.assign(new Error(`页面内请求失败：${raw.error}`), { code: 'E_BRIDGE_NET' });
    }
    const wrapped = wrap(raw);
    wrapped.sessionId = raw.sessionId || '';
    wrapped.sessionIdLen = String(raw.sessionId || '').length;
    wrapped.channel = 'page';
    return wrapped;
  });
}

/** 把页面返回包装成 Response 形状，让调用方代码保持简单 */
function wrap(raw) {
  const body = typeof raw.body === 'string' ? raw.body : '';
  return {
    ok: !!raw.ok,
    status: Number(raw.status) || 0,
    url: raw.url || '',
    redirected: !!raw.redirected,
    headers: raw.headers || {},
    body,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 判断返回体是不是被踢到登录页 */
function looksLikeLogin(r) {
  if (!r) return false;
  if (/\/login|signin/i.test(String(r.url || ''))) return true;
  if (r.status === 401) return true;
  const head = String(r.body || '').slice(0, 4000);
  if (/name="loginForm"|id="login_form"|g_steamID\s*=\s*false/.test(head)) return true;
  if (/^\s*</.test(head) && /Sign In|登录/i.test(head) && !/market_listing|inventory/i.test(head)) return true;
  return false;
}

/** 从 HTML 里抓 SteamID64（登录页会带 g_steamID） */
function extractSteamId(body) {
  const m = String(body || '').match(/g_steamID\s*=\s*["'](\d{17})["']/);
  return m ? m[1] : null;
}

/** 打开/复用通道窗口。返回 Promise<void> */
async function ensure() {
  if (alive() && readyPromise) return readyPromise;

  const opts = {
    show: false,
    width: 1180,
    height: 820,
    title: 'SteamDesk 会话通道',
    backgroundColor: '#1B2838',
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      partition: session.LOGIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };

  win = new BrowserWindow(opts);

  readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    win.webContents.once('did-finish-load', () => finish());
    win.webContents.once('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      finish(
        Object.assign(new Error(`无法打开 Steam 社区页（${code} ${desc}），请检查网络或代理设置`), {
          code: 'E_BRIDGE_LOAD',
        })
      );
    });
    // 兜底：某些代理会卡住导航但页面其实可用
    setTimeout(() => finish(), 20000);

    const entry = startUrl || COMMUNITY_HOME;
    startUrl = null; // 一次性生效，后续窗口仍回首页
    win.loadURL(entry).catch((err) => {
      finish(
        Object.assign(new Error(`无法打开 Steam 社区页：${err.message}`), { code: 'E_BRIDGE_LOAD' })
      );
    });
  });

  win.on('closed', () => {
    win = null;
    readyPromise = null;
  });

  try {
    await readyPromise;
  } catch (err) {
    lastError = err;
    destroy();
    throw err;
  }
  return undefined;
}

/**
 * 在社区页上下文里发一次请求。
 * 返回 Response 形状对象；网络层失败抛 E_BRIDGE / E_BRIDGE_LOAD。
 */
async function request(target, options = {}) {
  const url = normalizeUrl(target);
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  const payload = {
    url,
    method,
    headers,
    body: options.body === undefined || options.body === null ? null : String(options.body),
  };

  return enqueue(async () => {
    await ensure();
    if (!alive()) {
      throw Object.assign(new Error('会话通道未就绪，请重试'), { code: 'E_BRIDGE' });
    }
    const script = `(${inPageFetch.toString()})(${JSON.stringify(payload)})`;
    let raw;
    try {
      raw = await win.webContents.executeJavaScript(script, true);
    } catch (err) {
      destroy();
      throw Object.assign(new Error(`会话通道请求失败：${err.message}`), { code: 'E_BRIDGE' });
    }
    if (!raw || typeof raw !== 'object') {
      throw Object.assign(new Error('会话通道返回为空'), { code: 'E_BRIDGE' });
    }
    if (raw.error) {
      throw Object.assign(new Error(`页面内请求失败：${raw.error}`), { code: 'E_BRIDGE_NET' });
    }
    return wrap(raw);
  });
}

/**
 * 供业务模块直接使用：优先走页面通道；
 * 只有通道本身不可用（窗口装不起来 / 导航失败）才回落到旧的 session.authFetch，
 * 这样离线查价等公开接口在极端情况下仍有兜底，不至于整页不可用。
 */
async function communityFetch(target, options = {}) {
  try {
    return await request(target, options);
  } catch (err) {
    if (err && (err.code === 'E_BRIDGE' || err.code === 'E_BRIDGE_LOAD')) {
      try {
        return await session.authFetch(normalizeUrl(target), options);
      } catch (err2) {
        throw err;
      }
    }
    throw err;
  }
}

/** 只留前 4 位，避免把会话凭证写进日志 */
function maskSid(s) {
  const v = String(s || '');
  return v ? `${v.slice(0, 4)}…(${v.length})` : '';
}

/** 读通道页面里的 sessionid（g_sessionID 与 document.cookie 各取一份） */
async function pageSessionInfo() {
  await ensure();
  if (!alive()) return null;
  return enqueue(() =>
    win.webContents.executeJavaScript(
      `(function(){
        var m = document.cookie.match(/(?:^|; )sessionid=([^;]+)/);
        return {
          cookie: (m && m[1]) || '',
          g: (typeof g_sessionID !== 'undefined' ? String(g_sessionID) : ''),
          url: location.href,
          steamId: (typeof g_steamID !== 'undefined' ? String(g_steamID) : '')
        };
      })()`,
      true
    )
  );
}

/**
 * 保证通道页面停在指定社区页上（已经是就不重开）。
 *
 * ★ 为什么重要 ★
 * Steam 的市场写接口（removelisting / sellitem）会看 Referer 是否来自市场页。
 * 通道默认停在社区首页，从首页发出的下架请求会被 Steam 直接回 400，
 * 而网页上点「下架」永远不会出这个错——差别就在这里。
 */
function ensurePage(target) {
  const want = normalizeUrl(target);
  return enqueue(async () => {
    if (alive() && readyPromise) {
      try {
        await readyPromise;
      } catch {
        /* 上次加载失败，按下面重开 */
      }
      if (alive()) {
        let cur = '';
        try {
          cur = await win.webContents.executeJavaScript('location.href', true);
        } catch {
          /* 取不到就当作不在目标页 */
        }
        if (cur && String(cur).split('#')[0].startsWith(want)) {
          return { ok: true, reused: true, url: cur };
        }
      }
    }
    startUrl = want;
    destroy();
    await ensure();
    return { ok: true, reused: false, url: want };
  });
}

/** 强制刷新通道：重新导航到社区首页，让 Steam 重新下发社区侧 Cookie */
async function refresh(target) {
  startUrl = target ? normalizeUrl(target) : null;
  destroy();
  await ensure();
  return { ok: true };
}

/**
 * 会话自检。给"账号管理"页用，输出不含任何 Cookie 值。
 * 返回 { partition, cookies:{...}, loggedIn, steamId, probe }
 */
async function diagnose() {
  const out = {
    partition: session.LOGIN_PARTITION,
    cookies: { community: [], store: [] },
    loggedIn: false,
    steamId: null,
    probe: null,
    bridgeReady: false,
    error: null,
  };

  try {
    const comm = await session.readCookies();
    out.cookies.community = Object.keys(comm).sort();
    out.cookies.hasSessionId = !!comm.sessionid;
    out.cookies.hasLoginSecure = !!comm.steamLoginSecure;
    try {
      const st = await session.readStoreCookies();
      out.cookies.store = Object.keys(st).sort();
    } catch {
      /* ignore */
    }
  } catch (err) {
    out.error = `读取 Cookie 失败：${err.message}`;
  }

  // sessionid 一致性：表单里的 sessionid 必须和 Cookie 里的一致，否则 sellitem 会回 Session mismatch
  try {
    const jar = await session.readCookies();
    const jarSid = jar.sessionid || '';
    const page = await pageSessionInfo();
    out.session = {
      jar: maskSid(jarSid),
      page: page ? maskSid(page.cookie) : '',
      gSession: page ? maskSid(page.g) : '',
      pageUrl: page ? page.url : '',
      pageSteamId: page ? page.steamId : '',
      match: !!(jarSid && page && page.cookie && jarSid === page.cookie),
    };
  } catch (err) {
    out.session = { error: err.message };
  }

  try {
    const res = await request('/my/profile', { headers: { Accept: 'text/html,application/xhtml+xml' } });
    out.bridgeReady = true;
    out.probe = { status: res.status, url: res.url };
    out.steamId = extractSteamId(res.body);
    out.loggedIn = !looksLikeLogin(res) && !!out.steamId;
    if (!out.loggedIn && !res.url.includes('/login')) {
      // 有些账号 profile 页被限但不是未登录，用 market 再确认一次
      const m = await request('/market/', { headers: { Accept: 'text/html' } });
      out.probe.marketStatus = m.status;
      out.steamId = out.steamId || extractSteamId(m.body);
      out.loggedIn = !!out.steamId || /my_listing|market_listing_row|favorite/.test(String(m.body || ''));
    }
  } catch (err) {
    out.error = out.error || err.message;
  }

  return out;
}

/** 把通道窗口显示出来（用户在提示里点"查看"时可排查登录状态） */
async function showWindow() {
  await ensure();
  if (!alive()) return { ok: false };
  win.setSkipTaskbar(false);
  win.show();
  win.focus();
  return { ok: true };
}

function hideWindow() {
  if (alive()) {
    win.hide();
    win.setSkipTaskbar(true);
  }
  return { ok: true };
}

module.exports = {
  request,
  postForm,
  communityFetch,
  refresh,
  ensurePage,
  diagnose,
  showWindow,
  hideWindow,
  ensure,
  pageSessionInfo,
  looksLikeLogin,
  extractSteamId,
  get lastError() {
    return lastError;
  },
};
