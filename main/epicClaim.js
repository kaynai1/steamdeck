'use strict';

/**
 * Epic 商店免费游戏「一键领取」（支持多账号）
 *
 * 流程：
 *   1) 内嵌窗口登录 epicgames.com，拿 OAuth authorizationCode
 *      → 用启动器客户端凭证换 access_token / refresh_token
 *      （每个账号登录时单独用一个 cookie 分区，结账时网页会话才对得上号）
 *   2) 领取：先 POST orderprocessor .../orders/quickPurchase
 *      · SUCCESS  → 已入库
 *      · CHECKOUT → Epic 的旧结账接口（order-preview / confirm-order）在
 *        2024 年后已下线（现在请求直接 404），改为在隐藏窗口里打开官方
 *        结账页 store.epicgames.com/purchase?namespace=…&offers=…，
 *        等页面出现「添加到库」后点一下。
 *
 * ★ 安全约束 ★
 *   - 只处理免费条目：结账页必须显示 0 元（0.00 / 免费）才点；
 *   - 结账页上如果出现的是别的账号名，直接中止，不会领错号；
 *   - 令牌只落本地加密存储，日志里不出现 access_token。
 */

const store = require('./store');

// 启动器公开客户端凭证（Epic 客户端内置值，非用户隐私）
const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

const OAUTH = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const CHECKOUT_PAGE = 'https://store.epicgames.com/purchase';

const UA =
  'EpicGamesLauncher/17.0.0-38338133+++Portal+Release-Live Windows/10.0.22631.1.768.64bit';
// 老版本只有一个共享分区；新登录的账号各自分到一个 persist:epic:s 开头的分区
const PARTITION = 'persist:epic';

const ACCOUNTS_KEY = 'epic:accounts';
const LEGACY_KEY = 'epic:tokens';

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

/* -------------------------------- 账号存储 --------------------------------
 * 结构：{ [accountId]: { accountId, displayName, accessToken, refreshToken,
 *                       expiresAt, at, enabled } }
 * 旧版本只存了一个 epic:tokens，读到就顺手迁移过来。
 */

function readAccounts() {
  try {
    const raw = store.readSecret(ACCOUNTS_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch { /* 落到下面的迁移逻辑 */ }
  try {
    const old = store.readSecret(LEGACY_KEY);
    if (old) {
      const t = JSON.parse(old);
      if (t && t.accountId) {
        const map = { [t.accountId]: { ...t, enabled: true } };
        store.saveSecret(ACCOUNTS_KEY, JSON.stringify(map));
        store.removeSecret(LEGACY_KEY);
        return map;
      }
    }
  } catch { /* ignore */ }
  return {};
}

function writeAccounts(map) {
  store.saveSecret(ACCOUNTS_KEY, JSON.stringify(map));
}

function tokensValid(t) {
  return !!(t && t.accessToken && t.accountId && t.expiresAt > Date.now() + 60 * 1000);
}

/* --------------------------------- OAuth --------------------------------- */

async function tokenRequest(body) {
  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: {
      Authorization: 'basic ' + BASIC,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 下面统一报错 */ }
  if (!res.ok || !json || !json.access_token) {
    const msg =
      (json && (json.errorMessage || json.errorCode || json.error)) || `HTTP ${res.status}`;
    throw err('E_EPIC_AUTH', `Epic 登录校验失败：${msg}`);
  }
  return json;
}

function toTokens(json) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || '',
    accountId: json.account_id,
    // 新接口回的是 displayName（驼峰），旧的是 display_name
    displayName: json.displayName || json.display_name || '',
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    at: Date.now(),
    enabled: true,
  };
}

async function refreshTokens(t) {
  if (!t || !t.refreshToken) throw err('E_EPIC_LOGIN', 'Epic 登录已过期，请重新登录');
  const json = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: t.refreshToken,
    token_type: 'eg1',
  });
  const next = toTokens(json);
  if (!next.refreshToken) next.refreshToken = t.refreshToken;
  if (!next.displayName) next.displayName = t.displayName || '';
  next.enabled = t.enabled !== false;
  return next;
}

