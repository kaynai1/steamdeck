'use strict';

/**
 * 应用内通知中心
 *
 * 系统通知一闪就过，人不在电脑前就漏了。这里把所有通过 notify.send 发出的消息
 * 记一份在本地（最多 300 条），概览页可以回看、标已读、清空。
 * 只记标题和正文，不记凭据。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MAX = 300;
let file = null;
let items = [];

function load() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    loaded = null;
  }
  items = loaded && Array.isArray(loaded.items) ? loaded.items.slice(0, MAX) : [];
}

function init(baseDir) {
  if (!baseDir) return;
  file = path.join(baseDir, 'notices.json');
  load();
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(0, MAX) }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('通知中心写入失败', { message: err && err.message });
  }
}

function add(title, body, kind) {
  items.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    title: String(title || 'SteamDesk').slice(0, 120),
    body: String(body || '').slice(0, 2000),
    kind: kind || 'info',
    read: false,
  });
  items = items.slice(0, MAX);
  save();
}

function list(limit) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  return {
    items: items.slice(0, n),
    unread: items.filter((x) => !x.read).length,
    total: items.length,
  };
}

function markRead(id) {
  if (!id) return list(1);
  const it = items.find((x) => x.id === id);
  if (it) it.read = true;
  save();
  return list(1);
}

function markAll() {
  for (const it of items) it.read = true;
  save();
  return list(1);
}

function clear() {
  items = [];
  save();
  return { items: [], unread: 0, total: 0 };
}

module.exports = { init, add, list, markRead, markAll, clear };
