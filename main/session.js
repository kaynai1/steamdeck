'use strict';

const { BrowserWindow, Menu, session: electronSession } = require('electron');
const store = require('./store');

/**
 * 登录设计说明（重要）：
 * 本应用不接触账号密码。登录通过内嵌浏览器窗口完成，
 * 用户在 Steam 官方页面上自行输入账号，成功后我们只保存 Cookie。
 * 主进程永远不调用登录接口，也不读取密码输入框。
 *
 * ★ 分区（partition）一致性是本模块最容易出错的地方 ★
 * 登录窗口运行在 persist:steam 分区，Cookie 只会写进这个分区。
 * 读取时如果误用 defaultSession，读到的永远是空对象，
 * 表现为"明明登录成功了，却提示未获取到会话"。
 * 所以这里所有读写都必须经过 LOGIN_PARTITION。
 */

const LOGIN_PARTITION = 'persist:steam';
// goto=market：登录成功后直接回到市场页，避免跳回首页后判定不了
const LOGIN_URL = 'https://steamcommunity.com/login/home/?goto=market';

let loginWin = null;
let pendingResolve = null;
let pollTimer = null;

/** 取登录分区（不存在则由 Electron 自动创建） */
function ses() {
  return electronSession.fromPartition(LOGIN_PARTITION);
}

/**
 * 解析 steamLoginSecure 里的 SteamID64。
 * 常见形态：76561198xxxxxxxxx%7C%7CeyJhbGciOi...
 * 少数情况下不带 ||，退化为在解码后的串里找 17 位数字。
 */
function parseSteamIdFromCookie(cookieValue) {
  if (!cookieValue) return null;
  let raw = cookieValue;
  try {
    raw = decodeURIComponent(cookieValue);
  } catch {
    /* 保持原样 */
  }
  const id = String(raw).split('||')[0];
  if (/^\d{17}$/.test(id)) return id;
  const m = String(raw).match(/\d{17}/);
  return m ? m[0] : null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 只读社区域（steamcommunity.com）的 Cookie。
 *
 * ★ 这里曾经出过一个致命 bug，务必不要改回合并写法 ★
 * 早先的版本把 steamcommunity.com 和 store.steampowered.com 的 Cookie
 * 合并进同一个 { name: value } 对象。两个域都有 steamLoginSecure，
 * 后写入的商店域值会把社区域的覆盖掉。用商店域的凭证去请求
 * steamcommunity.com 的库存/挂单接口，Steam 一律返回 401 / 400，
 * 表现为"明明登录了却拉不到任何数据"。
 *
 * 结论：拼 Cookie 头必须按域隔离。所有社区接口只用社区域 Cookie。
 */
async function readCookies() {
  const s = ses();
  const map = {};
  try {
    const cookies = await s.cookies.get({ domain: 'steamcommunity.com' });
    for (const c of cookies) map[c.name] = c.value;
  } catch {
    /* 读不到就返回空，由上层提示重新登录 */
  }
  return map;
}

/** 商店域 Cookie 单独取，不要和社区域混用 */
async function readStoreCookies() {
  const s = ses();
  const map = {};
  try {
    // 用父域 steampowered.com 才能匹配到 .steampowered.com 上的 Cookie，
    // 写 store.steampowered.com 反而匹配不到。
    const cookies = await s.cookies.get({ domain: 'steampowered.com' });
    for (const c of cookies) map[c.name] = c.value;
  } catch {
    /* ignore */
  }
  return map;
}

/**
 * 带登录态的请求。
 *
 * 优先用 session.fetch：它由 Electron 按 Cookie 的 domain/path 自动匹配，
 * 天然不会出现"拿 A 域凭证去请求 B 域"的问题，也能自动处理 cookie 过期。
 * 只有在极老的 Electron 上才回落到手动拼社区域 Cookie。
 */
async function authFetch(url, init = {}) {
  const s = ses();
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(init.headers || {}),
  };

  if (typeof s.fetch === 'function') {
    return s.fetch(url, { ...init, headers, credentials: 'include' });
  }

  // 回落路径：只带社区域 Cookie
  const cookies = await readCookies();
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return fetch(url, {
    ...init,
    headers: cookieHeader ? { ...headers, Cookie: cookieHeader } : headers,
  });
}