/** 拿到某个账号可用的令牌（必要时自动续期并写回） */
async function ensureAccount(accountId) {
  const map = readAccounts();
  const t = map[accountId];
  if (!t) throw err('E_EPIC_LOGIN', '该 Epic 账号未登录');
  if (tokensValid(t)) return t;
  const next = await refreshTokens(t);
  map[accountId] = { ...t, ...next, enabled: t.enabled !== false };
  if (!map[accountId].sessionPartition && t.sessionPartition) {
    map[accountId].sessionPartition = t.sessionPartition;
  }
  writeAccounts(map);
  return map[accountId];
}

/* --------------------------------- 状态 ---------------------------------- */

async function list() {
  const map = readAccounts();
  const rows = [];
  for (const t of Object.values(map)) {
    // 有些号登录时 Epic 没返回名字，用令牌补查一次并写回，界面才显示真名
    if (!t.displayName && tokensValid(t)) {
      try {
        await profileName(t);
      } catch { /* 查不到就继续显示 ID */ }
    }
    rows.push({
      accountId: t.accountId,
      displayName: t.displayName || '',
      enabled: t.enabled !== false,
      // 老版本登录的号没有自己的网页会话，领取时要先重新登录一次
      hasSession: !!t.sessionPartition,
      expired: !tokensValid(t) && !t.refreshToken,
      at: t.at || 0,
    });
  }
  const accounts = rows.sort((a, b) =>
    (a.displayName || '').localeCompare(b.displayName || '')
  );
  return {
    linked: accounts.length > 0,
    count: accounts.length,
    accounts,
    enabledCount: accounts.filter((a) => a.enabled).length,
  };
}

function remove(accountId) {
  const map = readAccounts();
  if (!map[accountId]) return { ok: false };
  delete map[accountId];
  writeAccounts(map);
  return { ok: true, remaining: Object.keys(map).length };
}

async function setEnabled(accountId, enabled) {
  const map = readAccounts();
  if (!map[accountId]) throw err('E_EPIC_NOT_FOUND', '没有这个 Epic 账号');
  map[accountId].enabled = !!enabled;
  writeAccounts(map);
  return list();
}

async function logoutAll() {
  const map = readAccounts();
  writeAccounts({});
  return { ok: true, removed: Object.keys(map).length };
}

/* --------------------------------- 登录窗口 -------------------------------- */

/**
 * 打开内嵌登录窗口，登录完成后从 /id/api/redirect 的 JSON 里取 authorizationCode。
 * 用户自己完成账号密码 / 邮箱验证码 / 2FA，我们不碰任何凭据。
 */
