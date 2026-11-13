'use strict';

/**
 * 登录态预警
 *
 * Steam 不提供 Cookie 过期时间，只能定期用当前会话访问一次
 * steamcommunity.com/my/：被重定向到登录页就说明登录态已经失效。
 * 失效时发一次通知，避免「后台任务一直失败但不知道为什么」。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const session = require('./session');
const bridge = require('./steamBridge');
const notify = require('./notify');

const FIRST_DELAY = 5 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;
const NOTIFY_GAP = 6 * 60 * 60 * 1000;

let file = null;
let state = { lastAt: 0, lastResult: null, notifiedAt: 0 };
let timer = null;
let firstTimer = null;
let running = false;
let iconPath = '';

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'session-watch.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state.lastAt = Number(loaded.lastAt) || 0;
      state.lastResult = loaded.lastResult || null;
      state.notifiedAt = Number(loaded.notifiedAt) || 0;
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
    logger.warn('登录态状态写入失败', { message: err && err.message });
  }
}

async function checkOnce(opts = {}) {
  if (running) return { skipped: true, reason: '正在检查' };
  const s = store.getSettings();
  if (!opts.force && s.sessionWarnEnabled === false) {
    return { skipped: true, reason: '登录态预警未开启' };
  }
  const ses = await session.getSession();
  if (!ses || !ses.steamId) {
    const result = { at: Date.now(), state: 'none', message: '没有可用的网页登录会话' };
    state.lastAt = result.at;
    state.lastResult = result;
    save();
    return { skipped: true, reason: '没有可用的网页登录会话' };
  }

  running = true;
  state.lastAt = Date.now();
  try {
    const res = await bridge.request('https://steamcommunity.com/my/', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    const text = await res.text();
    let result;
    if (res.status === 401 || res.status === 403) {
      result = { at: Date.now(), state: 'bad', message: `登录态可能已失效（HTTP ${res.status}）` };
    } else if (bridge.looksLikeLogin({ url: res.url, status: res.status, body: text })) {
      result = { at: Date.now(), state: 'bad', message: '登录态已失效：社区页面跳到了登录页' };
    } else if (res.status >= 400) {
      result = { at: Date.now(), state: 'error', message: `读取社区页面失败（HTTP ${res.status}）` };
    } else {
      result = { at: Date.now(), state: 'ok', message: '登录态正常' };
    }
    state.lastResult = result;
    if (result.state === 'bad' && Date.now() - state.notifiedAt > NOTIFY_GAP) {
      state.notifiedAt = Date.now();
      notify.send('Steam 登录态可能已失效', `${result.message}。请在账号管理里重新登录，否则挂单与自动任务会失败。`, {
        kind: 'warn',
      });
    }
    save();
    if (result.state === 'bad') logger.warn('登录态预警：会话失效');
    return result;
  } catch (err) {
    const result = { at: Date.now(), state: 'error', message: (err && err.message) || '检查失败' };
    state.lastResult = result;
    save();
    logger.warn('登录态检查失败', { message: result.message });
    return result;
  } finally {
    running = false;
  }
}

function tick() {
  const s = store.getSettings();
  if (s.sessionWarnEnabled === false) return;
  if (s.automationPaused === true) return;
  checkOnce().catch(() => {});
}

function start(opts = {}) {
  iconPath = opts.icon || '';
  if (timer) return;
  firstTimer = setTimeout(tick, FIRST_DELAY);
  timer = setInterval(tick, TICK_MS);
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

function getState() {
  return { ...state, enabled: store.getSettings().sessionWarnEnabled !== false, running };
}

module.exports = { init, start, stop, checkOnce, getState };
