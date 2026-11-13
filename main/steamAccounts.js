'use strict';

const fs = require('fs');
const path = require('path');
const vdf = require('./vdf');
const paths = require('./paths');
const store = require('./store');

/**
 * 读取 loginusers.vdf，拿到这台机器上登录过的所有账号。
 * 字段含义：
 *   PersonaName  显示昵称
 *   AccountName  登录名
 *   Timestamp    上次登录时间（unix 秒）
 *   MostRecent   "1" 表示最后一次登录的账号
 *   RememberPassword 是否记住密码
 *   AllowAutoLogin   是否允许自动登录（切号能生效的前提）
 */
function scanAccounts() {
  const settings = store.getSettings();
  const cfg = paths.configDir(settings.steamPath);
  if (!cfg) {
    return {
      steamPath: null,
      configFound: false,
      users: [],
      warning: '没有找到 Steam 安装目录。可能未安装 Steam，或安装位置非默认，请在设置中手动指定。',
    };
  }

  const file = path.join(cfg, 'loginusers.vdf');
  if (!fs.existsSync(file)) {
    return {
      steamPath: settings.steamPath || paths.detectSteamPath(),
      configFound: true,
      users: [],
      warning: '尚未发现已登录的账号记录（loginusers.vdf 不存在）。请先手动用 Steam 客户端登录一次。',
    };
  }

  let data;
  try {
    data = vdf.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      steamPath: settings.steamPath,
      configFound: true,
      users: [],
      warning: `loginusers.vdf 解析失败：${err.message}`,
    };
  }

  const usersRoot = data.users || data.Users || {};
  const users = [];

  // ssfn 文件只需读一次，供所有账号匹配
  const ssfnHeads = readSsfnHeads(cfg);
  const activeId = readAutoLoginUser(cfg);

  for (const [steamId, info] of Object.entries(usersRoot)) {
    if (!info || typeof info !== 'object') continue;
    // 不同 Steam 版本大小写不一致：曾经只认 Timestamp，结果所有账号都显示「未知」
    const timestamp =
      Number(info.Timestamp || info.timestamp || info.LastLogin || info.lastlogin) ||
      userdataTime(cfg, steamId);
    const accountName = info.AccountName || info.accountname || '';
    const matched = matchSsfn(ssfnHeads, accountName, steamId);
    users.push({
      steamId,
      accountName,
      personaName: info.PersonaName || info.personaname || accountName || '未知账号',
      timestamp,
      lastLoginText: timestamp ? new Date(timestamp * 1000).toISOString() : null,
      // 有些版本的 loginusers.vdf 不写 MostRecent，用 config.vdf 里的自动登录账号补
      mostRecent: String(info.MostRecent || info.mostrecent) === '1' || steamId === activeId,
      rememberPassword: String(info.RememberPassword || info.rememberpassword) === '1',
      // 旧版本写成 AllowAutoLogin，新版本是 AutoLogin；之前只认前者，导致所有号都显示「需手动登录」
      allowAutoLogin: String(info.AllowAutoLogin || info.AutoLogin || info.allowautologin) === '1',
      ssfnFiles: matched,
      // 本机有 ssfn 文件但一个都没匹配上：归属未知，不能当作"齐全"
      ssfnTotal: ssfnHeads.length,
      ssfnUncertain: matched.length === 0 && ssfnHeads.length > 0,
    });
  }

  users.sort((a, b) => {
    if (a.mostRecent !== b.mostRecent) return a.mostRecent ? -1 : 1;
    return b.timestamp - a.timestamp;
  });

  return {
    steamPath: settings.steamPath || paths.detectSteamPath(),
    configFound: true,
    users,
    autoLoginUser: activeId,
    warning: users.length ? null : 'loginusers.vdf 里没有任何账号记录。',
  };
}

/**
 * 最近登录时间的兜底：loginusers.vdf 里没有时间戳时，
 * 用 <Steam>/userdata/<账号ID>/ 目录的最后修改时间近似。
 */
function userdataTime(cfgDir, steamId) {
  try {
    const root = path.dirname(cfgDir);
    const id32 = String(BigInt(steamId) - 76561197960265728n);
    const dir = path.join(root, 'userdata', id32);
    if (!fs.existsSync(dir)) return 0;
    return Math.floor(fs.statSync(dir).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

/** 读取 config.vdf 里当前配置的自动登录账号 */
function readAutoLoginUser(cfgDir) {
  const file = path.join(cfgDir, 'config.vdf');
  try {
    const data = vdf.parse(fs.readFileSync(file, 'utf8'));
    const root = data.InstallConfigStore || {};
    const software = root.Software || {};
    const valve = software.Valve || {};
    const steam = valve.Steam || {};
    return steam.AutoLoginUser || null;
  } catch {
    return null;
  }
}

/**
 * SSFN 凭证文件与账号的对应关系。
 *
 * ★ 这里曾经有一个"善意的谎" ★
 * 老版本 findSsfn(cfgDir, steamId) 收了 steamId 却没用，直接返回 config/ 下
 * 所有 ssfn 文件名。只要有任意一个 ssfn 文件，**每个**账号的 ssfnFiles 都非空，
 * 而 checkSwitchable() 正是靠 ssfnFiles.length 判断可切换性 ——
 * 于是界面上每个账号都写着"SSFN 凭证齐全 · 可免验证码切换"，
 * 实际上该账号可能根本没有凭证，切过去就会弹验证码。
 *
 * 文件名与账号的映射确实没有官方文档，但 SSFN 文件头里以明文存着账号名。
 * 所以这里改成**在文件字节里按账号名做子串匹配**：
 *   命中   → 确定属于该账号
 *   未命中 → 归属未知，报"未确认"，绝不声称齐全
 */
const SSFN_HEAD_BYTES = 1024;

/** 读 config/ 下所有 ssfn 文件的前 1KB */
function readSsfnHeads(cfgDir) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(cfgDir).filter((f) => /^ssfn/i.test(f));
  } catch {
    return out;
  }
  for (const name of files) {
    try {
      const fd = fs.openSync(path.join(cfgDir, name), 'r');
      const buf = Buffer.alloc(SSFN_HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, SSFN_HEAD_BYTES, 0);
      fs.closeSync(fd);
      // SSFN 是二进制；用 latin1 读可保证"1 字符 = 1 字节"，便于做子串匹配
      out.push({ name, head: buf.subarray(0, read).toString('latin1') });
    } catch {
      /* 单个文件读不到就跳过，不影响其它账号 */
    }
  }
  return out;
}

/** 找出确定属于该账号的 ssfn 文件 */
function matchSsfn(heads, accountName, steamId) {
  const keys = [accountName, steamId].filter(Boolean);
  if (!keys.length) return [];
  return heads.filter((h) => keys.some((k) => h.head.includes(k))).map((h) => h.name);
}

/** 检查某个账号是否满足"可被自动切换"的条件 */
function checkSwitchable(user) {
  const issues = [];
  if (!user.allowAutoLogin) issues.push('该账号未开启"记住登录状态"，需先在 Steam 客户端勾选记住密码');
  if (!user.ssfnFiles || user.ssfnFiles.length === 0) {
    issues.push(
      user.ssfnUncertain
        ? `未找到属于该账号的 SSFN 凭证（本机有 ${user.ssfnTotal} 个 ssfn 文件，但都没匹配到这个账号名）`
        : '未找到 SSFN 凭证文件，可能需要在客户端重新登录一次以生成凭证'
    );
  }
  return { ok: issues.length === 0, issues };
}

module.exports = { scanAccounts, readAutoLoginUser, checkSwitchable };
