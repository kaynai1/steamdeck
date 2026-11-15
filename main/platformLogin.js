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

/** 在登录窗口里注入「网络受限」提示条（不关闭窗口，保留完成人机验证的机会） */
const RISK_PAGE_RE = /访问暂时受限|我不是机器人|are you a robot|robot check|unusual traffic|verify you are human/i;
function injectRiskBanner(win) {
  try {
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript(`(
      function(){
        if (document.getElementById('sdnet-notice')) return 0;
        var d = document.createElement('div');
        d.id = 'sdnet-notice';
        d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b45309;color:#fff;font:12px/1.5 system-ui,sans-serif;padding:9px 12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer';
        d.textContent = '⚠ 平台风控拦截了当前网络（多为机房/代理 IP）。若本页有「我不是机器人」验证，完成它后可继续登录；若没有验证入口，请改用家庭宽带直连环境（完全退出 Clash/v2rayN 含 TUN）后重试。点此关闭。';
        d.onclick = function(){ d.remove(); };
        (document.body || document.documentElement).appendChild(d);
        return 1;
      }
    )()`, true).catch(() => {});
  } catch { /* ignore */ }
}

/** 打开某平台登录窗口；检测到登录态后自动关闭。
 * 2026-11 实测结论（育碧/EA/暴雪登录窗口全部强制直连，不再读系统代理）：
 *  - 三平台登录域名国内直连均可达；
 *  - 跟随系统代理会产生两类故障：①Clash 已退出但系统代理残留 → ERR_PROXY_CONNECTION_FAILED；
 *    ②代理出口是机房 IP（香港/IDC）→ 平台风控直接拦截；
 *  - 因此默认直接直连；仅当直连加载失败时，回退读系统代理再试一次（兼顾必须代理的受限网络）。 */
async function openLoginWindow(platform, parent) {
  const cfg = cfgOf(platform);
  const ses = session.fromPartition(cfg.partition);
  // ① 强制直连（等真正生效再开窗，避免窗口首个请求仍走旧代理设置）
  try { await ses.setProxy({ mode: 'direct' }); } catch { /* ignore */ }

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

    timer = setInterval(async () => {
      try {
        // 只认精确登录判定（平台真实会话 Cookie / 暴雪接口验证）。
        // 不再用「离开登录页 + Cookie 数量 ≥8」启发式——匿名访问官网就会种 8+ 个跟踪 Cookie，
        // 会造成「没登录却自动关窗并显示已登录」（2.6.78~2.6.81 的实际故障根源）
        const st = await status(platform);
        if (st.linked) {
          finish(resolve, st);
        }
      } catch { /* 继续等 */ }
    }, 2500);

    // 风控拦截页：注入提示条但不关窗，给用户完成验证/换网的机会
    win.webContents.on('did-finish-load', () => {
      try {
        if (settled || win.isDestroyed()) return;
        win.webContents.executeJavaScript(`(document.title||'')+'|'+(((document.body&&document.body.innerText)||'').slice(0,500))`, true)
          .then((t) => {
            const s = String(t || '');
            if (RISK_PAGE_RE.test(s)) injectRiskBanner(win);
          })
          .catch(() => {});
      } catch { /* ignore */ }
    });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        if (timer) clearInterval(timer);
        reject(Object.assign(new Error(`已关闭 ${cfg.label} 登录窗口`), { code: 'E_CANCELLED' }));
      }
    });

    const friendErr = (raw) => {
      if (/ERR_PROXY_CONNECTION_FAILED|PROXY/i.test(raw)) {
        return `${cfg.label} 登录页加载失败：${raw}。原因：电脑上的代理设置指向了一个不可用的地址（常见于 Clash 退出后系统代理开关残留）。已自动改为直连重试；若仍失败，请到系统设置里关闭代理，或开启可用的代理软件。`;
      }
      if (/NAME_NOT_RESOLVED|ERR_NAME|TIMED_OUT|ERR_CONNECTION|refused/i.test(raw)) {
        return `${cfg.label} 登录页直连失败（${raw}）。你的网络环境可能需要代理才能访问：开启 Clash / v2rayN 的「系统代理」后重试（若软件提示风控拦截，换回直连）。`;
      }
      return `${cfg.label} 登录页打开失败：${raw}`;
    };

    win.loadURL(cfg.loginUrl).catch(async (e) => {
      const raw = (e && e.message) || String(e || '加载失败');
      if (settled) return;
      // ② 直连失败：回退跟随系统代理重试一次（兼顾受限网络环境）
      if (!win.isDestroyed() && /NAME_NOT_RESOLVED|ERR_NAME|TIMED_OUT|ERR_CONNECTION|refused/i.test(raw)) {
        try {
          const proxy = String(store.getSettings().loginProxy || '').trim();
          await ses.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' });
          await win.loadURL(cfg.loginUrl);
          logger.info('平台登录窗口已回退代理模式', { platform, raw: raw.slice(0, 80) });
          return;
        } catch (e2) {
          finish(reject, Object.assign(new Error(friendErr((e2 && e2.message) || raw)), { code: 'E_LOAD' }));
          return;
        }
      }
      finish(reject, Object.assign(new Error(friendErr(raw)), { code: 'E_LOAD' }));
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
