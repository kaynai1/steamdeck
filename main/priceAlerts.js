'use strict';

/**
 * 价格提醒
 *
 * 用户在物品详情里给某件饰品设一个价：跌到 / 涨到就弹托盘通知。
 * 后台每 15 分钟用公开的 priceoverview 查一次（quoteOne 内部已带多 appid 回退）。
 *
 * 不重复轰炸的规则：
 *   · 价格第一次越过阈值时通知；
 *   · 已经越过就保持沉默，除非距上次通知超过 6 小时（提醒你还在低位/高位）；
 *   · 价格回到阈值内侧后再越过，会重新通知一次。
 */

const { Notification } = require('electron');
const store = require('./store');
const market = require('./market');
const logger = require('./logger');

const CHECK_MS = 15 * 60 * 1000;
const FIRST_DELAY = 60 * 1000;
const RENOTIFY_MS = 6 * 60 * 60 * 1000;
const MAX_ALERTS = 60;

let timer = null;
let running = false;
let onOpen = null;
let iconPath = '';

function list() {
  return (store.getSettings().priceAlerts || []).filter((a) => a && a.id);
}

function persist(alerts) {
  store.setSettings({ priceAlerts: alerts.slice(0, MAX_ALERTS) });
  return list();
}

function normId(appId, hash, dir) {
  return `${Number(appId)}:${hash}:${dir}`;
}

function save(input) {
  const appId = Number(input && input.appId);
  const hash = String((input && input.marketHashName) || '').trim();
  const price = Math.round((Number(input && input.price) || 0) * 100) / 100;
  const dir = input && input.dir === 'above' ? 'above' : 'below';
  if (!Number.isFinite(appId) || appId <= 0) throw new Error('缺少市场 AppID');
  if (!hash) throw new Error('缺少物品的市场名称');
  if (!(price > 0)) throw new Error('提醒价格要大于 0');

  const alerts = list();
  const id = normId(appId, hash, dir);
  const prev = alerts.find((a) => a.id === id);
  const rec = {
    id,
    appId,
    marketHashName: hash,
    name: String((input && input.name) || hash),
    dir,
    price,
    createdAt: prev ? prev.createdAt : Date.now(),
    lastPrice: prev ? prev.lastPrice : null,
    side: prev ? prev.side : 'out',
    lastNotifyAt: prev ? prev.lastNotifyAt : 0,
    lastCheckedAt: prev ? prev.lastCheckedAt : 0,
  };
  const next = alerts.filter((a) => a.id !== id);
  next.unshift(rec);
  if (next.length > MAX_ALERTS) next.length = MAX_ALERTS;
  persist(next);
  logger.info('保存价格提醒', { appId, dir, price });
  return { alert: rec, alerts: list() };
}

function remove(id) {
  const next = list().filter((a) => a.id !== id);
  persist(next);
  logger.info('删除价格提醒', { id });
  return list();
}

function money(n) {
  return `¥${Number(n || 0).toFixed(2)}`;
}

function notify(a, price) {
  if (!Notification.isSupported()) return;
  const dirText = a.dir === 'above' ? '已涨到' : '已跌到';
  const n = new Notification({
    title: `价格提醒 · ${a.name}`,
    body: `${dirText} ${money(price)}（你设的 ${a.dir === 'above' ? '≥' : '≤'} ${money(a.price)}）`,
    icon: iconPath || undefined,
    silent: false,
  });
  n.on('click', () => {
    try {
      if (onOpen) onOpen(a);
    } catch { /* ignore */ }
  });
  n.show();
  logger.info('价格提醒触发', { id: a.id, price, target: a.price });
}

async function runOnce() {
  const alerts = list();
  if (!alerts.length) return { checked: 0 };
  let changed = false;
  let hits = 0;
  for (const a of alerts) {
    try {
      const q = await market.quoteOne(a.appId, a.marketHashName, { force: true });
      const price = Number(q && q.lowest);
      if (!(price > 0)) {
        a.lastCheckedAt = Date.now();
        changed = true;
        continue;
      }
      const hit = a.dir === 'above' ? price >= a.price : price <= a.price;
      const wasHit = a.side === 'in';
      const cooled = Date.now() - (a.lastNotifyAt || 0) > RENOTIFY_MS;
      if (hit && (!wasHit || cooled)) {
        notify(a, price);
        a.lastNotifyAt = Date.now();
        hits += 1;
      }
      a.side = hit ? 'in' : 'out';
      a.lastPrice = price;
      a.lastCheckedAt = Date.now();
      changed = true;
    } catch (err) {
      // 限流/网络失败：保留原状态，下次再查，不弹错误
      a.lastCheckedAt = Date.now();
      changed = true;
      if (err && err.code === 'E_RATE_LIMIT') {
        logger.warn('价格提醒查询被限流，本轮停止', { id: a.id });
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (changed) persist(alerts);
  return { checked: alerts.length, hits };
}

async function check() {
  if (running) return;
  running = true;
  try {
    const r = await runOnce();
    if (process.env.SD_TIMING) console.error('[priceAlerts]', JSON.stringify(r));
  } catch (err) {
    logger.warn('价格提醒检查失败', { message: err && err.message });
  } finally {
    running = false;
  }
}

/** @param {{ onOpen?: Function, icon?: string }} opts */
function start(opts = {}) {
  onOpen = opts.onOpen || null;
  iconPath = opts.icon || '';
  if (timer) return;
  setTimeout(() => {
    check();
    timer = setInterval(check, CHECK_MS);
  }, FIRST_DELAY);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { list, save, remove, check, start, stop, _runOnce: runOnce };
