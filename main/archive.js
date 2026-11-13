'use strict';

/**
 * 本地数据归档
 *
 * Steam 的成交历史只给有限页，行情接口也只给当前快照；软件关掉就什么都没了。
 * 这里把两类数据按 JSONL 追加落盘，形成自己的数据底座：
 *
 *   archive/trades/<steamId>.jsonl   每行一条成交（卖出/买入）
 *   archive/quotes/<appId>__<hash>.jsonl  每行一个物品每天的一条行情快照
 *
 * 为什么不用 SQLite：这几千到几万条的规模，JSONL + 内存 Set 去重完全够用；
 * 引入 better-sqlite3 这类原生模块要跟着 Electron ABI 重编译，
 * 一旦版本不匹配会导致整个软件装不上或启动崩溃，收益远小于风险。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SAVE_GAP_MS = 4000;

let root = null;
let statsFile = null;
let stats = { trades: 0, quotes: 0, earliest: 0, latest: 0, updatedAt: 0 };
let statsTimer = null;
let lastSave = 0;

const tradeIds = new Map(); // steamId -> Set(id)
const quoteDays = new Set(); // appId:hash:day

function init(baseDir) {
  if (!baseDir) return;
  root = path.join(baseDir, 'archive');
  try {
    fs.mkdirSync(path.join(root, 'trades'), { recursive: true });
    fs.mkdirSync(path.join(root, 'quotes'), { recursive: true });
  } catch (err) {
    logger.warn('归档目录创建失败', { message: err && err.message });
    root = null;
    return;
  }
  statsFile = path.join(root, 'stats.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    if (loaded && typeof loaded === 'object') stats = { ...stats, ...loaded };
  } catch {
    /* 第一次运行 */
  }
  loadTradeIds();
}

