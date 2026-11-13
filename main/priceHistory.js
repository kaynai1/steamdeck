'use strict';

/**
 * 挂机游戏最低价历史（7 天走势）
 *
 * 每次读到挂机行情时顺手把「当天最低在售价」记一笔，按天覆盖、只留 30 天。
 * 卡片上用一条小曲线和涨跌幅显示大概是在涨还是跌。
 *
 * 数据量很小（8 个游戏 × 30 天），直接存 JSON，不进设置文件。
 * 只记录真实价格（¥0.00 的异常挂单不算），没有在售的日子跳过。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const SHOW_DAYS = 7;
const RECORD_EVERY = 6 * 60 * 60 * 1000;
const FIRST_DELAY = 3 * 60 * 1000;

let file = null;
let timer = null;
let firstTimer = null;
let data = {}; // appId -> [{ d: 'YYYY-MM-DD', c: 分 }]
let recording = false;

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'price-history.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) data = loaded;
  } catch {
    /* 第一次运行没有文件 */
  }
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    logger.warn('价格历史写入失败', { message: e && e.message });
  }
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 把一批行情结果写进历史；同一天重复读只保留最后一次 */
function record(stats) {
  if (!Array.isArray(stats) || !stats.length) return;
  const today = dayKey();
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  let changed = false;
  for (const g of stats) {
    const appId = Number(g && g.appId);
    const cents = Number(g && g.lowestCents) || 0;
    if (!appId || cents <= 0) continue;
    const list = Array.isArray(data[appId]) ? data[appId].slice() : [];
    const last = list[list.length - 1];
    if (last && last.d === today) {
      if (last.c !== cents) {
        last.c = cents;
        changed = true;
      }
    } else {
      list.push({ d: today, c: cents, t: Date.now() });
      changed = true;
    }
    // 按日期裁掉过老的记录
    data[appId] = list.filter((p) => {
      const ts = p.t || Date.parse(`${p.d}T12:00:00`);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }
  if (changed) save();
}

/** 后台每天补一笔（用户没打开页面时也能把曲线续上） */
async function recordNow() {
  if (recording) return;
  recording = true;
  try {
    const stats = await require('./idleMarket').all({ force: false });
    record(stats);
  } catch (e) {
    logger.warn('价格历史记录失败', { message: e && e.message });
  } finally {
    recording = false;
  }
}

/** 返回最近 7 天：{ appId: [{d,c}] } */
function series() {
  const out = {};
  for (const [appId, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    const points = list
      .filter((p) => p && p.d && Number(p.c) > 0)
      .slice(-SHOW_DAYS)
      .map((p) => ({ d: p.d, c: Number(p.c) }));
    if (points.length) out[appId] = points;
  }
  return out;
}

function start() {
  stop();
  firstTimer = setTimeout(() => recordNow().catch(() => {}), FIRST_DELAY);
  timer = setInterval(() => recordNow().catch(() => {}), RECORD_EVERY);
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

module.exports = { init, start, stop, record, series, dayKey };
