'use strict';

/**
 * 卖出通知
 *
 * 轮询当前登录账号的 Steam 市场成交历史（myhistory），发现新的「我卖出」记录就发通知，
 * 内容带上物品名和到手金额，走 notify.js 的统一出口（桌面 + 电话/群/QQ 机器人）。
 *
 * 为什么用成交历史而不是挂单列表：
 *   - 手机、网页、其它工具卖出的都能读到；
 *   - 成交历史里有买家、到手金额、物品名，信息最全。
 *
 * 第一次开启时只把现有记录记下来、不补发旧消息，避免一开就刷屏；
 * 之后每轮只推新增的成交。记录按账号分开存。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');
const history = require('./marketHistory');

const FIRST_DELAY = 90 * 1000;
const MAX_SEEN = 800;

let file = null;
let timer = null;
let firstTimer = null;
let running = false;
let state = { accounts: {}, lastAt: 0, lastResult: '', lastError: '' };

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'sale-watch.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state.accounts = loaded.accounts && typeof loaded.accounts === 'object' ? loaded.accounts : {};
      state.lastAt = Number(loaded.lastAt) || 0;
      state.lastResult = String(loaded.lastResult || '');
      state.lastError = String(loaded.lastError || '');
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
    logger.warn('卖出通知状态写入失败', { message: err && err.message });
  }
}

function options() {
  const s = store.getSettings();
  return {
    enabled: s.saleWatchEnabled === true,
    intervalMin: Math.max(5, Number(s.saleWatchIntervalMin) || 10),
  };
}

function money(cents, sample) {
  const n = Number(cents) || 0;
  const prefix = String(sample || '').match(/^[^\d]*/);
  return `${(prefix && prefix[0]) || ''}${(n / 100).toFixed(2)}`;
}

function notifySales(fresh) {
  const first = fresh[0];
  const lines = fresh.slice(0, 6).map((it) => {
    const price = it.receivedText || it.priceText || '';
    return `· ${it.name}${price ? ` ${price}` : ''}`;
  });
  if (fresh.length > 6) lines.push(`…另有 ${fresh.length - 6} 件`);

  const sameCurrency = fresh.every((it) => it.receivedCurrency === first.receivedCurrency);
  const total = fresh.reduce((a, it) => a + (Number(it.receivedCents) || 0), 0);
  if (sameCurrency && total > 0) {
    lines.push(`合计到手 ${money(total, first.receivedText)}`);
  }

  const title = fresh.length === 1 ? `卖出：${first.name}` : `卖出 ${fresh.length} 件`;
  notify.send(title, lines.join('\n'), { kind: 'good' });
}

async function checkOnce(opts = {}) {
  const opt = options();
  if (!opts.force && !opt.enabled) return { skipped: true, reason: '卖出通知未开启' };
  if (running) return { skipped: true, reason: '正在检查' };
  running = true;
  state.lastAt = Date.now();
  try {
    const res = await history.recentHistory();
    const steamId = res.steamId || 'unknown';
    const sells = (res.items || []).filter((it) => it.kind === 'sell' && !it.failed);
    const acc = state.accounts[steamId] && typeof state.accounts[steamId] === 'object'
      ? state.accounts[steamId]
      : { seen: [] };
    const seen = new Set(Array.isArray(acc.seen) ? acc.seen : []);

    if (acc.inited !== true) {
      acc.inited = true;
      acc.seen = sells.map((it) => it.id).slice(0, MAX_SEEN);
      state.accounts[steamId] = acc;
      state.lastError = '';
      state.lastResult = `已记录 ${sells.length} 条历史卖出，之后的新卖出会通知`;
      save();
      logger.info('卖出通知已就绪', { steamId, count: sells.length });
      return { initialized: true, count: sells.length, steamId };
    }

    const fresh = sells.filter((it) => !seen.has(it.id));
    if (fresh.length) {
      acc.seen = [...new Set([...fresh.map((it) => it.id), ...(acc.seen || [])])].slice(0, MAX_SEEN);
    }
    state.accounts[steamId] = acc;
    state.lastError = '';
    state.lastResult = fresh.length
      ? `新卖出 ${fresh.length} 件`
      : `没有新的卖出（最近记录 ${sells.length} 条）`;
    save();

    if (fresh.length) {
      logger.info('发现新的卖出', {
        steamId,
        count: fresh.length,
        items: fresh.slice(0, 6).map((it) => it.name),
      });
      notifySales(fresh);
    }
    return { newCount: fresh.length, steamId };
  } catch (e) {
    state.lastError = (e && e.message) || '检查失败';
    state.lastResult = '';
    save();
    logger.warn('卖出通知检查失败', { message: state.lastError });
    return { error: state.lastError };
  } finally {
    running = false;
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!options().enabled) return;
    checkOnce().catch(() => {});
  }, options().intervalMin * 60 * 1000);
}

function start() {
  if (firstTimer) clearTimeout(firstTimer);
  firstTimer = setTimeout(() => {
    if (options().enabled) checkOnce().catch(() => {});
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
  return {
    enabled: opt.enabled,
    intervalMin: opt.intervalMin,
    lastAt: state.lastAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    accounts: Object.keys(state.accounts || {}).length,
  };
}

module.exports = { init, start, stop, checkOnce, reschedule, getState };