function loadTradeIds() {
  let files = [];
  try {
    files = fs.readdirSync(path.join(root, 'trades')).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  let count = 0;
  for (const f of files) {
    const sid = f.replace(/\.jsonl$/, '');
    const set = new Set();
    try {
      const text = fs.readFileSync(path.join(root, 'trades', f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.id) set.add(String(rec.id));
          if (rec && rec.time) {
            const ts = Number(rec.time) * 1000;
            if (ts < (stats.earliest || Infinity)) stats.earliest = ts;
            if (ts > (stats.latest || 0)) stats.latest = ts;
          }
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 单个文件读失败不影响其它账号 */
    }
    tradeIds.set(sid, set);
    count += set.size;
  }
  // 以实际文件为准，避免 stats.json 与文件不一致
  stats.trades = count;
  saveStats(true);
}

function saveStats(force) {
  if (!statsFile) return;
  stats.updatedAt = Date.now();
  if (force) {
    try {
      const tmp = `${statsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(stats), 'utf8');
      fs.renameSync(tmp, statsFile);
      lastSave = Date.now();
    } catch {
      /* ignore */
    }
    return;
  }
  if (statsTimer) return;
  const wait = Math.max(0, SAVE_GAP_MS - (Date.now() - lastSave));
  statsTimer = setTimeout(() => {
    statsTimer = null;
    saveStats(true);
  }, wait);
  if (typeof statsTimer.unref === 'function') statsTimer.unref();
}

function safeName(hash) {
  return String(hash || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function tradeFile(sid) {
  return path.join(root, 'trades', `${safeName(sid)}.jsonl`);
}

function quoteFile(appId, hashName) {
  return path.join(root, 'quotes', `${Number(appId) || 753}__${safeName(hashName)}.jsonl`);
}

function append(file, rows) {
  if (!root || !rows.length) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (err) {
    logger.warn('归档写入失败', { file: path.basename(file), message: err && err.message });
  }
}

/**
 * 把一次成交历史拉取结果并入归档（按成交 id 去重）。
 * @param {string} steamId
 * @param {Array} items marketHistory 产出的 items
 */
function ingestTrades(steamId, items) {
  const sid = String(steamId || '');
  if (!root || !sid || !Array.isArray(items) || !items.length) {
    return { added: 0, total: tradeIds.get(sid) ? tradeIds.get(sid).size : 0 };
  }
  let set = tradeIds.get(sid);
  if (!set) {
    set = new Set();
    tradeIds.set(sid, set);
  }
  const rows = [];
  for (const it of items) {
    if (!it) continue;
    const id = String(
      it.id || `${it.time || 0}:${it.marketHashName || ''}:${it.kind || ''}:${it.priceCents || 0}`
    );
    if (set.has(id)) continue;
    set.add(id);
    const time = Number(it.time) || 0;
    rows.push({
      id,
      appid: Number(it.appid) || 0,
      marketHashName: it.marketHashName || '',
      name: it.name || it.marketHashName || '',
      kind: it.kind || '',
      priceCents: Number(it.priceCents) || 0,
      receivedCents: Number(it.receivedCents) || 0,
      currency: Number(it.currency) || 0,
      time,
      archivedAt: Date.now(),
    });
    if (time) {
      const ts = time * 1000;
      if (ts < (stats.earliest || Infinity)) stats.earliest = ts;
      if (ts > (stats.latest || 0)) stats.latest = ts;
    }
  }
  if (rows.length) {
    append(tradeFile(sid), rows);
    stats.trades += rows.length;
    saveStats();
  }
  return { added: rows.length, total: set.size };
}

/** 记录一次行情快照，同一物品同一天只留一条 */
function recordQuote(appId, hashName, quote) {
  if (!root || !hashName || !quote) return false;
  const lowest = Number(quote.lowest);
  const median = Number(quote.median);
  if (!(lowest > 0) && !(median > 0)) return false;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${Number(appId) || 753}:${hashName}:${day}`;
  if (quoteDays.has(key)) return false;
  quoteDays.add(key);
  append(quoteFile(appId, hashName), [
    { t: Date.now(), day, lowest: lowest || null, median: median || null, volume: Number(quote.volume) || 0 },
  ]);
  stats.quotes += 1;
  saveStats();
  return true;
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 读取某账号的成交归档 */
function trades(steamId, opts = {}) {
  if (!root) return [];
  const from = Number(opts.from) || 0;
  const to = Number(opts.to) || 0;
  return readJsonl(tradeFile(steamId)).filter(
    (r) => r && Number(r.time) * 1000 >= from && (!to || Number(r.time) * 1000 <= to)
  );
}

/** 某一天的成交汇总（只读归档，不联网；用于概览的每日目标） */
function daySummary(steamId, ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  const to = from + 86400000;
  const rows = trades(steamId, { from, to }).filter((r) => r && r.kind === 'sell');
  const received = rows.reduce((s, r) => s + (Number(r.receivedCents) || 0), 0) / 100;
  return { count: rows.length, received: Math.round(received * 100) / 100, day: d.toISOString().slice(0, 10) };
}

/** 读取某物品的行情序列 */
function series(appId, hashName, days = 30) {
  if (!root) return [];
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  return readJsonl(quoteFile(appId, hashName)).filter((r) => r && Number(r.t) >= cutoff);
}

function accountIds() {
  return [...tradeIds.keys()];
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) total += st.size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

function getState() {
  let quoteFiles = 0;
  try {
    quoteFiles = fs.readdirSync(path.join(root, 'quotes')).filter((f) => f.endsWith('.jsonl')).length;
  } catch {
    /* ignore */
  }
  return {
    ready: !!root,
    trades: stats.trades,
    quotes: stats.quotes,
    quoteItems: quoteFiles,
    accounts: tradeIds.size,
    earliest: stats.earliest || 0,
    latest: stats.latest || 0,
    bytes: root ? dirSize(path.join(root, 'trades')) + dirSize(path.join(root, 'quotes')) : 0,
    updatedAt: stats.updatedAt || 0,
  };
}

/** 导出成交归档为 CSV */
function tradesCsv(steamId) {
  const rows = trades(steamId);
  const head = '时间,类型,物品,appid,买家实付,实际到手,币种,成交id';
  const lines = rows
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map((r) =>
      [
        new Date(Number(r.time) * 1000).toISOString().slice(0, 19).replace('T', ' '),
        r.kind === 'sell' ? '卖出' : r.kind === 'buy' ? '买入' : r.kind,
        `"${String(r.name || '').replace(/"/g, '""')}"`,
        r.appid || '',
        (Number(r.priceCents) || 0) / 100,
        (Number(r.receivedCents) || 0) / 100,
        r.currency || '',
        r.id,
      ].join(',')
    );
  return `﻿${head}\r\n${lines.join('\r\n')}\r\n`;
}

module.exports = {
  init,
  ingestTrades,
  recordQuote,
  trades,
  daySummary,
  series,
  accountIds,
  getState,
  tradesCsv,
};
