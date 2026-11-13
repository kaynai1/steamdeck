'use strict';

/**
 * 配置与数据备份 / 恢复
 *
 * 换电脑或重装时，最肉疼的是成本库和提醒设置。这里把「可以安全搬运」的文件
 * 打成一个 JSON：设置、成本、阶梯降价/守价/补货状态、风控计数、库存监控、报表、错误与通知记录。
 *
 * 不包含：
 *   - secrets.bin（加密的 Token / Webhook，换机器也解不开，没必要带）；
 *   - archive/ 成交与行情归档（可能很大，需要的话单独导出 CSV）；
 *   - Steam 登录凭据（本来就不落盘到可搬运的位置）。
 *
 * 恢复前会先把现有文件另存到 backup-before-restore-<时间>/，恢复完成后自动重启，
 * 因为大部分模块在启动时只读一次文件。
 */

const fs = require('fs');
const path = require('path');
const { app, dialog, BrowserWindow } = require('electron');
const store = require('./store');
const logger = require('./logger');

const FILES = [
  'costs.json',
  'ladder.json',
  'restock.json',
  'priceguard.json',
  'risk-count.json',
  'inv-watch.json',
  'reports.json',
  'errors.json',
  'notices.json',
];

let root = null;

function init(baseDir) {
  root = baseDir || null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function parentWin() {
  try {
    return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  } catch {
    return null;
  }
}

function counts(bundle) {
  const files = (bundle && bundle.files) || {};
  const costs = files['costs.json'] || {};
  let costRows = 0;
  for (const acc of Object.values(costs)) {
    if (acc && typeof acc === 'object') costRows += Object.keys(acc).length;
  }
  const alerts = ((bundle && bundle.settings && bundle.settings.priceAlerts) || []).length;
  return { costRows, alerts, files: Object.keys(files).length };
}

async function exportBundle() {
  if (!root) throw Object.assign(new Error('数据目录未初始化'), { code: 'E_NOT_READY' });
  const win = parentWin();
  const res = await dialog.showSaveDialog(win || undefined, {
    title: '导出 SteamDesk 备份',
    defaultPath: path.join(app.getPath('documents'), `steamdesk-backup-${stamp()}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };

  const files = {};
  for (const name of FILES) {
    const data = readJson(path.join(root, name));
    if (data !== null) files[name] = data;
  }
  // 接口 Key 不写进备份文件：备份可能被复制到别处，丢失或泄露都不划算
  const settings = { ...store.getSettings() };
  delete settings.steamApiKey;
  delete settings.aiApiKey;
  const bundle = {
    app: 'SteamDesk',
    version: app.getVersion(),
    exportedAt: Date.now(),
    settings,
    files,
  };
  writeJson(res.filePath, bundle);
  const bytes = fs.statSync(res.filePath).size;
  logger.info('导出备份', { path: res.filePath, bytes });
  return { canceled: false, path: res.filePath, bytes, ...counts(bundle) };
}

async function importBundle() {
  if (!root) throw Object.assign(new Error('数据目录未初始化'), { code: 'E_NOT_READY' });
  const win = parentWin();
  const pick = await dialog.showOpenDialog(win || undefined, {
    title: '选择 SteamDesk 备份文件',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { canceled: true };

  const file = pick.filePaths[0];
  let bundle = null;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw Object.assign(new Error('这个文件不是有效的 JSON 备份'), { code: 'E_BAD_BACKUP' });
  }
  if (!bundle || bundle.app !== 'SteamDesk' || typeof bundle !== 'object') {
    throw Object.assign(new Error('不是 SteamDesk 的备份文件'), { code: 'E_BAD_BACKUP' });
  }
  if (!bundle.settings || typeof bundle.settings !== 'object') {
    throw Object.assign(new Error('备份里没有设置数据'), { code: 'E_BAD_BACKUP' });
  }
  const files = bundle.files && typeof bundle.files === 'object' ? bundle.files : {};
  for (const key of Object.keys(files)) {
    if (!FILES.includes(key)) delete files[key];
  }

  const c = counts(bundle);
  const when = bundle.exportedAt ? new Date(Number(bundle.exportedAt)).toLocaleString('zh-CN') : '未知时间';
  const confirm = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    buttons: ['取消', '恢复并重启'],
    defaultId: 0,
    cancelId: 0,
    title: '确认恢复备份',
    message: `备份来自 ${when}（v${bundle.version || '?'}）`,
    detail:
      `包含：设置、成本 ${c.costRows} 条、价格提醒 ${c.alerts} 条、${c.files} 个数据文件。\n` +
      '恢复会覆盖当前这些数据，软件随后自动重启。现有数据会先另存到 backup-before-restore 目录。',
  });
  if (confirm.response !== 1) return { canceled: true };

  // 先备份当前文件，恢复错了还能找回来
  const keepDir = path.join(root, `backup-before-restore-${stamp()}`);
  try {
    fs.mkdirSync(keepDir, { recursive: true });
    for (const name of [...FILES, 'settings.json']) {
      const src = path.join(root, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(keepDir, name));
    }
  } catch (err) {
    logger.warn('恢复前备份失败', { message: err && err.message });
  }

  // 恢复时保留本机现有的接口 Key，避免用别人的备份把 Key 清空
  const current = store.getSettings();
  const restored = { ...bundle.settings };
  restored.steamApiKey = current.steamApiKey || '';
  restored.aiApiKey = current.aiApiKey || '';
  store.setSettings(restored);
  let written = 0;
  for (const name of Object.keys(files)) {
    const data = files[name];
    if (data === null || typeof data !== 'object') continue;
    writeJson(path.join(root, name), data);
    written++;
  }
  logger.info('恢复备份完成', { from: file, files: written, keptAt: keepDir });

  // 大部分模块启动时只读一次文件，重启后新数据才全部生效
  setTimeout(() => {
    try {
      app.relaunch();
      app.exit(0);
    } catch {
      /* 重启失败也不影响已写入的数据 */
    }
  }, 1200);

  return {
    canceled: false,
    restoreFrom: file,
    keptAt: keepDir,
    files: written,
    costRows: c.costRows,
    alerts: c.alerts,
    restarting: true,
  };
}

module.exports = { init, exportBundle, importBundle };
