'use strict';

/**
 * QQ 机器人（q.qq.com 开放平台）推送 —— 2026 版
 *
 * 支持三种推送目标，按优先级自动选择：
 *   1. 私聊推送（推荐）：用户在 QQ 里给机器人发一条消息即完成绑定，
 *      之后通知直接推到 QQ 消息列表（就像一个好友在给你发消息）。
 *   2. 群聊推送：把机器人拉进任意 QQ 群，在群里 @机器人 发「绑定」。
 *   3. 频道推送（备用）：老方式，机器人加入 QQ 频道后推到文字子频道。
 *
 * 腾讯的硬性约束（为什么不能"只填凭据"就推）：
 *   - QQ 用户在机器人侧是匿名 openid，腾讯不提供任何"查询机器人绑定了谁"的
 *     接口，openid 只能从机器人收到的事件里拿 —— 所以必须由用户先发一条消息。
 *   - 单聊/群聊的消息额度：凭收到的 msg_id 可以在 24 小时内被动回复 5 条；
 *     纯主动消息是否放行因机器人资质而异。因此每次收到用户消息都会刷新
 *     保活记录（lastMsgId），用户平时给机器人发个表情也能续上推送额度。
 *
 * 实时连接：官方 WebSocket gateway（GET /gateway/bot），
 *   intents 用 GROUP_AND_C2C_EVENT (1<<25) 收群聊和单聊消息事件，
 *   心跳 / 断线自动重连，凭据变化时自动重启。
 *
 * AppSecret 存加密区，不回显；access_token 缓存到过期前 1 分钟。
 */

const https = require('https');
const { URL } = require('url');
const store = require('./store');
const logger = require('./logger');

let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {
  /* ws 未安装时 gateway 功能不可用，推送通道不受影响 */
}

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.bot.qq.com';
const GATEWAY_PATH = '/gateway/bot';
const TIMEOUT_MS = 15000;
const INTENT_GROUP_AND_C2C = 1 << 25;

let cache = { appId: '', token: '', expiresAt: 0 };

/* ------------------------- WebSocket 网关状态 ------------------------- */

const gw = {
  ws: null,
  running: false,
  connected: false,
  sessionAt: 0,
  lastEventAt: 0,
  lastSeq: 0,
  sessionId: '',
  hbTimer: null,
  reconnectTimer: null,
  attempts: 0,
  error: '',
};

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

/* ------------------------------ 绑定存储 ------------------------------ */

function readBind(kind) {
  const s = store.getSettings();
  const b = kind === 'group' ? s.qqBindGroup : s.qqBindC2c;
  return b && b.openid ? { ...b } : null;
}

function saveBind(kind, data) {
  const key = kind === 'group' ? 'qqBindGroup' : 'qqBindC2c';
  store.setSettings({ [key]: data });
}

/** 绑定概况（给设置页展示；openid 只露末 6 位） */
function bindState() {
  const mask = (b) =>
    b
      ? {
          type: b.type,
          openidTail: String(b.openid).slice(-6),
          lastMsgAt: Number(b.lastMsgAt) || 0,
          alive: Date.now() - (Number(b.lastMsgAt) || 0) < 24 * 3600 * 1000,
        }
      : null;
  return { c2c: mask(readBind('c2c')), group: mask(readBind('group')) };
}

function unbind(kind) {
  if (kind !== 'group') store.setSettings({ qqBindC2c: null });
  if (kind !== 'c2c') store.setSettings({ qqBindGroup: null });
}

/* ------------------------------ HTTP 基础 ------------------------------ */

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

/* ------------------------- 实时事件网关（WebSocket） ------------------------- */

function gatewayState() {
  return {
    running: gw.running,
    connected: gw.connected,
    sessionAt: gw.sessionAt,
    lastEventAt: gw.lastEventAt,
    error: gw.error,
  };
}

