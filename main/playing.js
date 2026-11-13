'use strict';

/**
 * 正在玩的游戏
 *
 * Steam 客户端运行游戏时会把 appid 写进注册表：
 *   HKCU\Software\Valve\Steam\RunningAppID  (REG_DWORD)
 * 游戏退出后写成 0。这里只读注册表，不碰 Steam 进程，也不发网络请求。
 * 读不到（非 Windows、Steam 没开、权限受限）就返回 0，调用方按"没有在玩"处理。
 */

const { execFile } = require('child_process');

const TTL = 8 * 1000;
let cache = { at: 0, appId: 0 };

function readRegistry() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(0);
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(0);
        const dw = /RunningAppID\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout);
        if (dw) return resolve(parseInt(dw[1], 16) || 0);
        const sz = /RunningAppID\s+REG_SZ\s+(\d+)/.exec(stdout);
        resolve(sz ? Number(sz[1]) || 0 : 0);
      }
    );
  });
}

/** @returns {Promise<{appId:number, at:number}>} */
async function current() {
  if (cache.at && Date.now() - cache.at < TTL) return { appId: cache.appId, at: cache.at };
  const appId = await readRegistry().catch(() => 0);
  cache = { at: Date.now(), appId };
  return { appId, at: cache.at };
}

module.exports = { current };
