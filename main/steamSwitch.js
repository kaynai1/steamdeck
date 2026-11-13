'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { spawn } = require('child_process');
const vdf = require('./vdf');
const paths = require('./paths');
const store = require('./store');

const emitter = new EventEmitter();
let switching = false;
let lastStatus = { state: 'idle', message: '', at: Date.now(), account: null };

function push(patch) {
  lastStatus = { ...lastStatus, ...patch, at: Date.now() };
  emitter.emit('status', lastStatus);
  return lastStatus;
}

function getStatus() {
  return lastStatus;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, ...opts }, (err, stdout) => {
      resolve({ err, stdout: stdout || '' });
    });
  });
}

/** 判断 Steam 进程是否在运行 */
async function isSteamRunning() {
  if (process.platform === 'win32') {
    const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']);
    return /steam\.exe/i.test(stdout);
  }
  if (process.platform === 'darwin') {
    const { stdout } = await exec('pgrep', ['-x', 'steam_osx']);
    return stdout.trim().length > 0;
  }
  const { stdout } = await exec('pgrep', ['-x', 'steam']);
  return stdout.trim().length > 0;
}

/** 关闭 Steam（先软后硬） */
async function killSteam() {
  push({ state: 'closing', message: '正在关闭 Steam 客户端' });

  if (process.platform === 'win32') {
    await exec('taskkill', ['/IM', 'steam.exe']);
    // steamwebhelper 是子进程，慢一步才会退出
    await sleep(1200);
    if (await isSteamRunning()) {
      await exec('taskkill', ['/F', '/IM', 'steam.exe']);
    }
    await exec('taskkill', ['/F', '/IM', 'steamwebhelper.exe']);
  } else if (process.platform === 'darwin') {
    await exec('osascript', ['-e', 'tell application "Steam" to quit']);
    await sleep(1500);
    if (await isSteamRunning()) {
      const { err, stdout } = await exec('pgrep', ['-x', 'steam_osx']);
      if (stdout.trim()) await exec('kill', [stdout.trim()]);
    }
  } else {
    await exec('pkill', ['-x', 'steam']);
    await sleep(1000);
    await exec('pkill', ['-9', '-x', 'steam']);
  }

  for (let i = 0; i < 15; i++) {
    if (!(await isSteamRunning())) return true;
    await sleep(400);
  }
  return !(await isSteamRunning());
}

/** 拉起 Steam */
function launchSteam(steamPath) {
  const root = steamPath || paths.detectSteamPath();
  if (!root) throw Object.assign(new Error('未找到 Steam 安装目录'), { code: 'E_NO_STEAM_PATH' });

  if (process.platform === 'win32') {
    const exe = path.join(root, 'steam.exe');
    if (!fs.existsSync(exe)) throw Object.assign(new Error(`找不到 ${exe}`), { code: 'E_NO_EXE' });
    // detached + unref，避免 Steam 跟着本应用退出
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return exe;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', ['-a', 'Steam'], { detached: true, stdio: 'ignore' });
    child.unref();
    return 'Steam.app';
  }
  const sh = path.join(root, 'steam.sh');
  const child = spawn(sh, [], { detached: true, stdio: 'ignore' });
  child.unref();
  return sh;
}

/**
 * 写入 config.vdf 的 AutoLoginUser。
 * 这是切号的核心：Steam 启动时读这个字段决定登谁，
 * 配合已存在的 SSFN 凭证即可免密登录。
 */