/** 只要拿到 steamLoginSecure 就算登录成功 */
async function tryFinish(reason) {
  if (!pendingResolve) return;
  const cookies = await readCookies();
  if (!cookies.steamLoginSecure) return; // 还没登录成功，继续等

  const resolver = pendingResolve;
  pendingResolve = null;
  stopPolling();

  const steamId = parseSteamIdFromCookie(cookies.steamLoginSecure);
  try {
    store.saveSecret(`cookies:${steamId || 'unknown'}`, JSON.stringify(cookies));
  } catch (err) {
    resolver({
      ok: false,
      reason: 'save-failed',
      message: `登录成功但 Cookie 无法加密保存：${err.message}`,
    });
    closeWin();
    return;
  }

  resolver({
    ok: true,
    steamId,
    hasSession: !!cookies.sessionid,
    cookieCount: Object.keys(cookies).length,
    reason,
  });
  closeWin();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function closeWin() {
  stopPolling();
  if (loginWin && !loginWin.isDestroyed()) {
    // 先摘掉 closed 监听，避免把成功误判成用户取消
    loginWin.removeAllListeners('closed');
    loginWin.close();
  }
  loginWin = null;
}

/**
 * 打开登录窗口。返回 { ok:true, steamId, ... } 或 { ok:false, reason }。
 *
 * 判定方式：轮询 Cookie 而不是判断 URL。
 * Steam 登录成功后的落地页会随 goto、二步验证、地区而变化，
 * 按 URL 判断非常容易漏，按 Cookie 出现与否判断才是可靠的。
 */
async function openLogin(steamIdHint) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return { ok: false, reason: 'already-open', message: '登录窗口已经打开了，请在其中完成登录。' };
  }

  // 顺手把上次的登录态清掉，避免"这次没登成功却误判为已登录"
  try {
    const old = await readCookies();
    if (old.steamLoginSecure) {
      const s = ses();
      const list = await s.cookies.get({ domain: 'steamcommunity.com' });
      await Promise.all(
        list
          .filter((c) => c.name === 'steamLoginSecure')
          .map((c) => s.cookies.remove(`https://${c.domain}${c.path}`, c.name))
      );
    }
  } catch {
    /* 清理失败不阻塞登录 */
  }

  return new Promise((resolve) => {
    pendingResolve = resolve;

    loginWin = new BrowserWindow({
      width: 560,
      height: 760,
      title: '登录 Steam（在官方页面输入，本应用不获取密码）',
      backgroundColor: '#1B2838',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: LOGIN_PARTITION,
      },
    });

    loginWin.loadURL(LOGIN_URL);

    // 主判定：轮询 Cookie（1.2s 一次，足够快且不打扰）
    pollTimer = setInterval(() => {
      tryFinish('cookie-detected');
    }, 1200);

    // 辅助判定：页面跳转后立刻查一次，缩短成功到提示的延迟
    const onNav = () => {
      setTimeout(() => tryFinish('redirect'), 600);
    };
    loginWin.webContents.on('did-navigate', onNav);
    loginWin.webContents.on('did-navigate-in-page', onNav);
    loginWin.webContents.on('did-finish-load', onNav);

    loginWin.on('closed', () => {
      stopPolling();
      loginWin = null;
      if (!pendingResolve) return;
      const r = pendingResolve;
      pendingResolve = null;
      r({ ok: false, reason: 'closed', message: '登录窗口已关闭，未检测到登录状态。' });
    });
  });
}

