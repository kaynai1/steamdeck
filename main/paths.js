'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const WIN_DEFAULT = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\Steam',
];
const MAC_DEFAULT = [
  path.join(os.homedir(), 'Library/Application Support/Steam'),
];
const LINUX_DEFAULT = [
  path.join(os.homedir(), '.steam/steam'),
  path.join(os.homedir(), '.local/share/Steam'),
];

function isValidSteamDir(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, 'steam.exe')) ||
      fs.existsSync(path.join(dir, 'steam.sh')) ||
      fs.existsSync(path.join(dir, 'config')) ||
      fs.existsSync(path.join(dir, 'steamapps'))
    );
  } catch {
    return false;
  }
}

/** 从 Windows 注册表兜底拿安装路径 */
function fromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath',
    ], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) return m[1].trim().replace(/\//g, '\\');
  } catch {
    /* 忽略：注册表键不存在 */
  }
  return null;
}

function detectSteamPath() {
  const candidates = [];
  const reg = fromRegistry();
  if (reg) candidates.push(reg);
  if (process.platform === 'win32') candidates.push(...WIN_DEFAULT);
  else if (process.platform === 'darwin') candidates.push(...MAC_DEFAULT);
  else candidates.push(...LINUX_DEFAULT);

  for (const dir of candidates) {
    if (isValidSteamDir(dir)) return dir;
  }
  return null;
}

/** config/ 目录，loginusers.vdf / config.vdf / ssfn* 都在这里 */
function configDir(steamPath) {
  const root = steamPath || detectSteamPath();
  if (!root) return null;
  const c = path.join(root, 'config');
  return fs.existsSync(c) ? c : null;
}

function userdataDir(steamPath) {
  const root = steamPath || detectSteamPath();
  if (!root) return null;
  const u = path.join(root, 'userdata');
  return fs.existsSync(u) ? u : null;
}

/** 解析 libraryfolders.vdf 拿到所有库目录 */
function libraryFolders(steamPath, vdf) {
  const root = steamPath || detectSteamPath();
  const out = [];
  if (!root) return out;
  const file = path.join(root, 'steamapps', 'libraryfolders.vdf');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = vdf.parse(raw);
    const libs = data.libraryfolders || {};
    if (Array.isArray(libs)) {
      libs.forEach((l) => l && l.path && out.push(l.path));
    } else {
      for (const [k, v] of Object.entries(libs)) {
        if (/^\d+$/.test(k) && v && v.path) out.push(v.path);
        else if (/^\d+$/.test(k) && typeof v === 'string') out.push(v);
      }
    }
  } catch {
    /* 文件不存在时回退到默认 steamapps */
    const fallback = path.join(root, 'steamapps');
    if (fs.existsSync(fallback)) out.push(root);
  }
  return [...new Set(out)];
}

module.exports = {
  detectSteamPath,
  isValidSteamDir,
  configDir,
  userdataDir,
  libraryFolders,
};
