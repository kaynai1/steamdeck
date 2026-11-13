'use strict';

/**
 * 网页采集入口（配合浏览器扩展）
 *
 * 只监听 127.0.0.1，不对外网开放；所有写入都要求令牌，令牌只存在本机。
 * 扩展在 Steam 市场物品页点「记到 SteamDesk」时，把当前最低价发过来，
 * 软件在物品详情里显示这个采集价，方便和 Steam / BUFF 对照。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const logger = require('./logger');

const PORT = 37421;
const MAX_ITEMS = 800;
const MAX_BODY = 32 * 1024;

let server = null;
let file = null;
let state = { token: '', items: {} };
let lastAt = 0;
let lastError = '';

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'webprices.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state.token = String(loaded.token || '');
      state.items = loaded.items && typeof loaded.items === 'object' ? loaded.items : {};
    }
  } catch {
    /* 第一次运行 */
  }
  if (!state.token) {
    state.token = crypto.randomBytes(16).toString('hex');
    save();
  }
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('采集价格写入失败', { message: err && err.message });
  }
}

function enabled() {
  return store.getSettings().extEnabled === true;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function send(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function tokenOk(got) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(state.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function accept(payload) {
  if (!enabled()) {
    return { code: 403, body: { ok: false, error: '网页采集未在设置里开启' } };
  }
  if (!tokenOk(payload.token)) {
    return { code: 401, body: { ok: false, error: '令牌不正确，请在扩展里填入软件设置中的令牌' } };
  }
  const hash = String(payload.marketHashName || '').trim();
  const price = Number(payload.price);
  if (!hash || !(price > 0)) {
    return { code: 400, body: { ok: false, error: '缺少物品名或价格' } };
  }
  const appId = Number(payload.appId) || 753;
  state.items[hash] = {
    price: Math.round(price * 100) / 100,
    appId,
    at: Date.now(),
    source: String(payload.source || 'steam').slice(0, 24),
  };
  // 控制文件大小：只保留最近 800 件
  const rows = Object.entries(state.items).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  if (rows.length > MAX_ITEMS) state.items = Object.fromEntries(rows.slice(0, MAX_ITEMS));
  lastAt = Date.now();
  lastError = '';
  save();
  return { code: 200, body: { ok: true } };
}

function handle(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  const url = String(req.url || '/');
  if (req.method === 'GET' && url.startsWith('/ping')) {
    send(res, 200, { ok: true, app: 'SteamDesk', enabled: enabled() });
    return;
  }
  if (req.method === 'POST' && url.startsWith('/price')) {
    let size = 0;
    let body = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        send(res, 400, { ok: false, error: '不是合法 JSON' });
        return;
      }
      const out = accept(payload);
      if (out.code >= 400) lastError = out.body.error;
      send(res, out.code, out.body);
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
}

function start() {
  if (server) return;
  server = http.createServer(handle);
  server.on('error', (err) => {
    lastError = err && err.message ? err.message : String(err);
    logger.warn('网页采集端口启动失败', { message: lastError, port: PORT });
  });
  server.listen(PORT, '127.0.0.1', () => {
    logger.info('网页采集入口已就绪', { port: PORT });
  });
}

function stop() {
  if (server) server.close();
  server = null;
}

function getState() {
  return {
    enabled: enabled(),
    port: PORT,
    token: state.token,
    count: Object.keys(state.items).length,
    lastAt,
    lastError,
  };
}

function getPrices() {
  return { items: state.items };
}

function clearPrices() {
  state.items = {};
  save();
  return getState();
}

module.exports = { init, start, stop, getState, getPrices, clearPrices, PORT };
