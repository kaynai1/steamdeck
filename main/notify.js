'use strict';

/**
 * 统一通知出口
 *
 * 系统通知只在电脑前有效，人离开就完全失联。这里把重要事件同时推到
 * 手机/群里：Telegram、企业微信群机器人、钉钉群机器人、Server酱、通用 Webhook。
 *
 * 约定：
 *   - 外发只是补充，桌面通知照常弹（可用 opts.desktop = false 关掉）；
 *   - 任何外发失败都不抛给业务，只写日志；
 *   - 敏感信息（bot token / webhook 地址 / SendKey）存加密区，不回显给界面；
 *   - 串行发送并限速，避免一批事件同时打满对方接口。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { Notification } = require('electron');
const store = require('./store');
const logger = require('./logger');
const notices = require('./notices');

const TIMEOUT_MS = 15000;
const GAP_MS = 800;
const MAX_QUEUE = 50;

let iconPath = '';
let queue = [];
let sending = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function secret(name) {
  try {
    return store.readSecret(name) || '';
  } catch {
    return '';
  }
}

function settings() {
  return store.getSettings();
}

function channel() {
  const ch = String(settings().notifyChannel || 'none');
  return ['none', 'telegram', 'wecom', 'dingtalk', 'serverchan', 'webhook', 'qqbot'].includes(ch)
    ? ch
    : 'none';
}

function enabled() {
  return channel() !== 'none';
}

/** 已配置状态（给设置界面用，不回显密钥） */
function getState() {
  const s = settings();
  const cfg = s.notifyConfig || {};
  return {
    channel: channel(),
    enabled: channel() !== 'none',
    desktop: s.notifyDesktop !== false,
    tgChat: cfg.tgChat || s.tgChat || '',
    tgToken: !!secret('notify:tgToken'),
    webhook: !!secret('notify:webhook'),
    webhookUrl: secret('notify:webhook') ? maskUrl(secret('notify:webhook')) : '',
    scKey: !!secret('notify:scKey'),
    /* QQ 配置存放在 settings 顶层（与 main.js notify:set / qqbot.js config() 一致）；
       旧版本曾写在 notifyConfig 里，这里兼容读取，避免“填了却显示未配置”。 */
    qqAppId: String(s.qqAppId || cfg.qqAppId || ''),
    qqChannelId: String(s.qqChannelId || cfg.qqChannelId || ''),
    qqChannelName: String(s.qqChannelName || cfg.qqChannelName || ''),
    qqGuildId: String(s.qqGuildId || cfg.qqGuildId || ''),
    qqSecret: !!secret('notify:qqSecret'),
    /* 私聊/群聊绑定状态与实时网关（由 qqbot 提供，供设置页展示绑定进度） */
    qqBinds: require('./qqbot').bindState(),
    qqGateway: require('./qqbot').gatewayState(),
    lastAt: Number(s.notifyLastAt) || 0,
    lastError: String(s.notifyLastError || ''),
  };
}

function maskUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.slice(0, 12)}…`;
  } catch {
    return '已配置';
  }
}

function request(urlStr, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error('通知地址格式不对'));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'User-Agent': 'SteamDesk-Notify/1.0',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (text.length < 2000) text += c;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* 有些渠道返回纯文本 */
            }
            resolve({ status: res.statusCode, text, json });
          } else {
            reject(new Error(`HTTP ${res.statusCode}：${text.slice(0, 160)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('通知发送超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function deliverOne(title, body) {
  const ch = channel();
  const s = settings();
  const cfg = s.notifyConfig || {};
  const text = `【SteamDesk】${title}\n${body}`;

  if (ch === 'telegram') {
    const token = secret('notify:tgToken');
    const chat = String(cfg.tgChat || s.tgChat || '').trim();
    if (!token || !chat) throw new Error('Telegram 未配置 bot token 或 chat id');
    await request(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chat,
      text,
      disable_web_page_preview: true,
    });
    return;
  }

  if (ch === 'wecom') {
    const url = secret('notify:webhook');
    if (!url) throw new Error('企业微信未配置 Webhook 地址');
    await request(url, { msgtype: 'text', text: { content: text } });
    return;
  }

  if (ch === 'dingtalk') {
    const url = secret('notify:webhook');
    if (!url) throw new Error('钉钉未配置 Webhook 地址');
    await request(url, { msgtype: 'text', text: { content: text } });
    return;
  }

  if (ch === 'serverchan') {
    const key = secret('notify:scKey');
    if (!key) throw new Error('Server酱未配置 SendKey');
    const r = await request(`https://sctapi.ftqq.com/${key}.send`, {
      title,
      desp: body.replace(/\n/g, '\n\n'),
    });
    if (r.json && Number(r.json.code) !== 0) {
      throw new Error(r.json.message || 'Server酱返回失败');
    }
    return;
  }

  if (ch === 'webhook') {
    const url = secret('notify:webhook');
    if (!url) throw new Error('通用 Webhook 未配置地址');
    await request(url, { title, body, text, at: Date.now(), app: 'SteamDesk' });
    return;
  }

  if (ch === 'qqbot') {
    // 腾讯已关闭群聊/私聊主动消息，只能推到 QQ 频道里的文字子频道
    await require('./qqbot').sendText(text);
    return;
  }
}

async function flush() {
  if (sending) return;
  sending = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await deliverOne(job.title, job.body);
        store.setSettings({ notifyLastAt: Date.now(), notifyLastError: '' });
      } catch (err) {
        const msg = (err && err.message) || String(err);
        store.setSettings({ notifyLastError: msg });
        logger.warn('通知外发失败', { channel: channel(), message: msg });
      }
      await sleep(GAP_MS);
    }
  } finally {
    sending = false;
  }
}

/**
 * 发一条通知。
 * @param {string} title
 * @param {string} [body]
 * @param {{desktop?: boolean, onClick?: Function, force?: boolean}} [opts]
 */
/** 免打扰时段：任务照跑，只是不弹桌面通知、不推手机；通知中心仍然记录 */
function inQuietHours() {
  const s = settings();
  if (s.quietHoursEnabled !== true) return false;
  const start = Math.min(23, Math.max(0, Number(s.quietStart) || 23));
  const end = Math.min(23, Math.max(0, Number(s.quietEnd) || 8));
  const h = new Date().getHours();
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

function send(title, body, opts = {}) {
  const text = String(body || '');
  // 应用内留一份，系统通知错过时还能在概览页回看
  try {
    notices.add(title, text, opts.kind || 'info');
  } catch { /* 通知中心失败不影响发送 */ }
  const quiet = !opts.force && inQuietHours();
  const desktop = !quiet && opts.desktop !== false && settings().notifyDesktop !== false;
  if (desktop) {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: String(title || 'SteamDesk'),
          body: text,
          icon: iconPath || undefined,
        });
        if (typeof opts.onClick === 'function') {
          n.on('click', () => {
            try {
              opts.onClick();
            } catch {
              /* ignore */
            }
          });
        }
        n.show();
      }
    } catch {
      /* 桌面通知失败不影响外发 */
    }
  }

  if (enabled() && !quiet) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ title: String(title || 'SteamDesk'), body: text });
    flush().catch(() => {});
  }
  return { desktop, channel: channel(), quiet };
}

/** 设置界面「发送测试」：不走队列，直接发并返回真实结果 */
async function test() {
  const ch = channel();
  if (ch === 'none') throw Object.assign(new Error('还没有选择通知渠道'), { code: 'E_NO_CHANNEL' });
  try {
    await deliverOne('测试通知', `这是一条测试消息，渠道：${ch}\n如果你看到了，说明配置可用。`);
    store.setSettings({ notifyLastAt: Date.now(), notifyLastError: '' });
    return { channel: ch, ok: true };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    store.setSettings({ notifyLastError: msg });
    throw Object.assign(new Error(msg), { code: 'E_NOTIFY_FAIL' });
  }
}

function start(opts = {}) {
  iconPath = opts.icon || '';
}

module.exports = { start, send, test, getState, channel, enabled };
