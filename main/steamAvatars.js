'use strict';

/**
 * 本地账号头像
 *
 * Steam 客户端会把每个登录过账号的头像缓存到：
 *   <Steam>/config/avatarcache/<SteamID64>.png
 * 直接读这份缓存最稳：不用联网、不受头像 CDN 被墙影响，Steam 里换了头像这里也会跟着变。
 *
 * 没有缓存文件时返回空字符串，界面继续显示昵称首字，不会留一个破图。
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const store = require('./store');

// 命中缓存：steamId -> dataURL；没有文件的不缓存，下次还能再找
const hit = new Map();

function avatarFile(steamId) {
  const cfg = paths.configDir(store.getSettings().steamPath);
  if (!cfg) return '';
  const file = path.join(cfg, 'avatarcache', `${String(steamId).replace(/[^\d]/g, '')}.png`);
  return fs.existsSync(file) ? file : '';
}

/**
 * @param {string[]} steamIds
 * @returns {Record<string,string>} steamId -> data:image/png;base64,…（没有就空串）
 */
function forIds(steamIds) {
  const out = {};
  for (const raw of Array.isArray(steamIds) ? steamIds : []) {
    const id = String(raw || '').replace(/[^\d]/g, '');
    if (!id) continue;
    if (hit.has(id)) {
      out[id] = hit.get(id);
      continue;
    }
    out[id] = '';
    const file = avatarFile(id);
    if (!file) continue;
    try {
      const buf = fs.readFileSync(file);
      if (!buf.length || buf.length > 1500000) continue;
      const url = `data:image/png;base64,${buf.toString('base64')}`;
      hit.set(id, url);
      out[id] = url;
    } catch {
      /* 读不到就保持首字兜底 */
    }
  }
  return out;
}

/** Steam 里换了头像 / 新登录账号后，手动刷新用 */
function clearCache() {
  hit.clear();
}

module.exports = { forIds, clearCache };
