'use strict';

/**
 * 免费游戏提醒
 *
 * 启动 45 秒后查一次，之后每 6 小时查一次；发现上次没见过的活动就弹系统通知，
 * 点通知直接打开软件里的「免费领取」页。
 *
 * 两个克制的地方：
 *   · 第一次运行只记账不弹窗，否则刚装好就被一堆「新游戏」刷屏；
 *   · 用户可在托盘菜单里关掉提醒（设置项 freeNotify），关掉后连请求都不发。
 */

const fs = require('fs');
const path = require('path');
const { Notification } = require('electron');
const store = require('./store');

const INTERVAL = 6 * 60 * 60 * 1000;
const FIRST_DELAY = 45 * 1000;

let timer = null;
let onOpen = null;
let iconPath = '';
let running = false;

function seenFile() {
  try {
    const dir = store.baseDir;
    return dir ? path.join(dir, 'free-seen.json') : null;
  } catch {
    return null;
  }
}

function readSeen() {
  const file = seenFile();
  if (!file) return { ids: [], at: 0 };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ids: Array.isArray(d.ids) ? d.ids : [], at: Number(d.at) || 0 };
  } catch {
    return { ids: [], at: 0 };
  }
}

function writeSeen(ids) {
  const file = seenFile();
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ids, at: Date.now() }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 记录失败最多下次再提醒一遍 */
  }
}

function fmtEnd(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function runOnce() {
  if (store.getSettings().freeNotify === false) return { skipped: true };

  const data = await require('./freeGames').list(false);
  const items = (data.items || []).filter((x) => x && x.id && !x.upcoming);
  const prev = readSeen();
  const seen = new Set(prev.ids || []);
  const fresh = items.filter((x) => !seen.has(x.id));
  const firstTime = !prev.at;

  // 只保留当前仍在活动中的 id，过期的自然清掉，文件不会越滚越大
  writeSeen(items.map((x) => x.id));

  if (firstTime || !fresh.length) return { fresh: fresh.length, firstTime };
  if (!Notification.isSupported()) return { fresh: fresh.length, unsupported: true };

  const top = fresh.slice().sort((a, b) => (a.endAt || 0) - (b.endAt || 0));
  const names = top.slice(0, 3).map((x) => `《${x.title}》`).join('、');
  const more = top.length > 3 ? ` 等 ${top.length} 款` : '';
  const endAt = top.find((x) => x.endAt);
  const body = `${names}${more}${endAt ? ` · ${fmtEnd(endAt.endAt)} 截止` : ''}`;

  const n = new Notification({
    title: `新增 ${fresh.length} 款免费游戏`,
    body,
    icon: iconPath || undefined,
    silent: false,
  });
  n.on('click', () => {
    try {
      if (onOpen) onOpen();
    } catch { /* ignore */ }
  });
  n.show();
  return { fresh: fresh.length };
}

async function check() {
  if (running) return;
  running = true;
  try {
    const r = await runOnce();
    if (process.env.SD_TIMING) console.error('[freeNotify]', JSON.stringify(r));
  } catch (err) {
    if (process.env.SD_TIMING) console.error('[freeNotify] 检查失败', err && err.message);
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
    timer = setInterval(check, INTERVAL);
  }, FIRST_DELAY);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, check, _runOnce: runOnce };
