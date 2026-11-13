'use strict';

const crypto = require('crypto');
const fs = require('fs');
const store = require('./store');
const session = require('./session');
const bridge = require('./steamBridge');

/**
 * Steam 手机令牌确认（在软件内点"确认"，不用再掏手机）
 *
 * ★ 为什么必须要 maFile ★
 * 开启手机令牌的账号，市场挂单在 sellitem 之后只是"待确认"，
 * 真正的上架要经过 /mobileconf/ajaxop 的 allow 动作。
 * 这个动作的签名 key 由 identity_secret 计算 HMAC-SHA1 得到，
 * 而 identity_secret 只存在于该账号的认证器文件（maFile）里，
 * 网页 Cookie 里拿不到，Steam 也不提供任何"网页版批准"入口。
 * 所以：想让软件自己点确认，就必须导入一次 maFile。
 *
 * 协议（与 steam-totp / steamcommunity 库一致，已核对源码）：
 *   设备号 p = "android:" + sha1(steamid64) 的 UUID 形式
 *   确认列表 k = HMAC-SHA1(identity_secret, 8字节(0 + time) + "conf")
 *      GET  /mobileconf/getlist?p&a&k&t&m=react&tag=conf
 *   批准单条 k = HMAC-SHA1(identity_secret, 8字节(0 + time) + "allow")
 *      GET  /mobileconf/ajaxop?op=allow&cid&ck&p&a&k&t&m=react&tag=allow
 *
 * 安全约定：
 *   - 只落盘到 store 的加密区（safeStorage），并只保留 identity_secret 与 shared_secret；
 *   - 任何日志/界面都不输出 secret 原文，只输出"已导入"状态。
 */

const SECRET_PREFIX = 'guard:';
const CONFIRM_TYPE_MARKET = 3; // 2=交易确认 3=市场挂单确认

/* --------------------------------- 加密与签名 -------------------------------- */

function bufferizeSecret(secret) {
  const s = String(secret || '').trim();
  // maFile 里通常是 base64；也兼容 40 位 hex
  if (/^[0-9a-f]{40}$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s, 'base64');
}

/** identity_secret 签名：8 字节头（4 字节 0 + 4 字节 time）+ tag */
function confirmationKey(identitySecret, time, tag) {
  const key = bufferizeSecret(identitySecret);
  const tagBuf = Buffer.from(String(tag || ''), 'utf8');
  const buf = Buffer.allocUnsafe(8 + tagBuf.length);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(time >>> 0, 4);
  tagBuf.copy(buf, 8);
  return crypto.createHmac('sha1', key).update(buf).digest('base64');
}

/** 设备号：官方 App 用 android: + sha1(steamid) 的 UUID 形态 */
function deviceId(steamId) {
  const hex = crypto.createHash('sha1').update(String(steamId)).digest('hex');
  const uuid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
  return 'android:' + uuid;
}

/* ----------------------------------- 时间 ---------------------------------- */

let cachedOffset = 0;
let offsetAt = 0;

