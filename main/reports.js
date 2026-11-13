'use strict';

/**
 * 每日 / 每周经营报表
 *
 * 数据来自当前网页登录账号的 Steam 成交历史（和「成交历史」页同源），
 * 卖出按买家实付算流水、按实际到手算净收入，手续费 = 流水 - 到手；
 * 有成本记录的物品顺便算已实现盈亏。
 *
 * 每天到点（默认 21:00）弹一次系统通知，内容只包含当天卖出件数、
 * 到手和手续费；完整报表在概览页「经营报表」里看。
 */

const fs = require('fs');
const path = require('path');
const notifier = require('./notify');
const store = require('./store');
const logger = require('./logger');
const costs = require('./costs');
const history = require('./marketHistory');

const TICK_MS = 15 * 60 * 1000;
const KEEP_DAYS = 60;

let file = null;
let state = { lastNotifyDay: '', last: null };
let timer = null;
let iconPath = '';
let running = false;

const SYM = {
  2001: '$', 2002: '£', 2003: '$', 2004: '€', 2005: '¥', 2006: 'руб', 2007: '₩',
  2008: 'R$', 2009: '¥', 2010: '₺', 2011: '₽', 2012: '₴', 2013: 'kr', 2014: 'CHF',
  2015: 'A$', 2016: 'C$', 2017: 'NZ$', 2018: 'R', 2019: 'лв', 2020: 'Ft', 2021: 'zł',
  2022: 'kr', 2023: '¥', 2024: '₹', 2025: 'CLP$', 2026: 'S/', 2027: 'COL$', 2028: 'R',
  2029: 'HK$', 2030: 'NT$', 2031: 'SR', 2032: 'AED', 2033: 'ARS$', 2034: '₪', 2035: 'Br',
};