/** 打开移动端/市场待处理确认窗口（同源 persist:steam 分区，可在电脑上直接点确认） */
let confWin = null;
function openMobileConfWindow(parentWin) {
  if (confWin && !confWin.isDestroyed()) {
    confWin.focus();
    return confWin;
  }
  confWin = new BrowserWindow({
    parent: parentWin || null,
    width: 520,
    height: 760,
    title: 'Steam 待处理确认（手机令牌与市场挂单批准）',
    autoHideMenuBar: false,
    backgroundColor: '#FFFFFF',
    webPreferences: {
      partition: LOGIN_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  /**
   * ★ 地址必须用 /market/confirmation/ ★
   * 老的 /mobileconf/conf_list 已经被 Steam 下线（实测直接 404），
   * 窗口于是一片空白 —— 这就是"手机端上架无法显示"的直接原因。
   * 现在网页端的市场确认清单在 /market/confirmation/。
   */
  const targetUrl = 'https://steamcommunity.com/market/confirmation/';

  // 确认页可能出现"挂单刚提交、列表还没刷新"的情况，
  // 给一个原生菜单，方便用户手动刷新 / 回市场页 / 重新登录。
  try {
    confWin.setMenu(
      Menu.buildFromTemplate([
        {
          label: '刷新确认列表',
          click: () => confWin && !confWin.isDestroyed() && confWin.loadURL(targetUrl),
        },
        {
          label: '打开市场页',
          click: () =>
            confWin && !confWin.isDestroyed() && confWin.loadURL('https://steamcommunity.com/market/'),
        },
        {
          label: '重新登录',
          click: () =>
            confWin &&
            !confWin.isDestroyed() &&
            confWin.loadURL('https://steamcommunity.com/login/home/?goto=market%2Fconfirmation%2F'),
        },
      ])
    );
  } catch {
    /* 菜单失败不影响窗口 */
  }

  confWin.loadURL(targetUrl);

  // 如果被踢到登录页，直接在本窗口打开登录并回跳到确认清单，
  // 避免用户看到一个"空白的确认页"却不知道要先登录。
  let loginRedirected = false;
  confWin.webContents.on('did-finish-load', () => {
    if (!confWin || confWin.isDestroyed()) return;
    const current = confWin.webContents.getURL();
    if (!loginRedirected && /\/login/i.test(current)) {
      loginRedirected = true;
      confWin.loadURL('https://steamcommunity.com/login/home/?goto=market%2Fconfirmation%2F');
    }
  });

  // 页面加载错误时先尝试市场主页，仍失败再展示指引，避免纯白窗口
  let retried = false;
  confWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // 忽略 ABORTED
    // 确认页偶发 404/429：自动退回市场主页再试一次（那里有"待确认"入口）
    if (!retried && /confirmation/i.test(String(validatedURL || ''))) {
      retried = true;
      if (confWin && !confWin.isDestroyed()) {
        confWin.loadURL('https://steamcommunity.com/market/').catch(() => {});
      }
      return;
    }

    const safeMsg = `${errorDescription} (${errorCode})`;
    const fallbackHtml = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Steam 确认加载指引</title></head>
      <body style="font-family:system-ui,-apple-system,sans-serif;padding:32px 20px;text-align:center;color:#333;background:#F8F9FA;">
        <div style="font-size:36px;margin-bottom:12px">&#128241;</div>
        <h3 style="margin:0 0 10px;font-size:16px;">市场待确认清单加载提示</h3>
        <p style="font-size:12px;color:#666;line-height:1.6;max-width:380px;margin:0 auto 18px;">
          当前连接 Steam 社区较慢或网络中断（${safeMsg}）。<br>
          市场挂单确认页：<b>steamcommunity.com/market/confirmation/</b><br>
          如页面提示"没有需要确认的项目"，说明挂单已成功、无需额外确认；<br>
          若您绑定了手机令牌，确认项也会同时推送到手机 Steam App。
        </p>
        <div style="display:flex;gap:10px;justify-content:center;">
          <button onclick="location.href='https://steamcommunity.com/market/confirmation/'" style="padding:8px 16px;background:#0078D4;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">重新打开确认页</button>
          <button onclick="location.href='https://steamcommunity.com/market/'" style="padding:8px 16px;background:#fff;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:13px;">打开市场主页</button>
        </div>
      </body>
      </html>
    `;
    if (confWin && !confWin.isDestroyed()) {
      confWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml)}`);
    }
  });

  confWin.on('closed', () => { confWin = null; });
  return confWin;
}

/**
 * 自动获取或申请 Steam Web API Key：
 * 如果用户已在应用内完成网页登录，直接带 Cookie 请求 https://steamcommunity.com/dev/apikey
 * 1) 如果已有 key，从 HTML 提取并自动保存
 * 2) 如果没有，自动提交申请注册（domain: localhost）
 */
