'use strict';

/**
 * 成本价记录
 *
 * 结构：{ "<steamId>": { "<marketHashName>": { cost: 12.34, at: 1794... } } }
 * cost 是「每件」的买入成本（人民币元）。按账号分开记：
 * 同一个物品在不同号上可能是不同价格买来的，混在一起算盈亏没有意义。
 *
 * 单独存 costs.json，不塞 settings：库存几百种物品，settings 会变得很难读。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const store = require('./store');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

let file = null;
let data = null;

function load() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    loaded = null;
  }
  data = loaded && typeof loaded === 'object' ? loaded : {};
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'costs.json');
  load();
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('成本记录写入失败', { message: err && err.message });
  }
}

function ensure() {
  if (!data) data = {};
  return data;
}

/** 某个账号的全部成本记录 */
function list(steamId) {
  const sid = String(steamId || '');
  const all = ensure();
  return all[sid] && typeof all[sid] === 'object' ? { ...all[sid] } : {};
}

/** 单件物品的成本记录（查不到返回 null） */
function get(steamId, marketHashName) {
  const sid = String(steamId || '');
  const hash = String(marketHashName || '').trim();
  const all = ensure();
  const acc = all[sid];
  return acc && hash ? acc[hash] || null : null;
}

/** 设置一件物品的每件成本；cost <= 0 视为删除 */
function set(steamId, marketHashName, cost) {
  const sid = String(steamId || '');
  const hash = String(marketHashName || '').trim();
  const yuan = Math.round((Number(cost) || 0) * 100) / 100;
  if (!sid) throw new Error('缺少账号');
  if (!hash) throw new Error('缺少物品的市场名称');
  const all = ensure();
  const acc = all[sid] && typeof all[sid] === 'object' ? all[sid] : {};
  if (!(yuan > 0)) {
    if (acc[hash]) {
      delete acc[hash];
      all[sid] = acc;
      save();
      logger.info('删除成本记录', { steamId: sid, hash });
    }
    return { removed: true, costs: { ...acc } };
  }
  acc[hash] = { cost: yuan, at: Date.now(), buys: 1, lastBuyAt: Date.now() };
  all[sid] = acc;
  save();
  logger.info('记录成本价', { steamId: sid, hash, cost: yuan });
  return { removed: false, item: acc[hash], costs: { ...acc } };
}

function remove(steamId, marketHashName) {
  return set(steamId, marketHashName, 0);
}

/** 清空某个账号的全部成本记录 */
function clear(steamId) {
  const sid = String(steamId || '');
  if (!sid) throw new Error('缺少账号');
  const all = ensure();
  const n = all[sid] ? Object.keys(all[sid]).length : 0;
  if (all[sid]) {
    delete all[sid];
    save();
    logger.info('清空成本记录', { steamId: sid, rows: n });
  }
  return { removed: n, costs: {} };
}

/**
 * 批量写入成本（回填 / CSV 导入都走这里）。
 * 只写一次盘，避免几百件物品逐条 set 造成卡顿。
 * @param {boolean} [overwrite] 已有记录是否覆盖；默认只补缺失
 */
function bulkSet(steamId, map, overwrite) {
  const sid = String(steamId || '');
  if (!sid) throw new Error('缺少账号');
  const all = ensure();
  const acc = all[sid] && typeof all[sid] === 'object' ? all[sid] : {};
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const [hash, value] of Object.entries(map || {})) {
    const key = String(hash || '').trim();
    // 允许 { cost, buys, lastBuyAt }，回填时把买入次数一并记下来，
    // 界面上就能说明这个均价是几次买入算出来的。
    const rec = value && typeof value === 'object' ? value : { cost: value };
    const yuan = round2(rec.cost);
    if (!key || !(yuan > 0)) continue;
    if (acc[key]) {
      if (!overwrite) {
        skipped++;
        continue;
      }
      updated++;
    } else {
      added++;
    }
    acc[key] = {
      cost: yuan,
      at: Date.now(),
      buys: Math.max(1, Number(rec.buys) || 1),
      lastBuyAt: Number(rec.lastBuyAt) || Date.now(),
    };
  }
  if (added || updated) {
    all[sid] = acc;
    save();
    logger.info('批量记录成本', { steamId: sid, added, updated, skipped });
  }
  return { added, updated, skipped, total: Object.keys(acc).length, costs: { ...acc } };
}

/**
 * 按市场成交里的买入记录自动记成本。
 *
 * - 只统计人民币（币种 23）的 buy 记录，外币不猜汇率；
 * - 同一物品多次买入取算术平均价，并记下买入次数；
 * - 默认只补「还没有成本」的物品，手工填过的不会被覆盖（autoCostOverwrite 才覆盖）；
 * - 自动写入的记录带 auto:true，用户之后手动改价会用 set() 覆盖成手工记录。
 */
