'use strict';

/**
 * QQ 机器人（q.qq.com 开放平台）推送
 *
 * 现实限制：腾讯 2025 年 4 月起关闭了 QQ 群聊 / 私聊的「主动消息」能力，
 * 机器人不能再主动私聊用户。频道（QQ 频道的文字子频道）仍然可以主动推送，
 * 所以这里的做法是：把消息发到机器人所在的某个文字子频道，手机 QQ 里能收到。
 *
 * 流程：
 *   1. AppID + AppSecret 换 access_token：POST https://bots.qq.com/app/getAppAccessToken
 *   2. GET /users/@me/guilds 列出机器人加入的频道
 *   3. GET /guilds/{guild_id}/channels 列出子频道（type 0 是文字频道）
 *   4. POST /channels/{channel_id}/messages 发消息
 *
 * AppSecret 存加密区，不回显；access_token 缓存到过期前 1 分钟。
 */

const https = require('https');
const { URL } = require('url');
const store = require('./store');
const logger = require('./logger');

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const TIMEOUT_MS = 15000;

let cache = { appId: '', token: '', expiresAt: 0 };

function err(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function config() {
  const s = store.getSettings();
  let secret = '';
  try {
    secret = store.readSecret('notify:qqSecret') || '';
  } catch {
    /* 加密区读失败按未配置处理 */
  }
  return {
    appId: String(s.qqAppId || '').trim(),
    secret,
    guildId: String(s.qqGuildId || '').trim(),
    channelId: String(s.qqChannelId || '').trim(),
    channelName: String(s.qqChannelName || '').trim(),
  };
}

function requestJson(method, urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(err('E_QQ_URL', 'QQ 接口地址不对'));
      return;
    }
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers: {
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
          'User-Agent': 'SteamDesk-QQBot/1.0',
          ...(headers || {}),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (text.length < 4000) text += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 少数错误页不是 JSON */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json || {});
            return;
          }
          const msg =
            (json && (json.message || json.err_msg || json.msg)) ||
            text.slice(0, 160) ||
            `HTTP ${res.statusCode}`;
          reject(err('E_QQ_HTTP', `QQ 接口返回 ${res.statusCode}：${msg}`, res.statusCode));
        });
      }
    );
    req.on('timeout', () => req.destroy(err('E_QQ_TIMEOUT', '连接 QQ 接口超时')));
    req.on('error', (e) => reject(e.code ? e : err('E_QQ_NET', e.message || '网络错误')));
    if (body) req.write(body);
    req.end();
  });
}

async function getToken(force) {
  const cfg = config();
  if (!cfg.appId) throw err('E_QQ_CONFIG', '还没有填写 QQ 机器人的 AppID');
  if (!cfg.secret) throw err('E_QQ_CONFIG', '还没有填写 QQ 机器人的 AppSecret');
  if (!force && cache.token && cache.appId === cfg.appId && Date.now() < cache.expiresAt) {
    return cache.token;
  }
  const r = await requestJson('POST', TOKEN_URL, { appId: cfg.appId, clientSecret: cfg.secret });
  if (!r || !r.access_token) {
    const detail = (r && (r.message || r.msg || r.err_msg || r.error_description)) || '';
    throw err(
      'E_QQ_TOKEN',
      `换取 access_token 失败，请检查 AppID / AppSecret${detail ? `（${detail}）` : ''}`
    );
  }
  const ttl = Math.max(60, Number(r.expires_in) || 7200) * 1000;
  cache = { appId: cfg.appId, token: r.access_token, expiresAt: Date.now() + ttl - 60 * 1000 };
  return cache.token;
}

async function api(method, path, body) {
  const cfg = config();
  const call = async (token) =>
    requestJson(method, `${API_BASE}${path}`, body, {
      Authorization: `QQBot ${token}`,
      'X-Union-Appid': cfg.appId,
    });
  let token = await getToken(false);
  try {
    return await call(token);
  } catch (e) {
    // token 被提前作废时重取一次
    if (e && e.status === 401) {
      token = await getToken(true);
      return call(token);
    }
    throw e;
  }
}

/** 机器人加入的频道（QQ 频道） */
async function listGuilds() {
  const list = await api('GET', '/users/@me/guilds?limit=100');
  return Array.isArray(list) ? list.map((g) => ({ id: String(g.id), name: g.name || String(g.id) })) : [];
}

/** 某个频道下的子频道，过滤出可以发消息的文字频道 */
async function listChannels(guildId) {
  if (!guildId) throw err('E_QQ_CONFIG', '缺少频道 ID');
  const list = await api('GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
  return (Array.isArray(list) ? list : [])
    .filter((c) => Number(c.type) === 0)
    .map((c) => ({ id: String(c.id), name: c.name || String(c.id), guildId: String(guildId) }));
}

/** 一次列出所有频道里的文字子频道，设置页下拉用 */
async function listTargets() {
  const guilds = await listGuilds();
  const out = [];
  for (const g of guilds.slice(0, 20)) {
    try {
      const cs = await listChannels(g.id);
      for (const c of cs) out.push({ ...c, guildName: g.name });
    } catch (e) {
      logger.warn('读取 QQ 子频道失败', { guild: g.name, message: e && e.message });
    }
  }
  return out;
}

async function sendToChannel(channelId, content) {
  const text = String(content || '').trim();
  if (!text) throw err('E_QQ_EMPTY', '消息内容为空');
  const cid = String(channelId || '').trim();
  if (!cid) throw err('E_QQ_CONFIG', '还没有选择要推送的 QQ 子频道');
  await api('POST', `/channels/${encodeURIComponent(cid)}/messages`, { content: text.slice(0, 1900) });
  return { ok: true, channelId: cid };
}

/** notify.js 的统一入口：用设置里保存的子频道 */
async function sendText(content) {
  const cfg = config();
  if (!cfg.channelId) throw err('E_QQ_CONFIG', '还没有选择要推送的 QQ 子频道');
  return sendToChannel(cfg.channelId, content);
}

async function test() {
  const cfg = config();
  const target = cfg.channelName || cfg.channelId || '未选择子频道';
  await sendText(`【SteamDesk】测试通知\nQQ 机器人已连通，推送目标：${target}\n收到这条说明配置可用。`);
  return { ok: true, target };
}

module.exports = { config, getToken, listTargets, sendToChannel, sendText, test };