function clearTimers() {
  if (gw.hbTimer) {
    clearInterval(gw.hbTimer);
    gw.hbTimer = null;
  }
  if (gw.reconnectTimer) {
    clearTimeout(gw.reconnectTimer);
    gw.reconnectTimer = null;
  }
}

function scheduleReconnect(reason) {
  if (!gw.running) return;
  gw.connected = false;
  gw.error = reason || '';
  clearTimers();
  gw.attempts += 1;
  const delay = Math.min(60 * 1000, 3000 * gw.attempts);
  gw.reconnectTimer = setTimeout(() => startGateway(true), delay);
  logger.warn('QQ 网关断线，稍后重连', { reason, delayMs: delay });
}

async function startGateway(isRetry) {
  if (!WebSocket) {
    gw.error = '缺少 ws 依赖';
    return { ok: false, message: gw.error };
  }
  const cfg = config();
  if (!cfg.appId || !cfg.secret) {
    gw.running = false;
    gw.connected = false;
    gw.error = '';
    return { ok: false, message: '先填写 AppID / AppSecret' };
  }
  if (gw.ws && (gw.ws.readyState === 0 || gw.ws.readyState === 1)) {
    return { ok: true, message: '已在运行' };
  }
  gw.running = true;
  if (!isRetry) gw.attempts = 0;
  try {
    const r = await api('GET', GATEWAY_PATH);
    const wssUrl = r && r.url;
    if (!wssUrl) throw err('E_QQ_GATEWAY', '没有拿到网关地址');
    connectGateway(wssUrl);
    gw.error = '';
    return { ok: true };
  } catch (e) {
    gw.running = false;
    gw.connected = false;
    gw.error = (e && e.message) || '连接失败';
    logger.warn('QQ 网关连接失败', { message: gw.error });
    return { ok: false, message: gw.error };
  }
}

function stopGateway() {
  gw.running = false;
  gw.connected = false;
  clearTimers();
  if (gw.ws) {
    try {
      gw.ws.removeAllListeners();
      gw.ws.close();
    } catch {
      /* ignore */
    }
    gw.ws = null;
  }
}

function restartGateway() {
  stopGateway();
  return startGateway(true);
}

function connectGateway(wssUrl) {
  const ws = new WebSocket(wssUrl);
  gw.ws = ws;
  let hbInterval = 30000;

  ws.on('open', () => {
    gw.attempts = 0;
    logger.info('QQ 网关已连接，等待鉴权');
  });

  ws.on('message', async (buf) => {
    let msg = null;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    const { op, d, s, t } = msg;
    if (typeof s === 'number') gw.lastSeq = s;

    if (op === 10) {
      // Hello：拿到心跳间隔，立刻鉴权
      hbInterval = Math.max(5000, (d && d.heartbeat_interval) || 30000);
      const token = await getToken(false).catch((e) => {
        scheduleReconnect((e && e.message) || 'token 失败');
        return null;
      });
      if (!token) return;
      ws.send(
        JSON.stringify({
          op: 2,
          d: { token: `QQBot ${token}`, intents: INTENT_GROUP_AND_C2C, shard: [0, 1] },
        })
      );
      clearInterval(gw.hbTimer);
      gw.hbTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: gw.lastSeq }));
      }, hbInterval);
      return;
    }

    if (op === 0) {
      // 事件分发
      if (t === 'READY') {
        gw.sessionId = (d && d.session_id) || '';
        gw.sessionAt = Date.now();
        gw.connected = true;
        gw.lastEventAt = Date.now();
        gw.error = '';
        logger.info('QQ 网关鉴权成功，正在监听私聊/群聊消息');
        return;
      }
      gw.lastEventAt = Date.now();
      try {
        handleEvent(t, d || {});
      } catch (e) {
        logger.warn('QQ 事件处理失败', { t, message: e && e.message });
      }
      return;
    }

    if (op === 7) {
      // 服务端要求重连
      scheduleReconnect('服务端要求重连');
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (op === 9) {
      // 会话失效：重新鉴权
      scheduleReconnect('会话失效');
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  });

  ws.on('error', (e) => {
    scheduleReconnect((e && e.message) || '连接错误');
  });

  ws.on('close', () => {
    if (gw.running && gw.ws === ws) scheduleReconnect('连接断开');
  });
}

