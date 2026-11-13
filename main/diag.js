'use strict';

/**
 * 诊断包：把"排查问题需要的东西"打成一个文本文件。
 *
 * 里面只有：版本/系统信息、脱敏后的设置、最近几天的日志、界面上最近的操作记录。
 * 明确不包含：Cookie、Token、ssfn、API Key、密码、任何凭据文件内容。
 */

const fs = require('fs');
const { app, dialog, shell } = require('electron');
const store = require('./store');
const logger = require('./logger');

const SECRET_KEYS = new Set(['apiKey', 'steamApiKey', 'password', 'token', 'ssfn']);

function redactSettings() {
  const s = store.getSettings();
  const out = {};
  for (const [k, v] of Object.entries(s || {})) {
    if (SECRET_KEYS.has(k)) {
      out[k] = v ? '（已隐藏）' : '';
      continue;
    }
    // appNames 是几百条游戏名的缓存，对排查没用，只记条数
    if (k === 'appNames') {
      out.appNames = `（${Object.keys(v || {}).length} 条缓存，已省略）`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {{ uiLogs?: string[] }} [payload] 渲染层最近的操作记录
 */
async function exportBundle(win, payload = {}) {
  const uiLogs = Array.isArray(payload.uiLogs) ? payload.uiLogs : [];
  const head = [
    'SteamDesk 诊断包',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `版本：${app.getVersion()}`,
    `系统：${process.platform} ${process.arch} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
    `用户数据目录：${app.getPath('userData')}`,
    '',
    '== 设置（已脱敏）==',
    JSON.stringify(redactSettings(), null, 2),
    '',
    '== 界面最近操作 ==',
    uiLogs.length ? uiLogs.join('\n') : '(无)',
    '',
    '== 运行日志 ==',
    logger.tail(3) || '(无)',
    '',
  ].join('\n');

  const res = await dialog.showSaveDialog(win, {
    title: '导出诊断包',
    defaultPath: `SteamDesk-diagnostic-${stamp()}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, head, 'utf8');
  logger.info('导出诊断包', { path: res.filePath });
  return { ok: true, path: res.filePath };
}

async function openLogs() {
  const dir = logger.dir;
  if (!dir) throw new Error('日志目录还没初始化');
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return { ok: true, dir };
}

module.exports = { exportBundle, openLogs };