async function autoGetApiKey() {
  const sesData = await getSession();
  if (!sesData || !sesData.cookies || !sesData.cookies.steamLoginSecure) {
    return null;
  }
  const settings = store.getSettings();
  if (settings.apiKey && /^[0-9A-F]{32}$/i.test(settings.apiKey.trim())) {
    return settings.apiKey.trim();
  }

  try {
    const bridge = require('./steamBridge');
    const res = await bridge.communityFetch('https://steamcommunity.com/dev/apikey');
    const html = await res.text();

    const m = html.match(/Key:\s*([0-9A-F]{32})/i) || html.match(/<p>Key:\s*([0-9A-F]{32})<\/p>/i);
    if (m && m[1]) {
      const apiKey = m[1].toUpperCase();
      store.setSettings({ apiKey });
      return apiKey;
    }

    if (html.includes('registerkey') || !html.includes('Revoke My Steam Web API Key')) {
      const sessionId = sesData.cookies.sessionid || '';
      const regRes = await bridge.communityFetch('https://steamcommunity.com/dev/registerkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          domain: 'localhost',
          agreeToTerms: 'agreed',
          sessionid: sessionId,
          Submit: 'Register',
        }).toString(),
      });
      const regHtml = await regRes.text();
      const m2 = regHtml.match(/Key:\s*([0-9A-F]{32})/i) || regHtml.match(/<p>Key:\s*([0-9A-F]{32})<\/p>/i);
      if (m2 && m2[1]) {
        const apiKey = m2[1].toUpperCase();
        store.setSettings({ apiKey });
        return apiKey;
      }
    }
  } catch (err) {
    console.warn('[autoGetApiKey] failed:', err.message);
  }
  return null;
}

/**
 * 免 API Key 抓取游戏库：
 * 通过 Steam 社区已登录会话抓取个人资料游戏页 (含 rgGames)
 */
async function fetchGamesFromCommunity(steamId) {
  try {
    const bridge = require('./steamBridge');
    const library = require('./steamLibrary');
    const registry = require('./appRegistry');
    const urls = [
      `https://steamcommunity.com/profiles/${steamId}/games/?tab=all`,
      `https://steamcommunity.com/my/games/?tab=all`,
    ];
    for (const u of urls) {
      try {
        const res = await bridge.communityFetch(u);
        const html = await res.text();
        const m = html.match(/var\s+rgGames\s*=\s*(\[[\s\S]*?\]);\s*\n/);
        if (m) {
          const list = JSON.parse(m[1]);
          if (Array.isArray(list) && list.length > 0) {
            return list.map((g) => ({
              appId: Number(g.appid),
              name: g.name,
              playtime: Number(g.hours_forever ? parseFloat(g.hours_forever) * 60 : g.playtime_forever) || 0,
              playtime2Weeks: 0,
              lastPlayed: (Number(g.last_played) || 0) * 1000,
              cover: library.coverUrl(g.appid),
              covers: library.coverUrls(g.appid),
              coversPortrait: library.portraitCoverUrls(g.appid),
              tradeable: registry.isKnown(g.appid),
              ctx: registry.ctxOf(g.appid),
            }));
          }
        }
      } catch { /* ignore single url */ }
    }
  } catch (e) {
    console.warn('[fetchGamesFromCommunity] failed:', e.message);
  }
  return [];
}

/**
 * 取会话。优先用内存/分区里的实时 Cookie，其次回落到加密存储。
 * 注意：不再依赖 defaultSession，否则永远拿不到登录窗口写入的 Cookie。
 */
async function getSession(steamId) {
  const live = await readCookies();
  if (live.steamLoginSecure) {
    return {
      steamId: parseSteamIdFromCookie(live.steamLoginSecure) || steamId,
      cookies: live,
      source: 'live',
    };
  }

  if (!steamId) return null;
  let saved = store.readSecret(`cookies:${steamId}`);
  // 登录时若拿不到 steamid 会存到 unknown，兜底读一次
  if (!saved) saved = store.readSecret('cookies:unknown');
  if (!saved) return null;

  try {
    const cookies = JSON.parse(saved);
    if (!cookies.steamLoginSecure) return null;
    return {
      steamId: parseSteamIdFromCookie(cookies.steamLoginSecure) || steamId,
      cookies,
      source: 'stored',
    };
  } catch {
    return null;
  }
}