/* ------------------------------- 事件与绑定 ------------------------------- */

const BIND_KEYWORD = '绑定';

const HELP_TEXT = [
  '可用指令：',
  '· 查仓库 — 我的饰品仓库概况',
  '· 查估值 — 库存最近一次估值与挂单情况',
  '· 查挂单 — 我当前在卖的东西',
  '· 查游戏 游戏名 — 在我的游戏库里搜索',
  '· 查价 游戏名或AppID — Steam 商店价格与各区对比可到软件里看',
  '· 挂卡进度 — 还能掉卡牌的游戏与剩余张数',
  '· 绑定 — 重新确认推送绑定',
].join('\n');

/** QQ 里发起的查询指令（查仓库 / 查游戏 / 查价） */
async function runCommand(text, reply) {
  const cmd = String(text || '')
    .trim()
    .replace(/^@\S+\s*/, '')
    .trim();

  if (/^(帮助|help|指令|命令)$/i.test(cmd)) {
    await reply(HELP_TEXT);
    return true;
  }

  if (/^(查仓库|查询仓库|查库存|库存)$/.test(cmd)) {
    await reply('正在读取你的饰品仓库，稍等…');
    try {
      const sess = await require('./session').getSession();
      const sid = sess && sess.steamId;
      if (!sid) {
        await reply('还没有可用的网页登录会话，先在软件里「网页登录获取Cookie」。');
        return true;
      }
      const inv = await require('./inventory').fetchInventory(sid, 753, null, { noNote: true });
      const total = Number(inv.totalAssets) || 0;
      const sellable = Number(inv.sellableAssets) || 0;
      const kinds = Number(inv.groupCount) || 0;
      const top = (inv.groups || [])
        .slice()
        .sort((a, b) => Number(b.totalQty || b.count || 0) - Number(a.totalQty || a.count || 0))
        .slice(0, 3)
        .map((g) => `${g.name || g.marketHashName || '?'} ×${g.totalQty || g.count || '?'}`)
        .join('、');
      await reply(
        `【SteamDesk 仓库】\n共 ${total} 件（${kinds} 种），其中可上架 ${sellable} 件` +
          (top ? `\n数量最多：${top}` : '')
      );
    } catch (e) {
      await reply(`查仓库失败：${(e && e.message) || '未知错误'}`);
    }
    return true;
  }

  let m = cmd.match(/^查游戏\s*(.+)$/);
  if (m) {
    const kw = m[1].trim().toLowerCase();
    if (!kw) {
      await reply('用法：查游戏 游戏名（例如：查游戏 黑神话）');
      return true;
    }
    try {
      const r = await require('./steamLibrary').scanLibrary();
      const list = Array.isArray(r && r.games) ? r.games : Array.isArray(r && r.apps) ? r.apps : [];
      const hit = list.filter(
        (g) => String(g.name || '').toLowerCase().includes(kw) || String(g.appId) === kw
      );
      if (!hit.length) {
        await reply(`游戏库里没找到「${m[1].trim()}」。`);
        return true;
      }
      const lines = hit.slice(0, 5).map((g) => {
        const mins = Number(g.playtime) || 0;
        const hrs = mins >= 60 ? `${Math.round(mins / 60)}h` : mins > 0 ? '<1h' : '';
        return `· ${g.name || 'App ' + g.appId}（AppID ${g.appId}${g.installed ? ' · 已安装' : ''}${
          hrs ? ' · ' + hrs : ''
        }）`;
      });
      await reply(`【游戏库】找到 ${hit.length} 个：\n${lines.join('\n')}${hit.length > 5 ? '\n…' : ''}`);
    } catch (e) {
      await reply(`查游戏失败：${(e && e.message) || '未知错误'}`);
    }
    return true;
  }

  m = cmd.match(/^查价\s*(.+)$/);
  if (m) {
    const kw = m[1].trim();
    if (!kw) {
      await reply('用法：查价 游戏名或AppID（例如：查价 2358720）');
      return true;
    }
    try {
      const d = await require('./storeSearch').queryStorePrice(kw, {
        region: store.getSettings().storeRegion,
      });
      const price = d.isFree
        ? '免费'
        : `${d.finalPriceFormatted}${d.discountPercent ? `（-${d.discountPercent}%）` : ''}`;
      await reply(
        `【Steam 商店】${d.name}\n现价：${price}${d.initialPriceFormatted && d.initialPriceFormatted !== d.finalPriceFormatted ? `（原价 ${d.initialPriceFormatted}）` : ''}\n发售：${d.releaseDate}`
      );
    } catch (e) {
      await reply(`查价失败：${(e && e.message) || '未知错误'}`);
    }
    return true;
  }

  /* 查挂单：当前账号在售的挂单概况 */
  if (/^(查挂单|挂单|查在售|查卖出挂单)$/.test(cmd)) {
    await reply('正在同步你的市场挂单，稍等…');
    try {
      const sess = await require('./session').getSession();
      const sid = sess && sess.steamId;
      if (!sid) {
        await reply('还没有可用的网页登录会话，先在软件里「网页登录获取Cookie」。');
        return true;
      }
      const r = await require('./seller').fetchMyListings(sid, null);
      const entries = Object.entries((r && r.map) || {}).filter(([k, v]) => !k.startsWith('_') && v && v.listingId);
      if (!entries.length) {
        await reply('当前没有在售挂单。');
        return true;
      }
      // 按游戏聚合 + 最老挂单
      const nowSec = Math.floor(Date.now() / 1000);
      const byApp = new Map();
      let oldest = 0;
      for (const [, it] of entries) {
        const k = String(it.appId || '753');
        byApp.set(k, (byApp.get(k) || 0) + 1);
        const age = nowSec - (Number(it.createdAt) || nowSec);
        if (age > oldest) oldest = age;
      }
      const nameMap = require('./appRegistry');
      const top = [...byApp.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, n]) => `${nameMap.nameOf(Number(k)) || (k === '753' ? 'Steam社区物品' : `App ${k}`)} ${n} 件`)
        .join('、');
      await reply(
        `【市场挂单】共 ${entries.length} 件在售\n` +
          `分布：${top}${byApp.size > 3 ? ` 等 ${byApp.size} 个游戏` : ''}` +
          (oldest > 86400 ? `\n最久已挂 ${Math.floor(oldest / 86400)} 天（可考虑降价）` : '')
      );
    } catch (e) {
      await reply(`查挂单失败：${(e && e.message) || '未知错误'}`);
    }
    return true;
  }

  /* 查估值：最近一次库存估值 + 挂单数（用软件里算过的缓存值，秒回） */
  if (/^(查估值|查库存估值|估值)$/.test(cmd)) {
    const s = store.getSettings();
    const v = Number(s.lastInvValueYuan) || 0;
    const at = Number(s.lastInvValueAt) || 0;
    if (!v) {
      await reply('还没有估值记录：在软件「饰品仓库」里拉一次库存并查价后，这里就能查了。');
      return true;
    }
    const age = at ? Math.round((Date.now() - at) / 60000) : 0;
    const ageText = age < 60 ? `${age} 分钟前` : age < 1440 ? `${Math.floor(age / 60)} 小时前` : `${Math.floor(age / 1440)} 天前`;
    await reply(`【库存估值】≈ ¥${v.toFixed(2)}（${ageText}计算）\n如需最新估值，在软件里刷新一次行情。`);
    return true;
  }

  /* 挂卡进度 */
  if (/^(挂卡|查挂卡|挂卡进度|卡片进度)$/.test(cmd)) {
    await reply('正在读取徽章页挂卡进度，稍等…');
    try {
      const r = await require('./cardsIdle').progress();
      if (!r || !r.loggedIn) {
        await reply('还没有 Steam 网页登录会话，先在软件里「网页登录获取Cookie」。');
        return true;
      }
      const games = (r.games || []).slice(0, 8);
      if (!games.length) {
        await reply('当前没有可掉落的卡牌（都掉完啦）。');
        return true;
      }
      const lines = games.map((g) => `· ${g.name}：剩 ${g.drops} 张${g.halfSpeed ? '（已过 2 小时，掉率减半）' : ''}`);
      await reply(
        `【挂卡进度】${r.games.length} 个游戏共 ${r.totalDrops} 张卡可掉\n` +
          lines.join('\n') +
          (r.games.length > 8 ? `\n…另 ${r.games.length - 8} 个游戏` : '')
      );
    } catch (e) {
      await reply(`查挂卡失败：${(e && e.message) || '未知错误'}`);
    }
    return true;
  }

  return false;
}

