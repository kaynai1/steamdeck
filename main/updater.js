'use strict';

/**
 * 版本更新检查
 *
 * 不做静默自动安装：这个软件是用户从网盘/朋友手里拿到的安装包，
 * 没有代码签名，也没有固定的发布服务器，静默替换 exe 的风险大于收益。
 * 这里只做「读一个 JSON → 比较版本 → 提示下载」：
 *
 *   {
 *     "version": "2.6.42",
 *     "url": "https://example.com/SteamDesk-2.6.42-x64.exe",
 *     "notes": "本次更新内容…"
 *   }
 *
 * 地址由用户自己在设置里填，必须是 https（本地调试允许 http://127.0.0.1）。
 */

const { app, shell } = require('electron');
const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');

const TIMEOUT_MS = 12000;

let last = null;

function withTimeout(promise, ms, label) {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(Object.assign(new Error(`${label}超时（网络或代理问题）`), { code: 'E_TIMEOUT' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function norm(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
}

/** 比较版本号：a > b 返回 1，相等 0，小于 -1 */
function compare(a, b) {
  const pa = norm(a).split('.').map((x) => Number(x) || 0);
  const pb = norm(b).split('.').map((x) => Number(x) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function allowedUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

async function check(opts = {}) {
  const url = String(store.getSettings().updateUrl || '').trim();
  const current = app.getVersion();
  if (!url) {
    return { configured: false, current, hasUpdate: false };
  }
  if (!allowedUrl(url)) {
    throw Object.assign(new Error('更新源必须是 https 地址（本地调试可用 http://127.0.0.1）'), {
      code: 'E_BAD_URL',
    });
  }
  const res = await withTimeout(fetch(url, { redirect: 'follow' }), TIMEOUT_MS, '检查更新');
  if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}`);
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error('更新源返回的不是 JSON');
  }
  const latest = norm(json && json.version);
  if (!latest) throw new Error('更新源 JSON 缺少 version 字段');
  const downloadUrl = String((json && json.url) || '').trim();
  if (downloadUrl && !allowedUrl(downloadUrl)) {
    throw new Error('下载地址必须是 https 地址');
  }
  const result = {
    configured: true,
    current,
    latest,
    hasUpdate: compare(latest, current) > 0,
    url: downloadUrl,
    notes: String((json && json.notes) || '').slice(0, 2000),
    at: Date.now(),
  };
  last = result;
  store.setSettings({ updateLastCheckAt: result.at, updateLastVersion: latest });
  logger.info('检查更新', { current, latest, hasUpdate: result.hasUpdate });
  if (result.hasUpdate && opts.notify !== false) {
    notify.send(`发现新版本 ${latest}`, `当前 ${current}。点此打开下载页。`, {
      onClick: () => {
        if (downloadUrl) shell.openExternal(downloadUrl).catch(() => {});
      },
    });
  }
  return result;
}

/** 启动 30 秒后自动检查一次；没配置地址就什么都不做 */
function autoCheck() {
  if (!String(store.getSettings().updateUrl || '').trim()) return;
  if (store.getSettings().automationPaused === true) return;
  check().catch((err) => logger.warn('自动检查更新失败', { message: err && err.message }));
}

function openDownload(url) {
  const target = String(url || (last && last.url) || '').trim();
  if (!target) throw new Error('没有可用的下载地址');
  if (!allowedUrl(target)) throw new Error('下载地址必须是 https 地址');
  shell.openExternal(target);
  return { opened: true, url: target };
}

function getState() {
  const s = store.getSettings();
  return {
    current: app.getVersion(),
    url: s.updateUrl || '',
    lastAt: Number(s.updateLastCheckAt) || 0,
    lastVersion: s.updateLastVersion || '',
    last,
  };
}

module.exports = { check, autoCheck, openDownload, getState, compare };
