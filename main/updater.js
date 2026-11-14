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

const { app, shell, net, session } = require('electron');
const { EventEmitter } = require('events');
const store = require('./store');
const logger = require('./logger');
const notify = require('./notify');

const TIMEOUT_MS = 12000;
const DEFAULT_UPDATE_URL = 'https://api.github.com/repos/kaynai1/steamdeck/releases/latest';

/**
 * 更新事件（main.js 负责转发到渲染进程）:
 *   - found        检查到可用新版本 { current, latest, url, notes, ... }
 *   - dl-progress  安装包下载进度 { got, total, percent }
 */
const events = new EventEmitter();
events.setMaxListeners(20);

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

/** 网络类错误的人话提示（GitHub 下载在很多网络下直连不通，指向代理设置） */
function netErrMsg(e) {
  const raw = (e && e.message) || String(e || '网络错误');
  if (/ERR_|timeout|timed out|aborted|fetch failed|network|reset/i.test(raw)) {
    return '连不上 GitHub（检查更新走 api.github.com，下载安装包走 github.com，部分网络直连不通）。请开启 Clash / v2rayN 等代理后重试；软件已自动探测本机代理，也可在「设置 → 登录窗口代理」手动填写。';
  }
  return raw;
}

/* ----------------------------------------------------------------------------
 * 更新专用网络栈：走 Electron net.fetch（Chromium 网络栈），
 * ① 配置了登录代理 → 走它；② 否则跟随系统代理（Clash 开系统代理即可用）；
 * ③ 系统代理也不通时自动探测本机常见端口，找到可用代理就启用并记住。
 * 为什么不用 Node 的 fetch：它不认 Windows 系统代理，也不认 session.setProxy。
 * -------------------------------------------------------------------------- */
let updaterSes = null;

async function getUpdaterSession(proxy) {
  if (!updaterSes) updaterSes = session.fromPartition('persist:steamdesk-updater');
  try {
    if (proxy) await updaterSes.setProxy({ mode: 'fixed_servers', proxyRules: proxy });
    else await updaterSes.setProxy({ mode: 'system' });
  } catch { /* setProxy 失败不阻塞请求 */ }
  return updaterSes;
}

async function updaterFetch(url, opts = {}) {
  const ses = await getUpdaterSession(String(store.getSettings().loginProxy || '').trim());
  // ①/② 配置代理或跟随系统
  try {
    return await net.fetch(url, { ...opts, session: ses });
  } catch (e) {
    const configured = String(store.getSettings().loginProxy || '').trim();
    // ③ 自动探测本机代理：只在没配置代理时尝试，找到就启用并记住
    if (configured) throw new Error(netErrMsg(e));
    let det = null;
    try {
      det = await require('./proxyDetect').detectProxy();
    } catch { /* 探测失败按直连报错 */ }
    if (det && det.found) {
      try {
        const ses2 = await getUpdaterSession(det.proxy);
        const res = await net.fetch(url, { ...opts, session: ses2 });
        try {
          store.setSettings({ loginProxy: det.proxy });
        } catch { /* 记不住只影响下次 */ }
        logger.info('更新请求自动启用本机代理', { proxy: det.proxy });
        return res;
      } catch (e2) {
        throw new Error(netErrMsg(e2));
      }
    }
    throw new Error(netErrMsg(e));
  }
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
  const res = await withTimeout(updaterFetch(url, { redirect: 'follow', headers }), TIMEOUT_MS, '检查更新');
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
  if (result.hasUpdate) events.emit('found', result);
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

  const res = await updaterFetch(target, {
    headers: { 'User-Agent': 'SteamDesk-Updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  }).catch((e) => {
    throw new Error(netErrMsg(e));
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const out = fs.createWriteStream(file);
  // 下载进度：300ms 节流推给渲染进程，让按钮上能看到百分比
  let lastEmit = 0;
  const emitProgress = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 300) return;
    lastEmit = now;
    events.emit('dl-progress', {
      got,
      total,
      percent: total ? Math.min(100, Math.round((got / total) * 100)) : 0,
    });
  };
  // 流式写入：76MB 的安装包不能一次性进内存
  await new Promise((resolve, reject) => {
    const stream = require('stream');
    const reader = res.body.getReader ? null : null;
    if (res.body && typeof res.body.pipe === 'function') {
      res.body.on('data', (chunk) => {
        got += chunk.length;
        emitProgress(false);
      });
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
          emitProgress(false);
          out.write(value);
        }
        out.end(resolve);
      } catch (e) {
        reject(e);
      }
    })();
  });
  emitProgress(true);
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

module.exports = { check, autoCheck, openDownload, downloadUpdate, getState, compare, events };