/** 用 Steam 服务器时间校正本机时钟，差超过 30 秒会让签名失效 */
async function timeOffset() {
  if (Date.now() - offsetAt < 10 * 60 * 1000) return cachedOffset;
  try {
    const res = await fetch('https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', {
      method: 'POST',
      headers: { 'Content-Length': '0' },
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json();
    const server = Number(json && json.response && json.response.server_time);
    if (server) cachedOffset = server - Math.floor(Date.now() / 1000);
  } catch {
    /* 拿不到就用本机时间，签名窗口是 30 秒，一般够用 */
  }
  offsetAt = Date.now();
  return cachedOffset;
}

function nowSteam() {
  return Math.floor(Date.now() / 1000) + cachedOffset;
}

/* --------------------------------- 存储与导入 -------------------------------- */

function saveGuard(steamId, data) {
  store.saveSecret(SECRET_PREFIX + steamId, JSON.stringify(data));
}

function loadGuard(steamId) {
  try {
    const raw = store.readSecret(SECRET_PREFIX + steamId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function currentSteamId() {
  try {
    const ses = await session.getSession();
    return (ses && ses.steamId) || null;
  } catch {
    return null;
  }
}

/** 解析 maFile 文本（Steam Desktop Authenticator 导出的 .maFile） */
function parseMaFile(text) {
  let j;
  try {
    j = JSON.parse(String(text || ''));
  } catch {
    throw Object.assign(new Error('不是有效的 maFile（应为 JSON 文件）'), { code: 'E_BAD_MAFILE' });
  }
  const identity = j.identity_secret || j.identitySecret || '';
  const shared = j.shared_secret || j.sharedSecret || '';
  const steamId = String(
    (j.Session && (j.Session.SteamID || j.Session.SteamID64)) || j.steamid || j.steamId || ''
  );
  const accountName = j.account_name || j.accountName || '';
  if (!identity) {
    throw Object.assign(
      new Error('maFile 里没有 identity_secret（需要 SDA 导出的完整文件，不是只有 shared_secret）'),
      { code: 'E_BAD_MAFILE' }
    );
  }
  return { identity, shared, steamId, accountName };
}

/** 导入：text 为 maFile 的 JSON 内容 */
async function link(text) {
  const p = parseMaFile(text);
  const ses = await session.getSession();
  const steamId = p.steamId.match(/^\d{17}$/) ? p.steamId : (ses && ses.steamId) || p.steamId;
  if (!steamId || !/^\d{17}$/.test(String(steamId))) {
    throw Object.assign(new Error('无法确定该 maFile 对应的 SteamID，请先在软件里登录该账号'), {
      code: 'E_NO_STEAMID',
    });
  }
  saveGuard(steamId, {
    identitySecret: p.identity,
    sharedSecret: p.shared || '',
    accountName: p.accountName || '',
    at: Date.now(),
  });
  // 导入的 maFile 和当前登录账号不是同一个时，要明确告诉用户，
  // 否则会以为"导入了却没生效"（密钥存到了另一个账号名下）
  const sessionId = (ses && ses.steamId) || '';
  return {
    steamId,
    accountName: p.accountName || '',
    sessionSteamId: sessionId || null,
    mismatch: !!(sessionId && String(sessionId) !== String(steamId)),
  };
}

/** 从文件导入（主进程弹文件框后调用） */
async function linkFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return link(text);
}

async function status() {
  const steamId = await currentSteamId();
  const g = steamId ? loadGuard(steamId) : null;
  return {
    steamId: steamId || null,
    linked: !!(g && g.identitySecret),
    accountName: g ? g.accountName || '' : '',
    linkedAt: g ? g.at || 0 : 0,
  };
}

async function unlink() {
  const steamId = await currentSteamId();
  if (!steamId) return { ok: false };
  try {
    store.removeSecret(SECRET_PREFIX + steamId);
  } catch { /* ignore */ }
  return { ok: true };
}

/* ---------------------------------- 确认列表 --------------------------------- */

async function getConfirmations(steamId, identitySecret) {
  await timeOffset();
  const time = nowSteam();
  const key = confirmationKey(identitySecret, time, 'conf');
  const u = new URL('https://steamcommunity.com/mobileconf/getlist');
  u.searchParams.set('p', deviceId(steamId));
  u.searchParams.set('a', String(steamId));
  u.searchParams.set('k', key);
  u.searchParams.set('t', String(time));
  u.searchParams.set('m', 'react');
  u.searchParams.set('tag', 'conf');

  const res = await bridge.request(u.toString(), {
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`确认列表返回异常（HTTP ${res.status}）`), { code: 'E_BAD_CONF' });
  }
  if (json.needauth) {
    throw Object.assign(new Error('社区登录态失效，请重新网页登录'), { code: 'E_AUTH' });
  }
  if (!json.success) {
    throw Object.assign(new Error(json.message || json.detail || '无法读取确认列表'), { code: 'E_CONF_FAILED' });
  }
  return { time, confs: Array.isArray(json.conf) ? json.conf : [] };
}

async function allowOne(steamId, identitySecret, conf, time, index) {
  const t = time + index; // 每个请求用不同时间戳，避免"复用 key"
  const key = confirmationKey(identitySecret, t, 'allow');
  const u = new URL('https://steamcommunity.com/mobileconf/ajaxop');
  u.searchParams.set('op', 'allow');
  u.searchParams.set('cid', String(conf.id));
  u.searchParams.set('ck', String(conf.nonce));
  u.searchParams.set('p', deviceId(steamId));
  u.searchParams.set('a', String(steamId));
  u.searchParams.set('k', key);
  u.searchParams.set('t', String(t));
  u.searchParams.set('m', 'react');
  u.searchParams.set('tag', 'allow');

  const res = await bridge.request(u.toString(), {
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 下面统一报错 */ }
  if (json && json.success) return { ok: true };
  return {
    ok: false,
    error: (json && (json.message || json.detail)) || `HTTP ${res.status}`,
  };
}

/**
 * 在软件内确认市场挂单。
 * @param {object} [opts]
 * @param {number[]} [opts.creators] 只确认这些 listing id（服务端返回的 creator_id 即 listingid）
 * @param {boolean} [opts.all] true 时连交易确认一起批准（默认只批准市场挂单）
 */
async function confirmMarketListings(opts = {}) {
  const steamId = await currentSteamId();
  if (!steamId) throw Object.assign(new Error('没有可用的登录会话'), { code: 'E_NO_SESSION' });
  const g = loadGuard(steamId);
  if (!g || !g.identitySecret) {
    throw Object.assign(new Error('未导入手机令牌（maFile），无法在软件内确认'), { code: 'E_NO_GUARD' });
  }

  const { time, confs } = await getConfirmations(steamId, g.identitySecret);
  const wantCreators = Array.isArray(opts.creators) && opts.creators.length
    ? new Set(opts.creators.map(String))
    : null;

  const targets = confs.filter((c) => {
    const type = Number(c.type);
    if (!opts.all && type !== CONFIRM_TYPE_MARKET) return false;
    if (wantCreators && !wantCreators.has(String(c.creator_id))) return false;
    return true;
  });

  const failed = [];
  let confirmed = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = await allowOne(steamId, g.identitySecret, targets[i], time, i + 1);
    if (r.ok) confirmed++;
    else failed.push({ id: String(targets[i].id), error: r.error });
    // 逐条之间稍微间隔，避免触发限流
    if (i < targets.length - 1) await new Promise((r2) => setTimeout(r2, 350));
  }

  return {
    total: confs.length,
    targeted: targets.length,
    confirmed,
    failed,
  };
}

/** 校验导入的令牌是否可用：只读确认列表，不做任何批准动作 */
async function check() {
  const steamId = await currentSteamId();
  if (!steamId) throw Object.assign(new Error('请先登录该账号'), { code: 'E_NO_SESSION' });
  const g = loadGuard(steamId);
  if (!g || !g.identitySecret) {
    throw Object.assign(new Error('未导入手机令牌'), { code: 'E_NO_GUARD' });
  }
  const { confs } = await getConfirmations(steamId, g.identitySecret);
  return {
    ok: true,
    count: confs.length,
    market: confs.filter((c) => Number(c.type) === CONFIRM_TYPE_MARKET).length,
  };
}

module.exports = {
  status,
  check,
  link,
  linkFromFile,
  unlink,
  confirmMarketListings,
  // 仅测试用
  _confirmationKey: confirmationKey,
  _deviceId: deviceId,
};
