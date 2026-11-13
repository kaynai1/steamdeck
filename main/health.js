'use strict';

/**
 * 账号体检
 *
 * 逐个账号检查"现在还能不能用"，而不是等用户点了拉库存才发现失败：
 *   1) 有没有保存过这个号的网页 Cookie（没有就没法单独读它的库存）；
 *   2) 保存的 Cookie 还能不能通过 Steam 的登录校验；
 *   3) 是不是本机 Steam 当前登录的号；
 *   4) 有没有导入手机令牌（决定能不能在软件里点确认）。
 *
 * 校验方式：拿这个号自己的 Cookie 去请求 /my/profile。
 * 未登录时 Steam 会 302 到 /login，已登录则 200 或 302 到个人主页。
 * 不经过会话通道窗口，所以不会把当前登录号的 Cookie 混进来。
 */

const store = require('./store');
const logger = require('./logger');
const accounts = require('./steamAccounts');
const session = require('./session');
const notify = require('./notify');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHECK_MS = 3 * 60 * 60 * 1000;
const FIRST_DELAY = 3 * 60 * 1000;

let timer = null;
let last = null;
let iconPath = '';
let onAlert = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读取这个号保存的社区 Cookie（登录成功时存进加密区的备份） */
function savedCookies(steamId) {
  try {
    const raw = store.readSecret(`cookies:${steamId}`);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && c.steamLoginSecure ? c : null;
  } catch {
    return null;
  }
}

function hasGuard(steamId) {
  try {
    return !!store.readSecret(`guard:${steamId}`);
  } catch {
    return false;
  }
}

