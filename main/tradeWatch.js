'use strict';

/**
 * 交易报价提醒
 *
 * 使用 Steam 官方 Web API（需要用户自己在 steamcommunity.com/dev/apikey 申请 Key），
 * 轮询「收到的、仍待处理」的交易报价数量；数量增加时发一次通知。
 * 不做自动接受，避免被钓鱼报价占便宜。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');

const FIRST_DELAY = 3 * 60 * 1000;
const NOTIFY_GAP = 3 * 60 * 60 * 1000;

let file = null;
let state = { lastAt: 0, lastCount: 0, notifiedAt: 0, lastError: '' };
let timer = null;
let firstTimer = null;
let running = false;

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'trade-watch.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state.lastAt = Number(loaded.lastAt) || 0;
      state.lastCount = Number(loaded.lastCount) || 0;
      state.notifiedAt = Number(loaded.notifiedAt) || 0;
      state.lastError = loaded.lastError || '';
    }
  } catch {
    /* 第一次运行没有文件 */
  }
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('交易报价状态写入失败', { message: err && err.message });
  }
}

function options() {
  const s = store.getSettings();
  return {
    enabled: s.tradeWatchEnabled === true,
    apiKey: String(s.steamApiKey || '').trim(),
    intervalMin: Math.max(3, Number(s.tradeWatchIntervalMin) || 10),
  };
}

function withTimeout(promise, ms, label) {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(Object.assign(new Error(`${label}超时（网络或代理问题）`), { code: 'E_TIMEOUT' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function checkOnce(opts = {}) {
  const opt = options();
  if (!opts.force && !opt.enabled) return { skipped: true, reason: '交易报价提醒未开启' };
  if (!opt.apiKey) {
    return { skipped: true, reason: '还没有填写 Steam Web API Key' };
  }
  if (running) return { skipped: true, reason: '正在检查' };
  running = true;
  state.lastAt = Date.now();
  try {
    const url =
      'https://api.steampowered.com/IEconService/GetTradeOffers/v1/' +
      `?key=${encodeURIComponent(opt.apiKey)}` +
      '&get_received_offers=1&active_only=1&get_descriptions=0&language=schinese';
    const res = await withTimeout(fetch(url, { method: 'GET' }), 30000, '读取交易报价');
    if (!res.ok) {
      throw Object.assign(new Error(`Steam Web API 返回 HTTP ${res.status}（Key 是否正确？）`), {
        code: 'E_TRADE_HTTP',
      });
    }
    const json = await res.json();
    const list = (json && json.response && json.response.trade_offers_received) || [];
    const count = Array.isArray(list) ? list.length : 0;
    const prev = Number(state.lastCount) || 0;
    state.lastCount = count;
    state.lastError = '';
    state.lastResult = { at: Date.now(), count, increased: count > prev };
    save();
    if (count > 0 && (count > prev || Date.now() - state.notifiedAt > NOTIFY_GAP)) {
      state.notifiedAt = Date.now();
      save();
      notify.send(
        `有 ${count} 个待处理交易报价`,
        '打开 Steam 或网页版交易报价查看；本软件不会自动接受报价。',
        { kind: 'warn' }
      );
    }
    logger.info('交易报价检查', { count });
    return state.lastResult;
  } catch (err) {
    state.lastError = (err && err.message) || '检查失败';
    save();
    logger.warn('交易报价检查失败', { message: state.lastError });
    return { error: state.lastError };
  } finally {
    running = false;
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const opt = options();
    if (!opt.enabled) return;
    if (store.getSettings().automationPaused === true) return;
    checkOnce().catch(() => {});
  }, options().intervalMin * 60 * 1000);
}

function start() {
  if (firstTimer) clearTimeout(firstTimer);
  firstTimer = setTimeout(() => {
    const opt = options();
    if (opt.enabled) checkOnce().catch(() => {});
  }, FIRST_DELAY);
  reschedule();
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

function getState() {
  const opt = options();
  return { ...state, enabled: opt.enabled, hasKey: !!opt.apiKey, intervalMin: opt.intervalMin };
}

module.exports = { init, start, stop, checkOnce, getState, reschedule };