function ingestBuys(steamId, items) {
  const sid = String(steamId || '');
  if (!sid) return { added: 0, updated: 0, skipped: 0 };
  const s = store.getSettings();
  if (s.autoCostFromTrades !== true) return { added: 0, updated: 0, skipped: 0, disabled: true };
  const overwrite = s.autoCostOverwrite === true;

  const groups = new Map();
  for (const it of items || []) {
    if (!it || it.kind !== 'buy' || !it.marketHashName) continue;
    if (Number(it.currency) !== 23) continue; // 只认人民币
    const cents = Number(it.priceCents) || 0;
    if (!(cents > 0)) continue;
    const rec = groups.get(it.marketHashName) || { sum: 0, n: 0, last: 0 };
    rec.sum += cents;
    rec.n += 1;
    rec.last = Math.max(rec.last, Number(it.time) || 0);
    groups.set(it.marketHashName, rec);
  }
  if (!groups.size) return { added: 0, updated: 0, skipped: 0 };

  const all = ensure();
  const acc = all[sid] && typeof all[sid] === 'object' ? all[sid] : {};
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const [hash, rec] of groups) {
    const avg = round2(rec.sum / rec.n / 100);
    if (!(avg > 0)) continue;
    const prev = acc[hash];
    if (prev && prev.auto !== true && !overwrite) {
      skipped++;
      continue;
    }
    if (prev) updated++;
    else added++;
    acc[hash] = {
      cost: avg,
      at: Date.now(),
      buys: rec.n,
      lastBuyAt: rec.last ? rec.last * 1000 : Date.now(),
      auto: true,
    };
  }
  if (added || updated) {
    all[sid] = acc;
    save();
    logger.info('按成交自动记成本', { steamId: sid, added, updated, skipped });
  }
  return { added, updated, skipped, total: Object.keys(acc).length };
}

/** 简易 CSV 行解析：支持双引号包裹、逗号与转义引号 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 解析成本 CSV：第一列 market_hash_name，第二列每件成本（元）。
 * 有表头会被自然跳过（表头第二列不是数字）。
 */
function parseCsv(text) {
  const out = {};
  const lines = String(text || '')
    .replace(/^﻿/, '')
    .split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    if (cells.length < 2) continue;
    const hash = String(cells[0] || '').trim();
    const raw = String(cells[1] || '').replace(/[^\d.\-]/g, '');
    const yuan = round2(Number(raw));
    if (!hash || !(yuan > 0)) continue;
    out[hash] = yuan;
  }
  return out;
}

/** 导出成本表（带 BOM，Excel 打开中文不乱码） */
function csvFor(steamId) {
  const costs = list(steamId);
  const rows = Object.entries(costs).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const lines = ['market_hash_name,cost'];
  for (const [hash, rec] of rows) {
    lines.push(`"${String(hash).replace(/"/g, '""')}",${(Number(rec.cost) || 0).toFixed(2)}`);
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * 持仓盈亏总览。
 *
 * 数量来源优先用库存监控快照（零网络开销），没有快照才实时读一次
 * Steam 社区物品（绝大多数成本记录都在 753）。只对有成本记录的物品查价，
 * 不会把整个库存都查一遍。
 */
async function overview(steamId) {
  const sid = String(steamId || '');
  const costs = list(sid);
  const hashes = Object.keys(costs);
  const out = {
    at: Date.now(),
    steamId: sid,
    tracked: hashes.length,
    held: 0,
    units: 0,
    cost: 0,
    value: 0,
    profit: 0,
    below: 0,
    quoted: 0,
    unknown: 0,
    source: '',
    busy: false,
    empty: !hashes.length,
  };
  if (!hashes.length) return out;

  const qty = {};
  const appOf = {};
  let snap = null;
  try {
    snap = require('./invWatch')._snapshotFor(sid);
  } catch {
    snap = null;
  }
  if (snap && Object.keys(snap).length) {
    out.source = 'snapshot';
    for (const [appId, items] of Object.entries(snap)) {
      for (const [key, v] of Object.entries(items || {})) {
        if (!costs[key]) continue;
        qty[key] = (qty[key] || 0) + (Number(v.q) || 0);
        appOf[key] = Number(appId) || 753;
      }
    }
  }
  if (!Object.keys(qty).length) {
    out.source = 'live';
    try {
      const data = await require('./inventory').fetchInventory(sid, 753, null, { noNote: true });
      for (const g of (data && data.groups) || []) {
        const key = g.marketHashName || g.key;
        if (!key || !costs[key]) continue;
        qty[key] = (qty[key] || 0) + (Number(g.qty) || 0);
        appOf[key] = Number(g.appId) || 753;
      }
    } catch (err) {
      logger.warn('持仓盈亏：读取库存失败', { steamId: sid, message: err && err.message });
    }
  }

  const held = Object.keys(qty).filter((k) => qty[k] > 0);
  out.held = held.length;
  if (!held.length) return out;
  out.units = held.reduce((s, k) => s + qty[k], 0);

  // 市场按 appid 分组查价
  const byApp = new Map();
  for (const key of held) {
    const app = appOf[key] || 753;
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app).push(key);
  }
  const quotes = {};
  for (const [appId, list] of byApp) {
    try {
      const r = await require('./market').quoteMany(appId, list);
      for (const q of (r && r.results) || []) {
        if (q && q.marketHashName) quotes[q.marketHashName] = q;
      }
    } catch (err) {
      if (err && err.code === 'E_BUSY') out.busy = true;
      logger.warn('持仓盈亏：查价失败', { appId, message: err && err.message });
    }
    await sleep(300);
  }

  let costSum = 0;
  let valueSum = 0;
  for (const key of held) {
    const c = (Number(costs[key].cost) || 0) * qty[key];
    costSum += c;
    const q = quotes[key];
    const low = Number(q && q.lowest) || 0;
    if (low > 0) {
      out.quoted += 1;
      const v = low * qty[key];
      valueSum += v;
      if (v < c - 0.004) out.below += 1;
    } else {
      out.unknown += 1;
    }
  }
  out.cost = round2(costSum);
  out.value = round2(valueSum);
  out.profit = round2(valueSum - costSum);
  logger.info('持仓盈亏总览', {
    steamId: sid,
    held: out.held,
    quoted: out.quoted,
    profit: out.profit,
    source: out.source,
  });
  return out;
}

module.exports = { init, list, get, set, remove, clear, bulkSet, ingestBuys, parseCsv, csvFor, overview };