/** 用某个号自己的 Cookie 请求一次个人主页，判断会话是否有效 */
async function checkCookies(cookies) {
  const header = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://steamcommunity.com/my/profile?l=schinese', {
      redirect: 'manual',
      headers: {
        Cookie: header,
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ctrl.signal,
    });
    const loc = String(res.headers.get('location') || '');
    if (res.status >= 300 && res.status < 400) {
      if (/\/login|signin/i.test(loc)) {
        return { ok: false, text: '网页会话已过期（被跳回登录页）' };
      }
      return { ok: true, text: '会话有效' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, text: `会话无效（HTTP ${res.status}）` };
    }
    if (res.ok) return { ok: true, text: '会话有效' };
    return { ok: false, text: `Steam 返回 HTTP ${res.status}` };
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    // network 标记给渲染层用：网络不通不等于 Cookie 失效，别把它排进批量登录队列
    return {
      ok: false,
      network: true,
      text: timeout ? '检查超时（网络或代理问题）' : `网络失败：${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 市场页/挂单接口里出现的限制文案（中英文都收） */
const RESTRICT_PATTERNS = [
  /无法使用\s*Steam\s*社区市场/i,
  /不能使用\s*Steam\s*社区市场/i,
  /账户.{0,12}(受到限制|被限制|已被限制)/,
  /been banned from using the Steam Community Market/i,
  /unable to use the Steam Community Market/i,
  /account (has been|is) (restricted|limited)/i,
  /your account is (restricted|limited)/i,
];

/**
 * 检查这个号能不能用 Steam 社区市场。
 * 有会话不等于能卖：红信、令牌未满 7 天、市场限制都会让挂单全部失败，
 * 但 /my/profile 仍然返回 200。这里直接读挂单接口的判断结果。
 */
async function checkMarket(cookies) {
  const header = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://steamcommunity.com/market/mylistings?norender=1&count=1', {
      redirect: 'manual',
      headers: {
        Cookie: header,
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: 'application/json, text/html;q=0.8',
      },
      signal: ctrl.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = String(res.headers.get('location') || '');
      if (/\/login|signin/i.test(loc)) {
        return { ok: false, restricted: false, text: '读取市场时被跳回登录页' };
      }
      return { ok: true, restricted: false, text: '市场可用' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, restricted: true, text: `市场接口拒绝访问（HTTP ${res.status}）` };
    }
    const text = (await res.text()).slice(0, 20000);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 有些账号会返回 HTML 限制页 */
    }
    if (json && json.success === false) {
      const msg = String(json.message || json.error || '市场不可用').slice(0, 120);
      return { ok: false, restricted: true, text: msg };
    }
    if (json && json.success === true) {
      return { ok: true, restricted: false, text: '市场可用' };
    }
    for (const re of RESTRICT_PATTERNS) {
      if (re.test(text)) {
        return { ok: false, restricted: true, text: '账号被限制使用社区市场（红信/令牌不足 7 天等）' };
      }
    }
    if (res.ok) return { ok: true, restricted: false, text: '市场可用' };
    return { ok: false, restricted: false, text: `市场接口返回 HTTP ${res.status}` };
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    return {
      ok: false,
      restricted: false,
      network: true,
      text: timeout ? '市场检查超时（网络或代理问题）' : `市场检查失败：${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function check() {
  const scan = accounts.scanAccounts();
  const live = await session.getSession().catch(() => null);
  const liveId = (live && live.steamId) || null;
  const rows = [];

  for (const u of scan.users) {
    const cookies = savedCookies(u.steamId);
    const row = {
      steamId: u.steamId,
      name: u.personaName || u.accountName || u.steamId,
      accountName: u.accountName || '',
      online: u.steamId === liveId,
      hasSession: !!cookies,
      guard: hasGuard(u.steamId),
      ssfn: (u.ssfnFiles || []).length,
      autoLogin: !!u.allowAutoLogin,
      cookie: { ok: false, text: '没有保存的网页会话（只能读公开库存）' },
      market: { ok: false, restricted: false, text: '未检查' },
      ok: false,
      issue: '',
    };
    if (cookies) {
      row.cookie = await checkCookies(cookies);
      await sleep(400);
      if (row.cookie.ok) {
        row.market = await checkMarket(cookies);
        await sleep(400);
      } else {
        row.market = { ok: false, restricted: false, text: '会话无效，未检查市场' };
      }
    }
    row.ok = row.hasSession && row.cookie.ok;
    if (!row.hasSession) row.issue = '没有网页 Cookie：到账号管理里点「登录」';
    else if (!row.cookie.ok) row.issue = row.cookie.text;
    else if (row.market.restricted) row.issue = `市场受限：${row.market.text}`;
    else if (row.market.ok === false && !row.market.network) row.issue = row.market.text;
    rows.push(row);
  }

  const okCount = rows.filter((r) => r.ok).length;
  const restrictedRows = rows.filter((r) => r.market && r.market.restricted);
  const result = {
    at: Date.now(),
    liveId,
    total: rows.length,
    ok: okCount,
    restricted: restrictedRows.length,
    rows,
  };

  // 定时巡检：只对"上次还能用、这次失效"和"新出现市场受限"的账号提醒，首次运行不吵
  if (last) {
    const before = new Map((last.rows || []).map((r) => [r.steamId, r]));
    const broke = rows.filter((r) => {
      const p = before.get(r.steamId);
      return p && p.ok && !r.ok;
    });
    const newlyRestricted = restrictedRows.filter((r) => {
      const p = before.get(r.steamId);
      return !p || !p.market || !p.market.restricted;
    });

    if (broke.length) {
      logger.warn('账号会话失效', { count: broke.length });
      notify.send(
        `${broke.length} 个账号的网页会话失效`,
        broke
          .slice(0, 3)
          .map((r) => `${r.name}：${(r.cookie && r.cookie.text) || '需要重新登录'}`)
          .join('\n'),
        { onClick: onAlert }
      );
    }
    if (newlyRestricted.length) {
      logger.warn('账号市场受限', { count: newlyRestricted.length });
      notify.send(
        `${newlyRestricted.length} 个账号被限制使用社区市场`,
        newlyRestricted
          .slice(0, 3)
          .map((r) => `${r.name}：${r.market.text}`)
          .join('\n') + '\n受限账号无法挂单，请先在 Steam 上确认状态。',
        { onClick: onAlert }
      );
    }
  }

  last = result;
  logger.info('账号体检完成', { total: rows.length, ok: okCount, restricted: restrictedRows.length });
  return result;
}

function getLast() {
  return last;
}

function getState() {
  const s = store.getSettings();
  return {
    watch: s.healthWatch !== false,
    intervalHours: 3,
    lastAt: last ? last.at : 0,
    ok: last ? last.ok : 0,
    total: last ? last.total : 0,
    restricted: last ? Number(last.restricted) || 0 : 0,
  };
}

function setWatch(on) {
  store.setSettings({ healthWatch: !!on });
  logger.info('定时账号巡检开关', { enabled: !!on });
  return { watch: !!on };
}

function start(opts = {}) {
  iconPath = opts.icon || '';
  notify.start({ icon: iconPath });
  onAlert = opts.onAlert || null;
  if (timer) return;
  // 维护模式：暂停后台自动检查（手动点「账号体检」不受影响）
  const autoOn = () =>
    store.getSettings().healthWatch !== false && store.getSettings().automationPaused !== true;
  setTimeout(() => {
    if (autoOn()) check().catch(() => {});
    timer = setInterval(() => {
      if (autoOn()) check().catch(() => {});
    }, CHECK_MS);
  }, FIRST_DELAY);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { check, getLast, getState, setWatch, start, stop };