function writeAutoLoginUser(cfgDir, accountName) {
  const file = path.join(cfgDir, 'config.vdf');
  const raw = fs.readFileSync(file, 'utf8');

  // 保留一份备份，异常时可回滚
  const backup = `${file}.steamdesk.bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, 'utf8');

  const data = vdf.parse(raw);
  const tree = data.InstallConfigStore || {};
  if (!tree.Software) tree.Software = {};
  if (!tree.Software.Valve) tree.Software.Valve = {};
  if (!tree.Software.Valve.Steam) tree.Software.Valve.Steam = {};

  const before = tree.Software.Valve.Steam.AutoLoginUser;
  tree.Software.Valve.Steam.AutoLoginUser = accountName;

  // 同步把对应账号标记为 MostRecent，与 Steam 自身行为一致
  data.InstallConfigStore = tree;

  const out = vdf.stringify(data);
  fs.writeFileSync(file, out, 'utf8');
  return { before, after: accountName, backup };
}

/** 修改 loginusers.vdf 里各账号的 MostRecent 标记 */
function markMostRecent(cfgDir, steamId) {
  const file = path.join(cfgDir, 'loginusers.vdf');
  if (!fs.existsSync(file)) return false;
  const data = vdf.parse(fs.readFileSync(file, 'utf8'));
  const root = data.users || data.Users;
  if (!root) return false;
  let changed = false;
  for (const [id, info] of Object.entries(root)) {
    if (!info || typeof info !== 'object') continue;
    const shouldBe = id === steamId ? '1' : '0';
    if (String(info.MostRecent) !== shouldBe) {
      info.MostRecent = shouldBe;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, vdf.stringify(data), 'utf8');
  return changed;
}

/**
 * 执行账号切换。
 * 完整链路：校验 → 关 Steam → 改 AutoLoginUser → 改 MostRecent → 启 Steam → 等登录
 */
async function switchAccount(target) {
  if (switching) {
    throw Object.assign(new Error('上一次切换还在进行中，请稍候'), { code: 'E_BUSY' });
  }
  switching = true;
  const started = Date.now();

  try {
    const settings = store.getSettings();
    const cfg = paths.configDir(settings.steamPath);
    if (!cfg) throw Object.assign(new Error('未找到 Steam 配置目录'), { code: 'E_NO_CONFIG' });

    const accounts = require('./steamAccounts');
    const scan = accounts.scanAccounts();
    const user = scan.users.find(
      (u) => u.steamId === target || u.accountName === target || u.personaName === target
    );
    if (!user) {
      throw Object.assign(new Error(`本机没有找到账号「${target}」的登录记录`), { code: 'E_NO_ACCOUNT' });
    }
    if (!user.allowAutoLogin) {
      throw Object.assign(
        new Error('该账号未开启"记住登录状态"。请先在 Steam 客户端手动登录一次并勾选记住密码，之后才能免密切换。'),
        { code: 'E_NO_AUTOLOGIN' }
      );
    }

    push({ state: 'preparing', message: `准备切换到 ${user.personaName}`, account: user });

    if (settings.closeSteamBeforeSwitch) {
      const running = await isSteamRunning();
      if (running) {
        const closed = await killSteam();
        if (!closed) {
          throw Object.assign(new Error('Steam 未能关闭，请手动退出后重试'), { code: 'E_KILL_FAILED' });
        }
      } else {
        push({ state: 'closing', message: 'Steam 未在运行，跳过关闭步骤' });
      }
    }

    push({ state: 'writing', message: '正在写入登录配置' });
    const res = writeAutoLoginUser(cfg, user.accountName);
    markMostRecent(cfg, user.steamId);

    push({ state: 'launching', message: '正在启动 Steam' });
    const exe = launchSteam(settings.steamPath);

    push({ state: 'waiting', message: '等待 Steam 登录完成' });
    const ok = await waitForLogin(cfg, user.accountName, 45000);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (!ok) {
      return push({
        state: 'timeout',
        message: `已写入配置并启动 Steam，但 ${elapsed}s 内未确认登录完成。可能是网络较慢，或该账号需要验证码。`,
        account: user,
        elapsed,
        exe,
        previousAutoLogin: res.before,
      });
    }

    return push({
      state: 'done',
      message: `已切换到 ${user.personaName}，耗时 ${elapsed}s`,
      account: user,
      elapsed,
      exe,
      previousAutoLogin: res.before,
    });
  } catch (err) {
    return push({ state: 'error', message: err.message, code: err.code || 'E_UNKNOWN' });
  } finally {
    switching = false;
  }
}

/** 轮询 config.vdf，确认 Steam 已按目标账号生效 */
async function waitForLogin(cfgDir, accountName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const file = path.join(cfgDir, 'loginusers.vdf');
      const data = vdf.parse(fs.readFileSync(file, 'utf8'));
      const root = data.users || data.Users || {};
      for (const info of Object.values(root)) {
        if (!info || typeof info !== 'object') continue;
        if (info.AccountName === accountName && String(info.MostRecent) === '1') {
          // MostRecent 变了说明 Steam 已经接手并更新了登录状态
          const ts = Number(info.Timestamp) || 0;
          if (ts && Date.now() / 1000 - ts < 300) return true;
        }
      }
    } catch {
      /* 文件可能正被 Steam 写入，忽略并重试 */
    }
  }
  return false;
}

module.exports = { switchAccount, getStatus, isSteamRunning, killSteam, launchSteam, on: emitter.on.bind(emitter) };