function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfDay(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function money(cents) {
  return Math.round((Number(cents) || 0)) / 100;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${label}超时（网络或代理问题）`), { code: 'E_TIMEOUT' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'reports.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state.lastNotifyDay = loaded.lastNotifyDay || '';
      state.last = loaded.last || null;
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
    logger.warn('报表状态写入失败', { message: err && err.message });
  }
}

function emptyRow(date) {
  return {
    date,
    sellN: 0,
    grossCents: 0,
    receivedCents: 0,
    feeCents: 0,
    buyN: 0,
    spendCents: 0,
    realizedCents: 0,
    realizedN: 0,
  };
}

function summarize(rows) {
  const t = emptyRow('');
  for (const r of rows) {
    t.sellN += r.sellN;
    t.grossCents += r.grossCents;
    t.receivedCents += r.receivedCents;
    t.feeCents += r.feeCents;
    t.buyN += r.buyN;
    t.spendCents += r.spendCents;
    t.realizedCents += r.realizedCents;
    t.realizedN += r.realizedN;
  }
  return {
    sellN: t.sellN,
    gross: money(t.grossCents),
    received: money(t.receivedCents),
    fee: money(t.feeCents),
    buyN: t.buyN,
    spend: money(t.spendCents),
    realized: money(t.realizedCents),
    realizedN: t.realizedN,
    net: money(t.receivedCents - t.spendCents),
  };
}

/**
 * 生成近 N 天报表。
 * @param {number} days
 */
async function build(days) {
  const n = Math.max(1, Math.min(KEEP_DAYS, Number(days) || 14));
  const data = await withTimeout(history.myHistory(), 60000, '读取成交历史');
  const items = data.items || [];
  const sid = data.steamId || '';
  const costMap = costs.list(sid);

  // 历史里可能混着不同钱包币种，只统计最近一笔成交的币种
  const latest = items.find((x) => Number(x.currency)) || items[0] || null;
  const currency = latest ? Number(latest.currency) || 0 : 0;
  const sym = SYM[currency] || '¥';
  const usable = items.filter((x) => (Number(x.currency) || 0) === currency);
  const skipped = items.length - usable.length;

  // 其它币种的成交不能直接相加，但也不能当没看见：按币种分别汇总给界面说明
  const curAgg = new Map();
  for (const it of items) {
    const c = Number(it.currency) || 0;
    if (!c) continue;
    const a =
      curAgg.get(c) ||
      { currency: c, sym: SYM[c] || `${c}`, sellN: 0, buyN: 0, grossCents: 0, receivedCents: 0, feeCents: 0, spendCents: 0 };
    const price = Number(it.priceCents) || 0;
    const rec = Number(it.receivedCents) || 0;
    if (it.kind === 'sell') {
      a.sellN++;
      a.grossCents += price;
      a.receivedCents += rec;
      a.feeCents += Math.max(0, price - rec);
    } else if (it.kind === 'buy') {
      a.buyN++;
      a.spendCents += price;
    }
    curAgg.set(c, a);
  }
  const byCurrency = [...curAgg.values()]
    .map((a) => ({
      currency: a.currency,
      sym: a.sym,
      sellN: a.sellN,
      buyN: a.buyN,
      gross: money(a.grossCents),
      received: money(a.receivedCents),
      fee: money(a.feeCents),
      spend: money(a.spendCents),
    }))
    .sort((a, b) => b.received - a.received);

  const first = startOfDay(Date.now() - (n - 1) * 86400000);
  const rows = [];
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const key = dayKey(first + i * 86400000);
    const row = emptyRow(key);
    map.set(key, row);
    rows.push(row);
  }

  const byAppMap = new Map();
  const appRow = (appId) => {
    const key = Number(appId) || 0;
    if (!byAppMap.has(key)) byAppMap.set(key, { appId: key, ...emptyRow('') });
    return byAppMap.get(key);
  };

  for (const it of usable) {
    const ts = Number(it.time) * 1000;
    if (ts < first) continue;
    const row = map.get(dayKey(ts));
    if (!row) continue;
    const app = appRow(it.appid);
    if (it.kind === 'sell') {
      const gross = Number(it.priceCents) || 0;
      const received = Number(it.receivedCents) || gross;
      const fee = Math.max(0, gross - received);
      const rec = costMap[it.marketHashName];
      const unit = rec ? Number(rec.cost) || 0 : 0;
      row.sellN += 1;
      row.grossCents += gross;
      row.receivedCents += received;
      row.feeCents += fee;
      app.sellN += 1;
      app.grossCents += gross;
      app.receivedCents += received;
      app.feeCents += fee;
      if (unit > 0) {
        row.realizedCents += received - Math.round(unit * 100);
        row.realizedN += 1;
        app.realizedCents += received - Math.round(unit * 100);
        app.realizedN += 1;
      }
    } else if (it.kind === 'buy') {
      const spend = Number(it.priceCents) || 0;
      row.buyN += 1;
      row.spendCents += spend;
      app.buyN += 1;
      app.spendCents += spend;
    }
  }

  // 平均持有天数：按时间顺序把同款「买入 → 卖出」配对
  const chrono = usable.slice().sort((a, b) => Number(a.time) - Number(b.time));
  const lastBuy = new Map();
  let holdSum = 0;
  let holdN = 0;
  for (const it of chrono) {
    const key = it.marketHashName || '';
    const ts = Number(it.time) * 1000;
    if (it.kind === 'buy') {
      lastBuy.set(key, ts);
    } else if (it.kind === 'sell') {
      const b = lastBuy.get(key);
      if (b && ts > b) {
        holdSum += (ts - b) / 86400000;
        holdN += 1;
      }
    }
  }

  // 本周（周一至今）
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const monday = dayKey(startOfDay(Date.now() - dow * 86400000));
  const prevMonday = dayKey(startOfDay(Date.now() - (dow + 7) * 86400000));
  const weekRows = rows.filter((r) => r.date >= monday);
  const prevWeekRows = rows.filter((r) => r.date >= prevMonday && r.date < monday);

  return {
    at: Date.now(),
    steamId: sid,
    days: n,
    currency,
    sym,
    skipped,
    byCurrency,
    truncated: !!data.truncated,
    holdDays: holdN ? Math.round((holdSum / holdN) * 10) / 10 : 0,
    holdSamples: holdN,
    rows: rows.map((r) => ({
      date: r.date,
      sellN: r.sellN,
      gross: money(r.grossCents),
      received: money(r.receivedCents),
      fee: money(r.feeCents),
      buyN: r.buyN,
      spend: money(r.spendCents),
      realized: money(r.realizedCents),
      realizedN: r.realizedN,
    })),
    totals: summarize(rows),
    byApp: [...byAppMap.values()]
      .filter((x) => x.sellN || x.buyN)
      .sort((a, b) => b.receivedCents - a.receivedCents)
      .map((x) => ({
        appId: x.appId,
        sellN: x.sellN,
        gross: money(x.grossCents),
        received: money(x.receivedCents),
        fee: money(x.feeCents),
        buyN: x.buyN,
        spend: money(x.spendCents),
        realized: money(x.realizedCents),
        realizedN: x.realizedN,
      })),
    week: { label: `本周（${monday} 起）`, ...summarize(weekRows) },
    prevWeek: { label: '上周', ...summarize(prevWeekRows) },
  };
}

/** 只用第一页成交算今天的简报，开销小，用于每天通知 */
async function todayBrief() {
  const data = await withTimeout(history.recentHistory(), 30000, '读取今日成交');
  const items = (data.items || []).filter((x) => x.kind === 'sell');
  const start = startOfDay();
  const today = items.filter((x) => Number(x.time) * 1000 >= start);
  let gross = 0;
  let received = 0;
  for (const x of today) {
    const g = Number(x.priceCents) || 0;
    gross += g;
    received += Number(x.receivedCents) || g;
  }
  return {
    at: Date.now(),
    steamId: data.steamId || '',
    sellN: today.length,
    gross: money(gross),
    received: money(received),
    fee: money(Math.max(0, gross - received)),
  };
}

async function notifyToday() {
  if (running) return { skipped: true };
  running = true;
  try {
    const brief = await todayBrief();
    state.lastNotifyDay = dayKey();
    state.last = brief;
    save();
    if (brief.sellN > 0) {
      notifier.send(
        `今日经营 · 卖出 ${brief.sellN} 件`,
        `到手 ¥${brief.received.toFixed(2)} · 流水 ¥${brief.gross.toFixed(2)} · 手续费 ¥${brief.fee.toFixed(2)}`
      );
    }
    logger.info('每日经营简报', { sellN: brief.sellN, received: brief.received });
    return brief;
  } catch (err) {
    logger.warn('每日经营简报失败', { message: err && err.message });
    return { error: err.message };
  } finally {
    running = false;
  }
}

function maybeNotify() {
  const s = store.getSettings();
  if (s.reportNotify === false) return;
  if (s.automationPaused === true) return;
  const hour = Math.max(0, Math.min(23, Number(s.reportHour) || 21));
  const now = new Date();
  if (now.getHours() < hour) return;
  if (state.lastNotifyDay === dayKey()) return;
  notifyToday().catch(() => {});
}

/** 导出报表 CSV（带 BOM） */
function csv(report) {
  const lines = ['日期,卖出件数,挂单流水,实际到手,手续费,买入件数,买入支出,已实现盈亏,盈亏覆盖笔数'];
  for (const r of report.rows || []) {
    lines.push(
      `${r.date},${r.sellN},${r.gross.toFixed(2)},${r.received.toFixed(2)},${r.fee.toFixed(
        2
      )},${r.buyN},${r.spend.toFixed(2)},${r.realized.toFixed(2)},${r.realizedN}`
    );
  }
  const t = report.totals || {};
  lines.push(
    `合计,${t.sellN || 0},${(t.gross || 0).toFixed(2)},${(t.received || 0).toFixed(2)},${(
      t.fee || 0
    ).toFixed(2)},${t.buyN || 0},${(t.spend || 0).toFixed(2)},${(t.realized || 0).toFixed(
      2
    )},${t.realizedN || 0}`
  );
  return `﻿${lines.join('\r\n')}\r\n`;
}

function start(opts = {}) {
  iconPath = opts.icon || '';
  if (timer) return;
  setTimeout(maybeNotify, 90 * 1000);
  timer = setInterval(maybeNotify, TICK_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getState() {
  return { ...state, lastNotifyDay: state.lastNotifyDay || '' };
}

module.exports = { init, start, stop, build, todayBrief, notifyToday, csv, getState };