async function handleEvent(t, d) {
  if (t === 'C2C_MESSAGE_CREATE') {
    const openid = String((d.author && d.author.user_openid) || d.user_openid || '');
    const msgId = String(d.id || d.msg_id || '');
    const content = String(d.content || '').trim();
    if (!openid) return;
    const prev = readBind('c2c');
    const isNew = !prev || prev.openid !== openid;
    saveBind('c2c', { type: 'c2c', openid, lastMsgId: msgId, lastMsgAt: Date.now() });
    // 查询指令优先处理（查…/挂卡/挂单/估值等）
    if (/^(帮助|help|指令|命令|查|挂|估)/i.test(content)) {
      const handled = await runCommand(content, (text) => replyC2c(openid, msgId, text));
      if (handled) return;
    }
    if (content.includes(BIND_KEYWORD) || (isNew && !prev)) {
      replyC2c(openid, msgId, '绑定成功！之后 SteamDesk 的通知会直接发到这个私聊。\n\n' + HELP_TEXT)
        .catch((e) => logger.warn('QQ 绑定回复失败', { message: e && e.message }));
      logger.info('QQ 私聊绑定成功', { openidTail: openid.slice(-6) });
    }
    return;
  }

  if (t === 'GROUP_AT_MESSAGE_CREATE') {
    const groupOpenid = String(d.group_openid || '');
    const msgId = String(d.id || d.msg_id || '');
    const content = String(d.content || '').trim();
    if (!groupOpenid) return;
    const prev = readBind('group');
    const isNew = !prev || prev.openid !== groupOpenid;
    saveBind('group', { type: 'group', openid: groupOpenid, lastMsgId: msgId, lastMsgAt: Date.now() });
    if (/^(帮助|help|指令|命令|查|挂|估)/i.test(content)) {
      const handled = await runCommand(content, (text) => replyGroup(groupOpenid, msgId, text));
      if (handled) return;
    }
    if (content.includes(BIND_KEYWORD)) {
      replyGroup(groupOpenid, msgId, '绑定成功！之后 SteamDesk 的通知会发到这个群。\n\n' + HELP_TEXT)
        .catch((e) => logger.warn('QQ 群绑定回复失败', { message: e && e.message }));
      logger.info('QQ 群聊绑定成功', { openidTail: groupOpenid.slice(-6) });
    } else if (isNew && !prev) {
      logger.info('QQ 群聊首次收到消息，已记录（发「绑定」完成确认）', { openidTail: groupOpenid.slice(-6) });
    }
  }
}

