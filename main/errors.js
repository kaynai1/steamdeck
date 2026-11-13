'use strict';

/**
 * 错误聚合
 *
 * 后台任务（补货、守价、巡检）跑起来之后，异常只写日志等于没人看见。
 * 这里把同类错误归一化后计数：某个错误第一次出现时发一次通知，
 * 之后只累计次数，直到 6 小时后才允许再次提醒。
 *
 * 明确忽略"预期内"的错误码（忙、风控拦截、限流、网络超时），
 * 否则每天都会被自己的限流提示吵醒。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const notify = require('./notify');

const KEEP = 200;
const RENOTIFY_MS = 6 * 60 * 60 * 1000;
const WRITE_GAP_MS = 5000;

const IGNORE = new Set([
  'E_BUSY',
  'E_CANCELED',
  'E_RISK_BATCH',
  'E_RISK_DAILY',
  'E_NO_SESSION',
  'E_TIMEOUT',
  'E_RATE_LIMIT',
  'E_NOTIFY_FAIL',
  'E_NO_CHANNEL',
  'E_NO_ENCRYPT',
]);

let file = null;
let buckets = {};
let lastWrite = 0;
let writeTimer = null;

function norm(msg) {
  return String(msg || '')
    .replace(/[0-9a-f]{16,}/gi, '#') // assetId / listingId
    .replace(/\b\d{5,}\b/g, '#') // 长数字
    .replace(/\b\d+(\.\d+)?\b/g, '#') // 普通数字（价格、行号）
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'errors.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') buckets = loaded;
  } catch {
    /* 第一次运行 */
  }
}

function trim() {
  const all = Object.entries(buckets);
  if (all.length <= KEEP) return;
  all.sort((a, b) => (b[1].last || 0) - (a[1].last || 0));
  buckets = Object.fromEntries(all.slice(0, KEEP));
}

function save() {
  if (!file) return;
  const doWrite = () => {
    lastWrite = Date.now();
    writeTimer = null;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buckets), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      logger.warn('错误聚合写入失败', { message: err && err.message });
    }
  };
  if (writeTimer) return;
  const wait = Math.max(0, WRITE_GAP_MS - (Date.now() - lastWrite));
  writeTimer = setTimeout(doWrite, wait);
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/**
 * 记一条错误。
 * @param {string} code
 * @param {string} message
 * @param {string} [where] 发生位置，方便区分同一错误码
 */
function record(code, message, where = '') {
  try {
    const c = String(code || 'E_UNKNOWN');
    if (IGNORE.has(c)) return;
    const key = `${c}:${norm(message)}`;
    const now = Date.now();
    const b = buckets[key] || { code: c, sample: String(message || '').slice(0, 300), where, count: 0, first: now, last: now, notifiedAt: 0 };
    b.count += 1;
    b.last = now;
    if (where) b.where = where;
    buckets[key] = b;

    const isNew = b.count === 1;
    const canNotify = !b.notifiedAt || now - b.notifiedAt > RENOTIFY_MS;
    if ((isNew || canNotify) && b.count >= 1) {
      b.notifiedAt = now;
      notify.send(
        isNew ? '发现新的错误' : '错误仍在重复出现',
        `位置：${where || '未标注'}\n错误码：${c}\n${b.sample.slice(0, 240)}` +
          (b.count > 1 ? `\n累计 ${b.count} 次` : ''),
        { desktop: false }
      );
    }
    trim();
    save();
  } catch {
    /* 聚合失败不能影响业务 */
  }
}

function recent(limit = 30) {
  return Object.values(buckets)
    .sort((a, b) => (b.last || 0) - (a.last || 0))
    .slice(0, limit)
    .map((b) => ({
      code: b.code,
      sample: b.sample,
      where: b.where || '',
      count: b.count,
      first: b.first,
      last: b.last,
    }));
}

function clear() {
  buckets = {};
  save();
  return { cleared: true };
}

module.exports = { init, record, recent, clear };