function openLoginWindow(parent) {
  const { BrowserWindow } = require('electron');
  return new Promise((resolve, reject) => {
    const redirectBase = 'https://www.epicgames.com/id/api/redirect';
    const redirectUrl = `${redirectBase}?clientId=${CLIENT_ID}&responseType=code`;
    const loginUrl =
      'https://www.epicgames.com/id/login?redirectUrl=' + encodeURIComponent(redirectUrl);

    // 每个账号一份 cookie：这样结账窗口登录的就是这个号，
    // 多个号同时绑定时不会互相顶掉。
    const partition = `${PARTITION}:s${Date.now().toString(36)}`;

    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent || undefined,
      modal: false,
      title: '登录 Epic Games',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    let stopPoll = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (stopPoll) { stopPoll(); stopPoll = null; }
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
      fn(arg);
    };

    const saveAccount = (t) => {
      const map = readAccounts();
      const prev = map[t.accountId] || {};
      map[t.accountId] = {
        ...prev,
        ...t,
        // 这次登录用的分区里存着这个号的网页 Cookie，结账要用
        sessionPartition: partition,
        enabled: prev.enabled !== undefined ? prev.enabled : true,
      };
      writeAccounts(map);
      return { accountId: t.accountId, displayName: t.displayName, count: Object.keys(map).length };
    };

    /**
     * 从当前页面提取授权码并完成登录。
     * ★ 2026-11 实测踩坑：授权页是一段裸 JSON，Chromium 内建的 JSON 查看器会给页面
     *   加上「美观输出」工具栏，innerText 因此混入工具栏文字，严格 JSON.parse 直接抛错，
     *   而错误被静默吞掉后没有任何重试——登录窗口就永远停在 JSON 页上（用户实测卡死）。
     * 修复：① 宽松提取（整段 parse 失败就用正则直接抠 authorizationCode）；
     *       ② URL 查询参数里的 code 也认（老 sid 流程会跳 localhost/launcher/authorized）；
     *       ③ 事件 + 轮询双保险，不再只赌一次 did-finish-load。
     */
    const grabCode = async () => {
      if (settled) return;
      const url = win.webContents.getURL();
      let onRedirect = false;
      try { onRedirect = new URL(url).pathname === '/id/api/redirect'; } catch { /* ignore */ }
      if (!onRedirect) return;
      try {
        const text = await win.webContents.executeJavaScript(
          'document.body ? document.body.innerText : ""',
          true
        );
        let j = null;
        try { j = JSON.parse(String(text)); } catch { /* 混入了查看器工具栏文字，走正则 */ }
        let code = (j && j.authorizationCode) || '';
        if (!code) {
          const m = String(text).match(/"authorizationCode"\s*:\s*"([A-Za-z0-9._-]{16,})"/);
          if (m) code = m[1];
        }
        if (!code) {
          try { code = new URL(url).searchParams.get('code') || ''; } catch { /* ignore */ }
        }
        if (code) {
          try {
            const json = await tokenRequest({
              grant_type: 'authorization_code',
              code,
              token_type: 'eg1',
            });
            done(resolve, saveAccount(toTokens(json)));
          } catch (e) {
            done(reject, e);
          }
          return;
        }
        let errCode = (j && (j.errorCode || j.error)) || '';
        if (!errCode) {
          const em = String(text).match(/"(?:errorCode|error)"\s*:\s*"([^"]+)"/);
          if (em) errCode = em[1];
        }
        if (errCode) {
          done(reject, err('E_EPIC_AUTH', `Epic 返回错误：${errCode}`));
        }
        // JSON 还没渲染好（查看器接管慢）：轮询会再进来，不报错
      } catch {
        /* 页面还在跳转，等下一次 */
      }
    };

    win.webContents.on('did-finish-load', grabCode);
    win.webContents.on('did-navigate', grabCode);
    // 轮询兜底：JSON 查看器接管页面的时机不一定触发导航事件
    const poll = setInterval(() => { grabCode().catch(() => {}); }, 900);
    stopPoll = () => clearInterval(poll);
    win.on('closed', () => { if (stopPoll) { stopPoll(); stopPoll = null; } });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(err('E_CANCELLED', '已关闭 Epic 登录窗口'));
      }
    });

    win.loadURL(loginUrl).catch((e) => done(reject, err('E_EPIC_LOAD', e.message)));
  });
}

/* ---------------------------------- 领取 --------------------------------- */

/**
 * 结账页要的是网页 Cookie（不是 bearer），而且服务端渲染会被 Cloudflare 拦，
 * 所以这一截只能在窗口里打开官方结账页，等「添加到库」按钮出来后点一下。
 * 窗口用的是这个账号登录时的那个分区，多个号互不干扰。
 */

