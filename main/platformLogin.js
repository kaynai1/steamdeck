'use strict';

/**
 * 平台网页登录（Ubisoft / EA / 暴雪战网）
 *
 * 与 GOG 登录同一套路：每个平台一个独立 persist 分区，
 * 用内嵌窗口让用户在官方页面登录，Cookie 只留在本机分区。
 * 登录态检测：只认平台真实登录后才会种的会话 Cookie（精确名单）；
 * 不能用「名字带 token/session 且够长」的宽松规则——匿名访客也会种
 * XSRF-TOKEN / sessionTrackingId 等跟踪 Cookie，会造成「没登录却显已登录」。
 * 暴雪战网额外用 games-and-subs 接口探测真伪。
 */

const { BrowserWindow, session, net } = require('electron');
const store = require('./store');
const logger = require('./logger');

const PLATFORMS = {
  ubisoft: {
    label: 'Ubisoft',
    partition: 'persist:plat-ubisoft',
    // 2026-11 实测：login.ubisoft.com 在部分国内网络 DNS 直接解析失败（ERR_NAME_NOT_RESOLVED）；
    // account.ubisoft.com / connect.ubisoft.com 实测可达且同样承载登录流程。
    // 官方页面走直连：用户实测不开 Clash 官网可登；走代理（香港机房 IP）反而被育碧反爬拦截。
    loginUrl: 'https://account.ubisoft.com/zh-CN/login',
    domain: 'ubisoft.com',
    directProxy: true,
    // 登录成功后种的会话 Cookie（仅这些名字算数）
    markers: ['UserID', 'sid', 'ubid_main', 'Ubi-Webauth', 'twoStepSid'],
    storeUrl: 'https://store.ubisoft.com/',
    loginHosts: ['login.ubisoft.com', 'account.ubisoft.com/login'],
  },
  ea: {
    label: 'EA',
    partition: 'persist:plat-ea',
    loginUrl: 'https://www.ea.com/',
    domain: 'ea.com',
    // EA 真实登录后种的 Cookie（remid 是网关身份票据）；
    // 匿名访客只有 ak_bmsc / bm_mi / ealocale 等，不能算登录
    markers: ['remid'],
    storeUrl: 'https://www.ea.com/games',
    loginHosts: ['accounts.ea.com', 'signin.ea.com'],
  },
  blizzard: {
    label: '暴雪战网',
    partition: 'persist:plat-blizzard',
    loginUrl: 'https://battle.net/login/?loginLocale=zhCN',
    domain: 'battle.net',
    // BA-token / BA-sessionid 只在登录后出现；匿名访客的 XSRF-TOKEN / sessionTrackingId 不算
    markers: ['BA-token', 'BA-sessionid'],
    storeUrl: 'https://shop.battle.net/',
    loginHosts: ['battle.net/login', 'blizzard.com/login'],
  },
};

/** 不计入登录判定的噪音 Cookie（跟踪/防跨站/同意类，匿名访问就会种） */
const IGNORE_COOKIE = /^(XSRF-TOKEN$|sessionTrackingId$|deviceTrackingId$|ak_bmsc$|bm_si$|bm_mi$|bm_sz$|_?ga|Optanon|ealocale$|EDGESCAPE_|int_cookie$|ubisoft_consent)/i;

const COOKIE_MIN_LEN = 24;

function cfgOf(platform) {
  const cfg = PLATFORMS[String(platform || '').toLowerCase()];
  if (!cfg) throw new Error(`未知平台：${platform}`);
  return cfg;
}

/** 会话类 Cookie 命中判断：只认名单里的名字，跟踪/CSRF 类一律排除 */
function isSessionCookie(c, cfg) {
  if (IGNORE_COOKIE.test(c.name)) return false;
  return cfg.markers.includes(c.name);
}

/** 登录态：Cookie 名单命中 + 暴雪战网额外接口探测 */
async function status(platform) {
  const cfg = cfgOf(platform);
  const ses = session.fromPartition(cfg.partition);
  const cookies = await ses.cookies.get({});
  const domain = cookies.filter((c) => (c.domain || '').replace(/^\./, '').endsWith(cfg.domain));
  const hits = domain.filter((c) => isSessionCookie(c, cfg));
  let linked = hits.length > 0;
  // 暴雪战网：匿名访客也会带一堆 cookie，直接用 games-and-subs 接口验真身
  if (platform === 'blizzard') {
    try {
      const v = await require('./blizzardAccount').verifySession();
      if (v.ok) linked = v.loggedIn;
      else linked = hits.length > 0;
    } catch { linked = hits.length > 0; }
  }
  return {
    platform,
    label: cfg.label,
    linked,
    cookieCount: domain.length,
    storeUrl: cfg.storeUrl,
  };
}

