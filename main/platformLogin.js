'use strict';

/**
 * 平台网页登录（Ubisoft / EA / 暴雪战网）
 *
 * 与 GOG 登录同一套路：每个平台一个独立 persist 分区，
 * 用内嵌窗口让用户在官方页面登录，Cookie 只留在本机分区。
 * 登录态检测分两层：
 *   1. 分区里出现平台会话 Cookie（token/session/auth 类命名且值足够长）；
 *   2. 登录窗口的 URL 已离开登录页且域名 Cookie 明显增多。
 * 这些平台没有公开的库/促销 API，登录态先落本机，
 * 供账号管理展示与后续功能（网页领取、库同步）使用。
 */

const { BrowserWindow, session, net } = require('electron');
const store = require('./store');
const logger = require('./logger');

const PLATFORMS = {
  ubisoft: {
    label: 'Ubisoft',
    partition: 'persist:plat-ubisoft',
    // 2026-11 实测：login.ubisoft.com 在部分国内网络 DNS 直接解析失败（ERR_NAME_NOT_RESOLVED）；
    // account.ubisoft.com 实测可达且同样承载登录流程，登录后再 302 到账号中心。
    loginUrl: 'https://account.ubisoft.com/zh-CN/login',
    domain: 'ubisoft.com',
    // 登录成功后种的会话 Cookie（任一命中即视为已登录）
    markers: ['UserID', 'sid', 'ubid_main', 'Ubi-Webauth', 'twoStepSid'],
    storeUrl: 'https://store.ubisoft.com/',
    loginHosts: ['login.ubisoft.com', 'account.ubisoft.com/login'],
  },
  ea: {
    label: 'EA',
    partition: 'persist:plat-ea',
    loginUrl: 'https://www.ea.com/',
    domain: 'ea.com',
    markers: ['sauthob', 'sauthdata', 's_sauth'],
    storeUrl: 'https://www.ea.com/games',
    loginHosts: ['accounts.ea.com', 'signin.ea.com'],
  },
  blizzard: {
    label: '暴雪战网',
    partition: 'persist:plat-blizzard',
    loginUrl: 'https://battle.net/login/?loginLocale=zhCN',
    domain: 'battle.net',
    markers: ['BA-token', 'BA-sessionid'],
    storeUrl: 'https://shop.battle.net/',
    loginHosts: ['battle.net/login', 'blizzard.com/login'],
  },
};

const COOKIE_MIN_LEN = 24;

function cfgOf(platform) {
  const cfg = PLATFORMS[String(platform || '').toLowerCase()];
  if (!cfg) throw new Error(`未知平台：${platform}`);
  return cfg;
}

/** 会话类 Cookie 命中判断：名单里的名字，或名字带 token/session/auth 且值够长 */
function isSessionCookie(c, cfg) {
  if (cfg.markers.includes(c.name)) return true;
  if (/token|session|auth/i.test(c.name) && String(c.value || '').length >= COOKIE_MIN_LEN) return true;
  return false;
}

/** 登录态：分区里存在该域名的会话 Cookie 即认为已登录 */
async function status(platform) {
  const cfg = cfgOf(platform);
  const ses = session.fromPartition(cfg.partition);
  const cookies = await ses.cookies.get({});
  const domain = cookies.filter((c) => (c.domain || '').replace(/^\./, '').endsWith(cfg.domain));
  const hits = domain.filter((c) => isSessionCookie(c, cfg));
  return {
    platform,
    label: cfg.label,
    linked: hits.length > 0,
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
  // 平台登录域名多数在境外：给这个分区设置代理（loginProxy 优先，否则跟随系统）
  try {
    const ses = session.fromPartition(cfg.partition);
    const proxy = String(store.getSettings().loginProxy || '').trim();
    await ses.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' });
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
