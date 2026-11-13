'use strict';

/**
 * electron-builder 的 afterPack 钩子：给打包出来的 exe 写入图标与版本信息。
 *
 * 为什么不用 electron-builder 自带的图标/版本写入？
 * 它在 Windows 上依赖 winCodeSign 压缩包，包里的 darwin/*.dylib 是符号链接，
 * 非管理员/未开启开发者模式的机器解压会直接失败（Cannot create symbolic link），
 * 所以 build.win.signAndEditExecutable 一直是 false，导致 exe 始终是 Electron 原子图标。
 * 这里改用 winCodeSign 里自带的 rcedit（tools/rcedit-x64.exe）在打包后自己写，
 * 既不依赖解压整个包，也不需要签名证书。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exe = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(exe)) {
    console.warn('[afterPack] 未找到主程序，跳过图标写入:', exe);
    return;
  }

  const root = path.join(__dirname, '..');
  const rcedit = path.join(root, 'tools', 'rcedit-x64.exe');
  const ico = path.join(root, 'icon.ico');
  if (!fs.existsSync(rcedit) || !fs.existsSync(ico)) {
    console.warn('[afterPack] 缺少 rcedit 或 icon.ico，跳过图标写入');
    return;
  }

  const version = context.packager.appInfo.version;
  const args = [
    exe,
    '--set-icon', ico,
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', 'SteamDesk',
    '--set-version-string', 'FileDescription', 'SteamDesk - Steam 库存与挂单工具',
    '--set-version-string', 'CompanyName', 'SteamDesk',
    '--set-version-string', 'LegalCopyright', 'SteamDesk',
    '--set-version-string', 'OriginalFilename', exeName,
    '--set-version-string', 'InternalName', 'SteamDesk',
  ];

  try {
    execFileSync(rcedit, args, { stdio: 'inherit' });
    console.log('[afterPack] 已写入图标与版本信息:', exeName);
  } catch (err) {
    // 写图标失败不应让整个打包失败，否则用户连安装包都拿不到
    console.warn('[afterPack] 写入图标失败:', err.message);
  }
};
