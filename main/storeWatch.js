'use strict';

/**
 * 商店价格提醒 / 折扣监控
 *
 * 和「物品价格提醒」不同，这里盯的是 Steam 商店里整款游戏的价格：
 *   - 目标价：现价跌到设定值就通知（例如「黑神话降到 ¥150 提醒我」）
 *   - 折扣：打折力度达到设定百分比就通知
 *
 * 每 30 分钟查一轮（可手动立即检查），同一条件只提醒一次；
 * 继续降价会按 12 小时间隔重复提醒，避免一直刷屏。
 */

const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');
const { queryStorePrice } = require('./storeSearch');

const FIRST_DELAY = 3 * 60 * 1000;
const CHECK_MS = 30 * 60 * 1000;
const REPEAT_MS = 12 * 60 * 60 * 1000;

let timer = null;
let firstTimer = null;
let running = false;

function alerts() {
  const list = store.getSettings().storeAlerts;
  return Array.isArray(list) ? list : [];
}

function save(list) {
  store.setSettings({ storeAlerts: list.slice(0, 50) });
}

function region() {
  return String(store.getSettings().storeRegion || 'CN');
}

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

function add(appId, opts = {}) {
  const id = Number(appId);
  if (!id || id <= 0) throw err('E_BAD_APPID', 'AppID 不对');
  const targetYuan = Math.max(0, Number(opts.targetYuan) || 0);
  const discountPct = Math.min(100, Math.max(0, Number(opts.discountPct) || 0));
  if (!targetYuan && !discountPct) throw err('E_BAD_ALERT', '目标价和折扣至少填一个');
  const list = alerts();
  if (list.some((a) => Number(a.appId) === id && Number(a.targetYuan) === targetYuan && Number(a.discountPct) === discountPct)) {
    throw err('E_DUP_ALERT', '已经有一条一样的提醒了');
  }
  const item = {
    id: `${id}-${Date.now().toString(36)}`,
    appId: id,
    name: String(opts.name || `App ${id}`).slice(0, 80),
    targetYuan,
    discountPct,
    createdAt: Date.now(),
    lastAt: 0,
    lastPrice: 0,
    lastDiscount: 0,
    lastHit: false,
    lastNotifiedAt: 0,
    lastError: '',
  };
  save([...list, item]);
  logger.info('添加商店价格提醒', { appId: id, targetYuan, discountPct });
  return item;
}

function remove(id) {
  const list = alerts();
  const next = list.filter((a) => String(a.id) !== String(id));
  save(next);
  return { removed: list.length - next.length, list: next };
}

function list() {
  return alerts();
}

async function checkOnce(opts = {}) {
  if (running) return { skipped: true, reason: '正在检查' };
  const all = alerts();
  if (!all.length) return { checked: 0, hits: 0 };
  running = true;
  const next = [];
  let hits = 0;
  let checked = 0;
  try {
    for (const a of all) {
      const item = { ...a, lastAt: Date.now() };
      try {
        const p = await queryStorePrice(a.appId, { region: region() });
        item.name = p.name || item.name;
        item.lastPrice = p.isFree ? 0 : p.finalPriceYuan;
        item.lastDiscount = p.discountPercent || 0;
        item.lastError = '';
        checked++;
        const targetHit = Number(a.targetYuan) > 0 && item.lastPrice > 0 && item.lastPrice <= Number(a.targetYuan);
        const discountHit = Number(a.discountPct) > 0 && item.lastDiscount >= Number(a.discountPct);
        const hit = targetHit || discountHit;
        const fresh = hit && (!a.lastHit || Date.now() - (Number(a.lastNotifiedAt) || 0) > REPEAT_MS);
        item.lastHit = hit;
        if (fresh) {
          hits++;
          item.lastNotifiedAt = Date.now();
          const why = [];
          if (targetHit) why.push(`降到 ¥${item.lastPrice.toFixed(2)}（目标 ¥${Number(a.targetYuan).toFixed(2)}）`);
          if (discountHit) why.push(`折扣 -${item.lastDiscount}%（目标 ${a.discountPct}%）`);
          notify.send(`价格提醒：《${item.name}》`, `${why.join('，')}\n${p.steamStoreUrl || ''}`.trim(), {
            kind: 'good',
          });
        }
      } catch (e) {
        item.lastError = (e && e.message) || '查询失败';
      }
      next.push(item);
      await new Promise((r) => setTimeout(r, 900));
    }
    // 以检查结束时的列表为准：检查过程中被删掉的提醒不能复活，
    // 检查过程中新增的提醒也要保留。
    const latest = alerts();
    const alive = new Set(latest.map((a) => String(a.id)));
    const kept = next.filter((a) => alive.has(String(a.id)));
    const ids = new Set(kept.map((a) => String(a.id)));
    const rest = latest.filter((a) => !ids.has(String(a.id)));
    save([...kept, ...rest]);
    return { checked, hits, total: all.length };
  } finally {
    running = false;
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => checkOnce().catch(() => {}), CHECK_MS);
}

function start() {
  if (firstTimer) clearTimeout(firstTimer);
  firstTimer = setTimeout(() => {
    if (alerts().length) checkOnce().catch(() => {});
  }, FIRST_DELAY);
  reschedule();
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

module.exports = { add, remove, list, checkOnce, start, stop, reschedule };