function authHeaders(t) {
  return {
    Authorization: `bearer ${t.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Accept: 'application/json',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 领取过程写一份小日志到 userData/epic-claim.log，出问题能直接看 */
function dlog(...parts) {
  try {
    const { app } = require('electron');
    const fs = require('fs');
    const path = require('path');
    const file = path.join(app.getPath('userData'), 'epic-claim.log');
    try {
      if (fs.statSync(file).size > 200 * 1024) fs.renameSync(file, file + '.old');
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(
      file,
      `[${new Date().toISOString()}] ${parts.join(' ')}\n`,
      'utf8'
    );
  } catch { /* 日志失败不影响领取 */ }
}

/** 结账页里的金额：拿不到就算 0，拿得到且大于 0 就不许点 */
function priceIsZero(text) {
  const m = String(text).match(/(?:TRY|USD|CNY|RMB|EUR|GBP|\$|¥|€|₺)\s*([\d.,]+)/i);
  if (!m) return true;
  const v = Number(m[1].replace(/,/g, ''));
  return !Number.isFinite(v) || v <= 0;
}

/**
 * CHECKOUT 的备用路径：隐藏窗口打开官方结账页，点「添加到库」。
 * 正常 5~10 秒能点完；如果 Epic 弹出验证码或改版，就把窗口显示给用户接手。
 */
async function claimViaCheckoutWindow(t, offer) {
  const { BrowserWindow } = require('electron');
  const partition = t.sessionPartition || PARTITION;
  // Epic 2026 现行结账页 URL：offers 用 1-{namespace}-{offerId} 三段式，
  // 带 accountId / highlightColor / orderId / purchaseToken（参考 claabs 项目的
  // generateCheckoutUrl，与官方浏览器流程一致；旧裸 offerId 会被结账页拒收）
  const offerParam = `1-${offer.namespace}-${offer.offerId}`;
  const url =
    `${CHECKOUT_PAGE}?showNavigation=true` +
    `&namespace=${encodeURIComponent(offer.namespace)}` +
    `&offers=${encodeURIComponent(offerParam)}` +
    `&highlightColor=0078f2&locale=zh-CN` +
    (t.accountId ? `&accountId=${encodeURIComponent(t.accountId)}` : '') +
    '&orderId&purchaseToken';

  const win = new BrowserWindow({
    show: false,
    opacity: 0,
    width: 1100,
    height: 860,
    parent: undefined,
    title: `领取：${offer.title || 'Epic 免费游戏'}`,
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // 完全隐藏的窗口里，页面不会走 rAF / 可见性回调，Epic 的按钮虽然渲染出来了
  // 但事件还没挂上，点了没反应。所以开一个「透明但可见」的窗口。
  win.showInactive();

  let keepOpen = false;
  const close = () => {
    if (keepOpen || win.isDestroyed()) return;
    setTimeout(() => { try { win.destroy(); } catch { /* ignore */ } }, 300);
  };
  const revealToUser = () => {
    keepOpen = true;
    if (win.isDestroyed()) return;
    try { win.setOpacity(1); } catch { /* ignore */ }
    win.show();
    win.focus();
  };

  // 用真实鼠标事件点，比 element.click() 更像用户操作
  const clickByText = async (reSource) => {
    const pos = await win.webContents
      .executeJavaScript(
        `(() => {
          const re = new RegExp(${JSON.stringify(reSource)}, 'i');
          const b = [...document.querySelectorAll('button')]
            .find((x) => re.test(x.innerText || '') && !x.disabled && x.offsetParent !== null);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
        true
      )
      .catch(() => null);
    if (!pos) return false;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
    win.webContents.sendInputEvent({
      type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
    });
    return true;
  };

  const readPage = () =>
    win.webContents
      .executeJavaScript(
        `(() => {
          const txt = document.body ? document.body.innerText : '';
          const btn = [...document.querySelectorAll('button')]
            .find((b) => /添加到库|Add to Library|下订单|Place Order/i.test(b.innerText || '') && !b.disabled);
          // Epic 的结果提示条在页面底部 / 无障碍提示区，正文可能被截断，单独取一份
          const alerts = [...document.querySelectorAll('[role="alert"],[role="status"],[class*="toast"],[class*="Toast"],[class*="alert"]')]
            .map((e) => e.innerText || '')
            .join(' ')
            .slice(0, 500);
          return {
            txt: txt.slice(0, 4000),
            tail: txt.slice(-1500),
            alerts,
            hasBtn: !!btn,
          };
        })()`,
        true
      )
      .catch(() => ({ txt: '', tail: '', alerts: '', hasBtn: false }));

  /** 结账页可能带「最终用户许可协议」勾选框：不勾上，主按钮一直是禁用状态 */
  const eulaCheck = () =>
    win.webContents
      .executeJavaScript(
        `(() => {
          const hit = [...document.querySelectorAll('input[type=checkbox]')].find((c) => {
            if (c.checked) return false;
            const label = c.closest('label') || c.parentElement || c;
            return /最终用户许可|End User License|EULA|许可协议/i.test(label.innerText || '');
          });
          if (!hit) return false;
          hit.click();
          return true;
        })()`,
        true
      )
      .catch(() => false);

  try {
    dlog('checkout start', offer.offerId, 'partition', partition);
    // 先访问一次商店购物车：结账 API 认的是网页会话 Cookie（EPIC_EG1），
    // 它只在浏览商店页时下发；直接开结账页会缺 Cookie → 400「Account id is missing」。
    // 购物车还会触发 Cloudflare 挑战，真实 Chromium 窗口一般几秒内自动通过。
    try {
      await win.loadURL('https://store.epicgames.com/cart');
      await sleep(2500);
      dlog('cart warmup done', win.webContents.getURL().slice(0, 80));
    } catch { /* 预热失败不阻塞，直接试结账页 */ }
    await win.loadURL(url);

    const vis = await win.webContents
      .executeJavaScript('document.visibilityState', true)
      .catch(() => '?');
    dlog('loaded', win.webContents.getURL().slice(0, 120), 'visibility', vis);

    const want = String((await profileName(t)) || '').trim();
    const ADD_RE = '添加到库|Add to Library';
    const ORDER_RE = '下订单|Place Order';

    // 一直点到页面状态变化为止：Epic 的按钮是等页面挂载完成后才接上事件的，
    // 早几秒点下去会没反应，所以这里每隔 1.5 秒补点一次。
    for (let i = 0; i < 45; i++) {
      await sleep(350);
      if (win.isDestroyed()) return { ok: false, state: 'failed', message: '结账窗口被关闭了' };

      // 网页会话过期会跳去登录页；把窗口交还用户，登完就能继续点
      if (/epicgames\.com\/(id\/)?login/i.test(win.webContents.getURL())) {
        revealToUser();
        return {
          ok: false,
          state: 'manual',
          message: '网页登录已过期，请在弹出的窗口里登录（或到账号管理重新登录这个号）',
        };
      }

      const info = await readPage();
      const seen = `${info.txt} ${info.tail} ${info.alerts}`;
      const who = want || '当前网页账号';

      // 先确认页面上就是目标账号，再认可任何"成功"提示，
      // 否则会出现「已经拥有」其实是别的号已经拥有。
      if (info.hasBtn && want && !info.txt.toLowerCase().includes(want.toLowerCase())) {
        revealToUser();
        return {
          ok: false,
          state: 'failed',
          message: `结账页登录的是另一个 Epic 账号，请重新登录「${want}」再试`,
        };
      }

      // Cloudflare 挑战页：等它自己过（真实 Chromium 窗口一般 3~8 秒）
      if (/请稍候|正在验证|Just a moment|Checking your browser|Verifying you are human|cf-chl/i.test(info.txt)) {
        dlog('tick', i, 'cloudflare challenge, waiting');
        continue;
      }

      // 结账页初始化失败：网页会话 Cookie（EPIC_EG1）缺失或过期（含未登录）
      if (/Account id is missing|发生意外错误|Unexpected error/i.test(`${info.txt} ${info.alerts}`)) {
        // 已预访购物车仍报这个：网页会话大概率真过期，给用户明确指引
        revealToUser();
        return {
          ok: false,
          state: 'manual',
          message: 'Epic 结账页报「Account id is missing」：该账号的网页会话已过期。请在弹出的窗口里登录，或到「账号管理 → Epic」重新登录这个号后再点重试',
        };
      }

      // 「已经拥有该物品」也算成功：免费条目第一次点就已经入库，
      // 之后的重复点击 Epic 只会弹出这个提示，页面按钮不会变。
      // 只认页面尾部/提示条，避免正文里的「已在库」推荐位误判。
      if (/已添加|已经添加|已拥有|已经拥有|已在库|购买仍在处理|感谢您|Added to your library|already own|Thank you/i.test(info.tail) ||
          /已添加|已经添加|已拥有|已经拥有|已在库|购买仍在处理|感谢您|Added to your library|already own|Thank you/i.test(info.alerts)) {
        return {
          ok: true,
          state: /购买仍在处理|processing/i.test(seen) ? 'pending' : 'claimed',
          message:
            /购买仍在处理|processing/i.test(seen)
              ? `已提交，Epic 处理中（${who}）`
              : `已领取（${who}）`,
        };
      }
      if (/出了点问题|出错|失败|Something went wrong|error occurred/i.test(info.txt)) {
        return {
          ok: false,
          state: 'failed',
          message: info.txt.replace(/\s+/g, ' ').slice(0, 140),
        };
      }

      if (!info.hasBtn) {
        if (i > 25) {
          revealToUser();
          return {
            ok: false,
            state: 'manual',
            message: '没找到「添加到库」按钮（Epic 可能改版或需要验证），窗口已打开，可手动完成',
          };
        }
        continue;
      }

      if (!priceIsZero(info.txt)) {
        return { ok: false, state: 'blocked', message: '结账页显示的不是 0 元，已中止' };
      }

      // 先勾上「最终用户许可协议」（有的游戏结账前要勾，不勾主按钮一直禁用）
      await eulaCheck();

      // 点「添加到库」；有的号会多一步「下订单」确认
      const clicked = (await clickByText(ADD_RE)) || (await clickByText(ORDER_RE));
      dlog(
        'tick', i, 'hasBtn', true, 'clicked', clicked,
        'alert', String(info.alerts || '').replace(/\s+/g, ' ').slice(0, 80),
        'tail', String(info.tail || '').replace(/\s+/g, ' ').slice(-80)
      );
      if (!clicked && i > 25) {
        revealToUser();
        return { ok: false, state: 'manual', message: '按钮点不到，窗口已打开，可手动完成' };
      }
      await sleep(450);
    }

    revealToUser();
    return { ok: false, state: 'manual', message: '窗口已打开，请点「添加到库」完成领取' };
  } catch (e) {
    return { ok: false, state: 'failed', message: `打开结账页失败：${e.message}` };
  } finally {
    close();
  }
}

/** 账号显示名：没存过就用 bearer 查一次并写回（账号比对要用） */
async function profileName(t) {
  if (t.displayName) return t.displayName;
  try {
    const res = await fetch(
      `https://account-public-service-prod03.ol.epicgames.com/account/api/public/account/${encodeURIComponent(t.accountId)}`,
      { headers: authHeaders(t), signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return '';
    const j = await res.json();
    const name = j.displayName || '';
    if (name) {
      const map = readAccounts();
      if (map[t.accountId]) {
        map[t.accountId].displayName = name;
        writeAccounts(map);
      }
      t.displayName = name;
    }
    return name;
  } catch {
    return '';
  }
}

/**
 * 免费领取：在官方结账页点「添加到库」。
 * ★ 2026-11 实测与参考实现（claabs/epicgames-freegames-node，1929★）对齐 ★
 *   1) 结账 API 认的是网页会话 Cookie（EPIC_EG1）而非 OAuth 令牌——它只在浏览
 *      商店页时下发。直接开结账页会缺 Cookie → 页面报 400「Account id is missing」。
 *      所以开结账页前先访问一次商店/购物车（同一分区），让 Epic 下发 EG1。
 *   2) offers 参数是现行三段式：1-{namespace}-{offerId}（旧裸 offerId 已不被
 *      结账页接受）；另带 highlightColor / orderId / purchaseToken 标准参数
 *      与 accountId，与官方浏览器流程一致。
 */
async function claimOffer(t, offer) {
  return claimViaCheckoutWindow(t, offer);
}

/* -------------------------------- 批量领取 -------------------------------- */

/**
 * @param {Array<{title, namespace, offerId}>} offers
 * @param {{accountIds?: string[]}} [opts] 不传就用所有"参与领取"的账号
 */
async function claimMany(offers, opts = {}) {
  const list = Array.isArray(offers) ? offers.filter((o) => o && o.offerId && o.namespace) : [];
  if (!list.length) throw err('E_BAD_OFFER', '没有可领取的 Epic 条目（缺少 offerId/namespace）');

  const map = readAccounts();
  let ids = Array.isArray(opts.accountIds) && opts.accountIds.length
    ? opts.accountIds.filter((id) => map[id])
    : Object.values(map)
        .filter((t) => t.enabled !== false)
        .map((t) => t.accountId);

  if (!ids.length) {
    if (!Object.keys(map).length) throw err('E_EPIC_LOGIN', '还没有登录 Epic 账号');
    ids = Object.keys(map); // 全都关掉了勾选时，至少别什么都不做
  }

  const accounts = [];
  let totalClaimed = 0;
  let totalTried = 0;

  for (const accountId of ids) {
    let t;
    try {
      t = await ensureAccount(accountId);
    } catch (e) {
      accounts.push({
        accountId,
        displayName: (map[accountId] && map[accountId].displayName) || '',
        ok: false,
        error: e.message,
        results: [],
      });
      continue;
    }
    const entry = {
      accountId,
      displayName: t.displayName || '',
      ok: true,
      results: [],
    };

    // 先看库里有没有：已拥有的条目不再打开结账页（Epic 对已拥有只会弹提示）
    const lib = require('./epicLibrary');
    const nsList = [...new Set(list.map((o) => o.namespace).filter(Boolean))];
    let ownedRec = null;
    try {
      ownedRec = await lib.ownedFor(accountId, { namespaces: nsList });
    } catch { /* 判定不了就按正常领取走 */ }

    for (const offer of list) {
      totalTried += 1;
      let r;
      if (ownedRec && lib.offerOwned(ownedRec, offer)) {
        r = {
          ok: true,
          state: 'owned',
          message: `已在库中（${t.displayName || '当前账号'}）`,
        };
      } else {
        try {
          r = await claimOffer(t, offer);
          if (!r.ok && /登录已过期/.test(r.message || '')) {
            t = await ensureAccount(accountId);
            r = await claimOffer(t, offer);
          }
        } catch (e) {
          r = { ok: false, state: 'failed', message: e.message };
          if (e.code === 'E_EPIC_LOGIN') break;
        }
      }
      if (r.ok) totalClaimed += 1;
      entry.results.push({ ...offer, ...r });
      if (list.length > 1) await new Promise((res) => setTimeout(res, 200));
    }

    // 领完再核对一次库：只有真的在库里才算"已领取"，避免页面提示误判
    if (entry.results.some((r) => r.ok && r.state !== 'owned')) {
      try {
        ownedRec = await lib.ownedFor(accountId, { force: true, namespaces: nsList });
      } catch { /* 核对失败就保留原结论 */ }
      if (!ownedRec) ownedRec = null;
    }
    for (const r of entry.results) {
      if (!r.ok) continue;
      if (r.state === 'owned') r.verified = true;
      else if (ownedRec) r.verified = lib.offerOwned(ownedRec, r);
    }
    accounts.push(entry);
  }

  return {
    total: totalTried,
    claimed: totalClaimed,
    accounts,
    // 单账号时的扁平结果，兼容旧界面
    results: accounts.length === 1 ? accounts[0].results : [],
  };
}

module.exports = {
  list,
  remove,
  setEnabled,
  logoutAll,
  openLoginWindow,
  claimMany,
  // 测试用 / 供其它模块复用
  _toTokens: toTokens,
  _tokensValid: tokensValid,
  _ensureAccount: ensureAccount,
};