/** 全部平台状态（账号管理页一次拉齐） */
async function statusAll() {
  const out = {};
  for (const key of Object.keys(PLATFORMS)) {
    try {
      out[key] = await status(key);
    } catch (e) {
      out[key] = { platform: key, label: PLATFORMS[key].label, linked: false, error: e.message };
    }
  }
  return out;
}

/** 打开某平台登录窗口；检测到登录态后自动关闭。
 * 登录窗口走 Chromium 网络栈：优先「登录窗口代理」设置，其次 Windows 系统代理；
 * 育碧/EA/暴雪的登录域名在部分国内网络直连不通（DNS 解析失败），
 * 开系统代理（Clash/v2rayN）即可正常打开。 */
async function openLoginWindow(platform, parent) {
  const cfg = cfgOf(platform);
  // 平台登录域名多数在境外：默认跟随「登录窗口代理 → 系统代理」；
  // Ubisoft 官方页面除外——实测直连可达，走代理（机房 IP）反而被风控拦截
  try {
    const ses = session.fromPartition(cfg.partition);
    if (cfg.directProxy) {
      await ses.setProxy({ mode: 'direct' });
    } else {
      const proxy = String(store.getSettings().loginProxy || '').trim();
      await ses.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' });
    }
  } catch { /* setProxy 失败不阻塞（跟随默认） */ }

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 580,
      height: 800,
      parent: parent || undefined,
      title: `登录 ${cfg.label}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition: cfg.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    let timer = null;
    let lastUrl = '';
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      try {
        if (!win.isDestroyed()) win.close();
      } catch { /* ignore */ }
      fn(arg);
    };

    const leftLogin = () => {
      const url = String(lastUrl || '');
      if (!url) return false;
      return !cfg.loginHosts.some((h) => url.includes(h));
    };

    timer = setInterval(async () => {
      try {
        if (!win.isDestroyed()) lastUrl = win.webContents.getURL();
        const st = await status(platform);
        // 命中会话 Cookie，或已经离开登录页且域名 Cookie 明显变多，都视为登录成功
        if (st.linked || (leftLogin() && st.cookieCount >= 8)) {
          const final = await status(platform);
          finish(resolve, final.linked ? final : { ...final, linked: true });
        }
      } catch { /* 继续等 */ }
    }, 2500);

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        if (timer) clearInterval(timer);
        reject(Object.assign(new Error(`已关闭 ${cfg.label} 登录窗口`), { code: 'E_CANCELLED' }));
      }
    });

    win.loadURL(cfg.loginUrl).catch((e) => {
      const raw = (e && e.message) || String(e || '加载失败');
      // DNS 解析失败 / 连接失败：十有八九是直连不通，直接给可操作的指引
      const hint = /NAME_NOT_RESOLVED|ERR_NAME|TIMED_OUT|ERR_CONNECTION|refused/i.test(raw)
        ? `${cfg.label} 登录页无法直连（${raw}）。育碧/EA/暴雪的登录域名在部分国内网络直连不通：请开启系统代理（Clash / v2rayN 开「系统代理」）或在软件「设置 → 登录窗口代理」里填入代理端口后重试。`
        : `${cfg.label} 登录页打开失败：${raw}`;
      finish(reject, Object.assign(new Error(hint), { code: 'E_LOAD' }));
    });
  });
}

/** 退出：清掉该平台分区的 Cookie */
async function logout(platform) {
  const cfg = cfgOf(platform);
  const ses = session.fromPartition(cfg.partition);
  const cookies = await ses.cookies.get({});
  await Promise.all(
    cookies
      .filter((c) => (c.domain || '').replace(/^\./, '').endsWith(cfg.domain))
      .map((c) => ses.cookies.remove(`https://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`, c.name).catch(() => {}))
  );
  logger.info('平台账号退出', { platform });
  return { platform, linked: false };
}

module.exports = { status, statusAll, openLoginWindow, logout, PLATFORMS };
