'use strict';

/**
 * 风险熔断
 *
 * 批量操作最怕两件事：少打一个零、或者一次点了太多件。这里集中做三件事：
 *   1) 单件价格上限（防止把 3.00 打成 300.00）；
 *   2) 挂单价低于成本 / 低于市场最低价的比例下限（默认 50%）；
 *   3) 单次批量件数与每日改价次数的上限。
 *
 * 只做拦截，不替用户改价。被拦下的物品会在上架计划里标记原因，
 * 不会被静默跳过。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const store = require('./store');
const costs = require('./costs');

let file = null;
let state = null; // { day: '2026-11-10', repriced: 0 }

function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'risk-count.json');
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = null;
  }
  if (!state || typeof state !== 'object') state = { day: dayKey(), repriced: 0 };
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('风控计数写入失败', { message: err && err.message });
  }
}

function limits() {
  const s = store.getSettings();
  return {
    enabled: s.guardEnabled !== false,
    maxPriceYuan: Math.max(0, Number(s.maxPriceYuan) || 0),
    minCostRatio: Math.min(1, Math.max(0, Number(s.minCostRatio) || 0.5)),
    maxDailyReprice: Math.max(0, Number(s.maxDailyReprice) || 0),
    maxBatch: Math.max(1, Number(s.maxBatch) || 50),
  };
}

function repricedToday() {
  if (!state) return 0;
  if (state.day !== dayKey()) {
    state.day = dayKey();
    state.repriced = 0;
    save();
  }
  return Number(state.repriced) || 0;
}

/** 把设置里的名单统一成小写片段数组 */
function keywords(value) {
  return (Array.isArray(value) ? value : [])
    .map((x) => String(x == null ? '' : x).trim().toLowerCase())
    .filter(Boolean);
}

function matchName(name, list) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return list.some((k) => n.includes(k));
}

/**
 * 检查单件挂单价格。
 * @returns {string|null} 被拦截时返回原因，否则 null
 */
function checkItem(payload) {
  const L = limits();
  if (!L.enabled) return null;
  const price = Number(payload && payload.priceYuan) || 0;
  if (!(price > 0)) return null;

  if (L.maxPriceYuan > 0 && price > L.maxPriceYuan) {
    return `价格 ${price.toFixed(2)} 元超过单件上限 ${L.maxPriceYuan} 元（风控拦截）`;
  }
  const hash = payload && payload.marketHashName;
  const sid = payload && payload.steamId;
  const s = store.getSettings();
  const source = String((payload && payload.source) || '');
  // 黑名单只拦后台自动化（阶梯/守价/补货），手动操作仍然由用户自己决定
  const autoSource = source === 'ladder' || source === 'guard' || source === 'restock';
  if (autoSource && hash && matchName(hash, keywords(s.riskBlacklist))) {
    return '在风控黑名单里，自动改价已跳过';
  }
  if (hash && sid) {
    const rec = costs.get(sid, hash);
    const unit = rec ? Number(rec.cost) || 0 : 0;
    const white = matchName(hash, keywords(s.riskWhitelist));
    if (!white && unit > 0 && L.minCostRatio > 0 && price < unit * L.minCostRatio) {
      return `价格 ${price.toFixed(2)} 元低于成本 ${unit.toFixed(2)} 元的 ${Math.round(
        L.minCostRatio * 100
      )}%（风控拦截）`;
    }
  }
  return null;
}

/** 记录一次改价（按成功件数累加），返回当天累计 */
function addReprice(n) {
  if (!state) state = { day: dayKey(), repriced: 0 };
  if (state.day !== dayKey()) {
    state.day = dayKey();
    state.repriced = 0;
  }
  state.repriced = Math.max(0, (Number(state.repriced) || 0) + (Number(n) || 0));
  save();
  return state.repriced;
}

function status() {
  return {
    ...limits(),
    repricedToday: repricedToday(),
    day: dayKey(),
  };
}

module.exports = { init, limits, checkItem, addReprice, status };