/**
 * 把一份 Cookie 写回 persist:steam 分区。
 * 应用升级 / 分区被清理 / Electron 丢掉 session cookie 后，
 * 用加密存储里的备份恢复，避免"每次打开都要重新登录"。
 */
async function applyCookies(cookieMap) {
  const s = ses();
  let n = 0;
  for (const [name, value] of Object.entries(cookieMap || {})) {
    if (!name || value === null || value === undefined) continue;
    try {
      await s.cookies.set({
        url: 'https://steamcommunity.com/',
        name,
        value: String(value),
        path: '/',
      });
      n += 1;
    } catch {
      /* 单个 Cookie 写入失败不影响其它 */
    }
  }
  return n;
}

/**
 * 启动时恢复登录态：
 *   1) 分区里已有 steamLoginSecure → 直接算已登录（正常情况下就是这条路）；
 *   2) 没有的话，从加密存储里的 cookies:<steamId> 备份写回分区。
 * 返回 { loggedIn, steamId, source }。
 */
async function restoreSavedSession(steamIdHint) {
  const live = await readCookies();
  if (live.steamLoginSecure) {
    return {
      loggedIn: true,
      source: 'live',
      steamId: parseSteamIdFromCookie(live.steamLoginSecure) || steamIdHint || null,
      cookieCount: Object.keys(live).length,
    };
  }

  const ids = [];
  if (steamIdHint) ids.push(String(steamIdHint));
  try {
    const accounts = require('./steamAccounts');
    const scan = accounts.scanAccounts();
    for (const u of scan.users || []) ids.push(String(u.steamId));
  } catch {
    /* ignore */
  }
  ids.push('unknown');

  for (const id of [...new Set(ids.filter(Boolean))]) {
    let raw = null;
    try {
      raw = store.readSecret(`cookies:${id}`);
    } catch {
      continue;
    }
    if (!raw) continue;
    let cookies = null;
    try {
      cookies = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!cookies || !cookies.steamLoginSecure) continue;

    const n = await applyCookies(cookies);
    if (!n) continue;

    const now = await readCookies();
    if (now.steamLoginSecure) {
      return {
        loggedIn: true,
        source: 'restored',
        steamId: parseSteamIdFromCookie(now.steamLoginSecure) || (id === 'unknown' ? null : id),
        cookieCount: Object.keys(now).length,
      };
    }
  }

  return { loggedIn: false, source: 'none', steamId: steamIdHint || null, cookieCount: 0 };
}

/** 列出本地有会话的账号 */
async function listSessions() {
  const accounts = require('./steamAccounts');
  const scan = accounts.scanAccounts();
  const live = await readCookies();
  const liveId = parseSteamIdFromCookie(live.steamLoginSecure);

  return scan.users.map((u) => {
    let hasStored = false;
    try {
      hasStored = !!store.readSecret(`cookies:${u.steamId}`);
    } catch {
      hasStored = false;
    }
    return {
      steamId: u.steamId,
      personaName: u.personaName,
      accountName: u.accountName,
      online: u.steamId === liveId,
      hasSession: hasStored || u.steamId === liveId,
    };
  });
}

async function dropSession(steamId) {
  try {
    store.removeSecret(`cookies:${steamId}`);
  } catch {
    /* ignore */
  }
  try {
    const s = ses();
    const cookies = await s.cookies.get({ domain: 'steamcommunity.com' });
    await Promise.all(
      cookies.map((c) => s.cookies.remove(`https://${c.domain}${c.path}`, c.name))
    );
  } catch {
    /* 忽略清理失败 */
  }
  return { ok: true };
}

module.exports = {
  openLogin,
  openMobileConfWindow,
  restoreSavedSession,
  applyCookies,
  autoGetApiKey,
  fetchGamesFromCommunity,
  getSession,
  listSessions,
  dropSession,
  readCookies,
  readStoreCookies,
  authFetch,
  LOGIN_PARTITION,
};