/* ------------------------------- 发送消息 ------------------------------- */

/**
 * 私聊 / 群聊推送。
 * 优先带最近一次用户消息的 msg_id（24h 内被动回复，稳妥）；
 * 超过 24h 则尝试纯主动消息（是否放行取决于机器人资质）。
 */
async function sendToUser(kind, openid, content) {
  const text = String(content || '').trim();
  if (!text) throw err('E_QQ_EMPTY', '消息内容为空');
  const bind = readBind(kind);
  if (!bind || bind.openid !== openid) {
    // 用户可能刚绑过但内存里读的是旧 settings，重新读一次
  }
  const fresh = bind && Date.now() - (Number(bind.lastMsgAt) || 0) < 24 * 3600 * 1000;
  const body = { content: text.slice(0, 1800), msg_type: 0, msg_seq: 1 };
  if (fresh && bind.lastMsgId) {
    body.msg_id = bind.lastMsgId;
    body.msg_seq = Math.min(5, (Number(bind.sendSeq) || 0) + 1);
  }
  const path =
    kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(openid)}/messages`
      : `/v2/groups/${encodeURIComponent(openid)}/messages`;
  try {
    await api('POST', path, body);
  } catch (e) {
    // 主动额度用完 / msg_id 过期：提示用户发条消息刷新绑定
    if (fresh) {
      // 被动回复失败（可能 5 条额度用完），去掉 msg_id 试一次主动消息
      delete body.msg_id;
      body.msg_seq = 1;
      try {
        await api('POST', path, body);
      } catch (e2) {
        throw err(
          'E_QQ_LIMIT',
          `推送被腾讯限制（${(e2 && e2.message) || '未知'}）。在 QQ 里给机器人随便发条消息，几秒后点重试即可继续推送。`
        );
      }
    } else {
      throw err(
        'E_QQ_LIMIT',
        `推送失败（${(e && e.message) || '未知'}）。可能需要你在 QQ 里给机器人发一条消息来激活/刷新推送额度。`
      );
    }
  }
  if (fresh && bind) {
    saveBind(kind, { ...bind, sendSeq: Math.min(5, (Number(bind.sendSeq) || 0) + 1) });
  }
  return { ok: true, kind, via: fresh ? 'passive' : 'active' };
}

function replyC2c(openid, msgId, content) {
  return api('POST', `/v2/users/${encodeURIComponent(openid)}/messages`, {
    content: String(content).slice(0, 1800),
    msg_type: 0,
    msg_id: msgId,
    msg_seq: 1,
  });
}

function replyGroup(openid, msgId, content) {
  return api('POST', `/v2/groups/${encodeURIComponent(openid)}/messages`, {
    content: String(content).slice(0, 1800),
    msg_type: 0,
    msg_id: msgId,
    msg_seq: 1,
  });
}

/* ------------------------- 频道模式（保留为备用） ------------------------- */

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

/**
 * notify.js 的统一入口。按优先级分发：
 *   私聊绑定 → 群聊绑定 → 频道子频道。
 */
async function sendText(content) {
  const c2c = readBind('c2c');
  if (c2c && c2c.openid) {
    return sendToUser('c2c', c2c.openid, content);
  }
  const group = readBind('group');
  if (group && group.openid) {
    return sendToUser('group', group.openid, content);
  }
  const cfg = config();
  if (cfg.channelId) {
    return sendToChannel(cfg.channelId, content);
  }
  throw err(
    'E_QQ_CONFIG',
    '还没有绑定推送目标：在 QQ 里给机器人发一条消息（私聊绑定），或把机器人拉进群里 @它 发「绑定」，也可以用频道模式选择子频道。'
  );
}

async function test() {
  const c2c = readBind('c2c');
  const group = readBind('group');
  const cfg = config();
  const target = c2c
    ? `私聊（openid 尾号 ${c2c.openid.slice(-6)}）`
    : group
      ? `群聊（openid 尾号 ${group.openid.slice(-6)}）`
      : cfg.channelName || cfg.channelId || '未绑定';
  await sendText(`【SteamDesk】测试通知\nQQ 机器人已连通，推送目标：${target}\n收到这条说明配置可用。`);
  return { ok: true, target };
}

module.exports = {
  config,
  getToken,
  listTargets,
  sendToChannel,
  sendText,
  test,
  startGateway,
  stopGateway,
  restartGateway,
  gatewayState,
  bindState,
  unbind,
};
