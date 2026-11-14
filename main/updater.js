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
 * 默认更新源是本项目的 GitHub Releases（未发布 release 时检查会静默跳过）；
 * 在设置里填了自定义更新源则优先用自定义源。地址必须是 https
 * （本地调试允许 http://127.0.0.1）。
 */

const { app, shell } = require('electron');
const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');

const TIMEOUT_MS = 12000;
const DEFAULT_UPDATE_URL = 'https://api.github.com/repos/kaynai1/steamdeck/releases/latest';

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

/** 从 GitHub Releases API 响应里提取版本信息 */
function fromGitHubRelease(json) {
  if (!json || typeof json !== 'object') return null;
  const tag = String(json.tag_name || '').trim();
  if (!tag) return null;
  const assets = Array.isArray(json.assets) ? json.assets : [];
  /* 优先挑 x64 安装包，其次任意 exe/zip 资产 */
  const pick =
    assets.find((a) => /x64.*\.exe$/i.test(a.name || '')) ||
    assets.find((a) => /installer|setup/i.test(a.name || '') && /\.exe$/i.test(a.name || '')) ||
    assets.find((a) => /\.exe$/i.test(a.name || '')) ||
    assets.find((a) => /\.zip$/i.test(a.name || ''));
  return {
    version: norm(tag),
    url: pick ? String(pick.browser_download_url || '') : '',
    htmlUrl: String(json.html_url || ''),
    notes: String(json.body || '').slice(0, 2000),
  };
}

async function check(opts = {}) {
  const s = store.getSettings();
  const customUrl = String(s.updateUrl || '').trim();
  const url = customUrl || DEFAULT_UPDATE_URL;
  const current = app.getVersion();
  const usingDefault = !customUrl;
  if (!allowedUrl(url)) {
    throw Object.assign(new Error('更新源必须是 https 地址（本地调试可用 http://127.0.0.1）'), {
      code: 'E_BAD_URL',
    });
  }
  const headers = { 'User-Agent': 'SteamDesk-Updater' };
  if (/api\.github\.com/.test(url)) headers.Accept = 'application/vnd.github+json';
  const res = await withTimeout(fetch(url, { redirect: 'follow', headers }), TIMEOUT_MS, '检查更新');
  /* GitHub 仓库还没有发布 release 时返回 404：不算错误，只是“没有可检查的新版本” */
  if (res.status === 404 && /api\.github\.com/.test(url)) {
    const result = {
      configured: true,
      usingDefault,
      current,
      hasUpdate: false,
      noRelease: true,
      url: '',
      notes: '',
      at: Date.now(),
    };
    last = result;
    store.setSettings({ updateLastCheckAt: result.at });
    return result;
  }
  if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('更新源返回的不是 JSON');
  }
  let latest = '';
  let downloadUrl = '';
  let notes = '';
  if (/api\.github\.com/.test(url) && json && json.tag_name) {
    const rel = fromGitHubRelease(json);
    latest = (rel && rel.version) || '';
    downloadUrl = (rel && rel.url) || '';
    notes = (rel && rel.notes) || '';
    if (!downloadUrl && rel && rel.htmlUrl) downloadUrl = rel.htmlUrl;
  } else {
    latest = norm(json && json.version);
    downloadUrl = String((json && json.url) || '').trim();
    notes = String((json && json.notes) || '').slice(0, 2000);
  }
  if (!latest) throw new Error('更新源缺少 version 字段（或 release 没有 tag）');
  if (downloadUrl && !allowedUrl(downloadUrl)) {
    throw new Error('下载地址必须是 https 地址');
  }
  const result = {
    configured: true,
    usingDefault,
    current,
    latest,
    hasUpdate: compare(latest, current) > 0,
    url: downloadUrl,
    notes,
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

/** 启动 30 秒后自动检查一次；可在设置里关闭自动检查 */
function autoCheck() {
  if (store.getSettings().updateAutoEnabled === false) return;
  if (store.getSettings().automationPaused === true) return;
  check({ notify: false }).catch((err) => logger.warn('自动检查更新失败', { message: err && err.message }));
}

function openDownload(url) {
  const target = String(url || (last && last.url) || '').trim();
  if (!target) throw new Error('没有可用的下载地址');
  if (!allowedUrl(target)) throw new Error('下载地址必须是 https 地址');
  shell.openExternal(target);
  return { opened: true, url: target };
}

/**
 * 下载更新安装包到系统「下载」目录并直接启动安装程序。
 * 下载完自动运行 setup exe（NSIS 安装器自己会引导安装）；
 * portable 版（zip/exe 免安装）则打开所在文件夹。
 * 返回 { path, launched, bytes }。
 */
const fs = require('fs');
const path = require('path');

async function downloadUpdate(url) {
  const target = String(url || (last && last.url) || '').trim();
  if (!target) throw new Error('没有可用的下载地址');
  if (!allowedUrl(target)) throw new Error('下载地址必须是 https 地址');
  if (!/\.(exe|zip)$/i.test(target)) {
    throw new Error('下载地址不是安装包（.exe/.zip），请在浏览器打开该链接手动下载');
  }
  const dir = app.getPath('downloads') || app.getPath('home');
  const name = `SteamDesk-${(last && norm(last.latest)) || Date.now()}-update${path.extname(target).toLowerCase()}`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });

  const res = await fetch(target, {
    headers: { 'User-Agent': 'SteamDesk-Updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const out = fs.createWriteStream(file);
  // 流式写入：76MB 的安装包不能一次性进内存
  await new Promise((resolve, reject) => {
    const stream = require('stream');
    const reader = res.body.getReader ? null : null;
    if (res.body && typeof res.body.pipe === 'function') {
      res.body.pipe(out);
      res.body.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      return;
    }
    // undici fetch：用 reader 手动写入
    (async () => {
      try {
        const rd = res.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          got += value.length;
          out.write(value);
        }
        out.end(resolve);
      } catch (e) {
        reject(e);
      }
    })();
  });
  logger.info('更新安装包已下载', { file, bytes: got || total });

  const launched = /\.exe$/i.test(name)
    ? shell.openPath(file).then((r) => r === '').catch(() => false)
    : shell.showItemInFolder(file);
  return { path: file, bytes: got || total, launched: await Promise.resolve(launched) };
}

function getState() {
  const s = store.getSettings();
  return {
    current: app.getVersion(),
    url: s.updateUrl || '',
    usingDefault: !String(s.updateUrl || '').trim(),
    autoEnabled: s.updateAutoEnabled !== false,
    lastAt: Number(s.updateLastCheckAt) || 0,
    lastVersion: s.updateLastVersion || '',
    last,
  };
}

module.exports = { check, autoCheck, openDownload, downloadUpdate, getState, compare };
