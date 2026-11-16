'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  safeStorage,
  dialog,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  screen,
} = require('electron');

// 关闭 GPU 合成：部分 Windows 机器 + 远程桌面/缩放场景下，
// 硬件合成会把中文小字号渲染成错位字形（用户看到的"字歪/看不适"）。
app.disableHardwareAcceleration();
const path = require('path');
const fs = require('fs');

const store = require('./main/store');
const paths = require('./main/paths');
const accounts = require('./main/steamAccounts');
const switcher = require('./main/steamSwitch');
const library = require('./main/steamLibrary');
const session = require('./main/session');
const bridge = require('./main/steamBridge');
const inventory = require('./main/inventory');
const market = require('./main/market');
const seller = require('./main/seller');
const license = require('./main/license');
const imageProxy = require('./main/imageProxy');
const storeSearch = require('./main/storeSearch');
const guard = require('./main/steamGuard');
const logger = require('./main/logger');
const errors = require('./main/errors');
const notify = require('./main/notify');
const updater = require('./main/updater');
const notices = require('./main/notices');
const backup = require('./main/backup');
const priceGuard = require('./main/priceGuard');
const sessionWatch = require('./main/sessionWatch');
const tradeWatch = require('./main/tradeWatch');
const saleWatch = require('./main/saleWatch');
const dropWatch = require('./main/dropWatch');
const priceHistory = require('./main/priceHistory');
const storeWatch = require('./main/storeWatch');
const ai = require('./main/ai');
const ingest = require('./main/ingest');

// 主进程兜底：至少把原因写进日志，别让软件毫无痕迹地消失
let fatalLogged = 0;
process.on('uncaughtException', (err) => {
  if (fatalLogged >= 5) return;
  fatalLogged++;
  try {
    logger.error('未捕获异常', {
      message: err && err.message,
      stack: String((err && err.stack) || '').slice(0, 1500),
    });
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason && reason.message ? reason.message : String(reason);
    logger.warn('未处理的 Promise 拒绝', { message: msg });
  } catch { /* ignore */ }
});

let win = null;
let tray = null;
let quitting = false;
let trayHinted = false;
const isDev = process.argv.includes('--dev');

// 自定义图片协议必须在 app ready 之前注册，否则 registerSchemesAsPrivileged 无效
imageProxy.registerScheme();

/**
 * 取应用图标路径：
 * Windows 下 .ico 内嵌了 16/24/32/48/64/128/256 多尺寸，
 * 任务栏和托盘都能自动选到最合适的一档，比单独缩放 PNG 清晰得多。
 * 开发环境若还没生成 .ico，就退回 .png。
 */
function iconPath() {
  const ico = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  return path.join(__dirname, 'icon.png');
}

/** 打开一个独立窗口（多窗口 / 分屏用），page 决定启动后切到哪一页 */
function openAppWindow(page) {
  const w = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    icon: iconPath(),
    backgroundColor: '#0B0F14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    const z = Number(store.getSettings().uiZoom) || 1.08;
    w.webContents.setZoomFactor(Math.min(1.6, Math.max(0.85, z)));
  } catch { /* ignore */ }
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: page ? { page: String(page) } : {},
  });
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => { /* 子窗口关掉不影响主窗口 */ });
  return w;
}

function createWindow() {
  // 记住上次的窗口位置和大小；屏幕分辨率变了导致越界时回落到默认尺寸
  const saved = store.getSettings().winBounds;
  let bounds = { width: 1480, height: 940 };
  if (saved && Number(saved.width) >= 1120 && Number(saved.height) >= 720) {
    // 换显示器或分辨率变化后，旧坐标可能落在屏幕外：至少要有 100×80 的面积可见
    let visible = false;
    try {
      visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return (
          Number(saved.x) < a.x + a.width - 100 &&
          Number(saved.x) + Number(saved.width) > a.x + 100 &&
          Number(saved.y) < a.y + a.height - 80 &&
          Number(saved.y) + Number(saved.height) > a.y + 80
        );
      });
    } catch {
      visible = true;
    }
    if (visible) {
      bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    }
  }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    icon: iconPath(),
    backgroundColor: '#0B0F14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 应用记住的界面缩放（用户反馈"界面太小看不清"，默认给到 1.08）
  // 注意：变量名是 win。这里曾误写成 mainWindow，ReferenceError 被下面的
  // 空 catch 吞掉，表现为"设置里调好的缩放重启后丢失"。
  try {
    const z = Number(store.getSettings().uiZoom) || 1.08;
    win.webContents.setZoomFactor(Math.min(1.6, Math.max(0.85, z)));
  } catch { /* ignore */ }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染进程崩溃/白屏时自动重载一次，避免用户只看到一个死窗口
  let lastReloadAt = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('渲染进程退出', { reason: details && details.reason, exitCode: details && details.exitCode });
    if (quitting || !win || win.isDestroyed()) return;
    if (Date.now() - lastReloadAt < 30000) return;
    lastReloadAt = Date.now();
    try {
      win.reload();
    } catch { /* ignore */ }
  });
  win.webContents.on('unresponsive', () => {
    logger.warn('窗口无响应');
  });

  win.once('ready-to-show', () => {
    win.show();
    if (saved && saved.maximized) {
      try {
        win.maximize();
      } catch { /* ignore */ }
    }
  });

  // 记住窗口位置/大小（防抖，避免拖动时频繁写盘）
  let boundsTimer = null;
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getNormalBounds();
      store.setSettings({
        winBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() },
      });
    } catch { /* ignore */ }
  };
  const scheduleBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 700);
  };
  win.on('resize', scheduleBounds);
  win.on('move', scheduleBounds);
  win.on('close', saveBounds);
  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    // 把渲染层的报错转发到终端，避免"界面白屏但控制台什么都没说"
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.error('[renderer]', message, `${sourceId}:${line}`);
    });
  }

  // 外链一律走系统浏览器，禁止在应用内跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭按钮 → 隐藏到系统托盘；真正退出走托盘菜单或 before-quit
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHinted) {
      trayHinted = true;
      try {
        win.webContents.send('app:trayHint');
      } catch { /* ignore */ }
    }
  });

  win.on('closed', () => { win = null; });
}

/** 显示主窗口（可从托盘点击或菜单进入指定页面） */
function showMainWindow(page) {
  if (!win || win.isDestroyed()) {
    createWindow();
  }
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (page) {
    try {
      win.webContents.send('nav:goto', page);
    } catch { /* ignore */ }
  }
}

/** 托盘菜单要在「提醒开关」变化后重建，所以单独抽出来 */
function refreshTrayMenu() {
  if (!tray) return;
  const notifyOn = store.getSettings().freeNotify !== false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 SteamDesk', click: () => showMainWindow() },
      { label: '免费游戏领取', click: () => showMainWindow('free') },
      { label: '我的市场挂单', click: () => showMainWindow('orders') },
      { label: '饰品仓库', click: () => showMainWindow('inventory') },
      { type: 'separator' },
      {
        label: '免费游戏提醒',
        type: 'checkbox',
        checked: notifyOn,
        click: (item) => {
          store.setSettings({ freeNotify: !!item.checked });
          refreshTrayMenu();
        },
      },
      {
        label: '暂停所有自动任务',
        type: 'checkbox',
        checked: store.getSettings().automationPaused === true,
        click: (item) => {
          store.setSettings({ automationPaused: !!item.checked });
          try {
            if (win && !win.isDestroyed()) win.webContents.send('automation:changed', !!item.checked);
          } catch { /* ignore */ }
          refreshTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出 SteamDesk',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

/** 系统托盘：右键菜单可退出，左键单击唤起窗口 */
function createTray() {
  if (tray) return;
  try {
    let img = nativeImage.createFromPath(iconPath());
    if (img.isEmpty()) throw new Error('托盘图标加载失败');
    // 高 DPI 屏要 2x（32px）才不会糊，Windows 会按缩放自动挑
    img = img.resize({ width: 16, height: 16, quality: 'best' });
    img.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: nativeImage
        .createFromPath(iconPath())
        .resize({ width: 32, height: 32, quality: 'best' })
        .toPNG(),
    });
    tray = new Tray(img);
    tray.setToolTip('SteamDesk · 饰品行情与挂单');
    refreshTrayMenu();
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (err) {
    console.error('[tray] 创建失败', err);
  }
}

// 单实例：重复双击桌面图标时唤起已运行的窗口，而不是开第二个
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

app.on('before-quit', () => {
  quitting = true;
  try {
    require('./main/qqbot').stopGateway();
  } catch {
    /* 退出时清理失败不影响退出 */
  }
});

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  logger.init(app.getPath('userData'));
  require('./main/costs').init(app.getPath('userData'));
  require('./main/invWatch').init(app.getPath('userData'));
  require('./main/risk').init(app.getPath('userData'));
  require('./main/restock').init(app.getPath('userData'));
  require('./main/reports').init(app.getPath('userData'));
  require('./main/ladder').init(app.getPath('userData'));
  require('./main/archive').init(app.getPath('userData'));
  priceGuard.init(app.getPath('userData'));
  sessionWatch.init(app.getPath('userData'));
  tradeWatch.init(app.getPath('userData'));
  saleWatch.init(app.getPath('userData'));
  dropWatch.init(app.getPath('userData'));
  priceHistory.init(app.getPath('userData'));
  ingest.init(app.getPath('userData'));
  ingest.start();
  notices.init(app.getPath('userData'));
  backup.init(app.getPath('userData'));
  errors.init(app.getPath('userData'));
  logger.info('应用启动', { version: app.getVersion(), platform: process.platform });

  // Windows 的 Toast 通知要 AppUserModelID 对得上，否则点了没反应/不显示
  try {
    app.setAppUserModelId('com.steamdesk.app');
  } catch { /* 非 Windows 忽略 */ }

  // 挂上 sdimg:// 处理器：物品图标 / 游戏封面都经它多域名回退取字节流
  try {
    imageProxy.installHandler();
  } catch (err) {
    console.error('[imageProxy] install failed', err);
  }

  createWindow();
  createTray();
  require('./main/freeNotify').start({
    onOpen: () => showMainWindow('free'),
    icon: iconPath(),
  });
  require('./main/priceAlerts').start({
    onOpen: () => showMainWindow('inventory'),
    icon: iconPath(),
  });
  require('./main/invWatch').start({
    onOpen: () => showMainWindow('inventory'),
    icon: iconPath(),
  });
  require('./main/health').start({
    icon: iconPath(),
    onAlert: () => {
      showMainWindow('accounts');
      try {
        if (win && !win.isDestroyed()) win.webContents.send('health:alert');
      } catch { /* ignore */ }
    },
  });
  require('./main/restock').start({ icon: iconPath() });
  require('./main/reports').start({ icon: iconPath() });
  require('./main/ladder').start();
  priceGuard.start();
  sessionWatch.start({ icon: iconPath() });
  tradeWatch.start();
  saleWatch.start();
  dropWatch.start();
  priceHistory.start();
  storeWatch.start();
  notify.start({ icon: iconPath() });
  // QQ 机器人实时网关：凭据齐全时自动连接，用于接收私聊/群聊绑定消息
  try {
    const qqCfg = require('./main/qqbot').config();
    if (qqCfg.appId && qqCfg.secret) {
      require('./main/qqbot').startGateway().catch(() => {});
    }
  } catch { /* 未配置时跳过 */ }
  // 配置了更新源才检查，没配置就完全不联网
  setTimeout(() => updater.autoCheck(), 30 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // 有托盘时关闭窗口只隐藏，不退出；退出由托盘菜单触发
  if (!tray && process.platform !== 'darwin') app.quit();
});

/* ---------------------------------- 窗口 ---------------------------------- */

// 多窗口后必须按「发起请求的窗口」操作，否则子窗口的按钮会去最小化/关闭主窗口
const senderWin = (event) => (event && BrowserWindow.fromWebContents(event.sender)) || win;
ipcMain.on('win:minimize', (event) => {
  const w = senderWin(event);
  if (w) w.minimize();
});
ipcMain.on('win:maximize', (event) => {
  const w = senderWin(event);
  if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('win:close', (event) => {
  const w = senderWin(event);
  if (w) w.close();
});

/* --------------------------------- 通用工具 -------------------------------- */

const wrap = (fn) => async (event, ...args) => {
  try {
    const data = await fn(...args);
    return { ok: true, data };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const code = (err && err.code) || 'E_UNKNOWN';
    if (isDev) console.error('[ipc]', code, message);
    logger.error(`IPC 失败 ${code}: ${message}`, err && err.stack ? { stack: String(err.stack).slice(0, 1200) } : undefined);
    errors.record(code, message, 'ipc');
    return { ok: false, error: { code, message } };
  }
};

/**
 * 免费游戏领取结果 → 手机/QQ 推送。
 * 各平台 claim 返回结构不同，这里兼容三种形态，只统计“真正入库”的条目。
 */
function notifyClaimResult(platform, r) {
  try {
    if (!r) return;
    const titles = [];
    const collect = (results) => {
      for (const x of results || []) {
        if (x && x.ok && x.state !== 'owned' && x.title) titles.push(x.title);
      }
    };
    if (Array.isArray(r.accounts)) r.accounts.forEach((a) => collect(a.results));
    else if (Array.isArray(r.results)) collect(r.results);
    else if (r.ok && r.title) titles.push(r.title);
    if (!titles.length) return;
    const list = titles.slice(0, 4).map((t) => `《${t}》`).join('、');
    const more = titles.length > 4 ? ` 等 ${titles.length} 项` : '';
    notify.send(`免费游戏入库（${platform}）`, `${list}${more}已领取进库。`, {
      onClick: () => showMainWindow('free'),
    });
  } catch {
    /* 通知失败不影响领取流程 */
  }
}

/** 需要往渲染层推中间结果的处理器：把 sender 交给 fn，返回值仍走同样包装 */
const wrapEvent = (fn) => async (event, ...args) => {
  try {
    const data = await fn(event, ...args);
    return { ok: true, data };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const code = (err && err.code) || 'E_UNKNOWN';
    if (isDev) console.error('[ipc]', code, message);
    logger.error(`IPC 失败 ${code}: ${message}`, err && err.stack ? { stack: String(err.stack).slice(0, 1200) } : undefined);
    errors.record(code, message, 'ipc');
    return { ok: false, error: { code, message } };
  }
};

/* --------------------------------- 环境与配置 ------------------------------- */

ipcMain.handle('app:info', wrap(async () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  node: process.versions.node,
  userData: app.getPath('userData'),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
  steamPath: paths.detectSteamPath(),
  dev: isDev,
})));

ipcMain.handle('app:openExternal', wrap(async (url) => {
  if (!url || typeof url !== 'string') throw new Error('无效的 URL');
  if (!/^steam:\/\/|https?:\/\//i.test(url)) throw new Error('不允许打开此协议');
  await shell.openExternal(url);
  return true;
}));

ipcMain.handle('session:openMobileConf', wrap(async () => {
  session.openMobileConfWindow(win);
  return true;
}));

/* ------------------------------ 手机令牌确认 ------------------------------ */

ipcMain.handle('guard:status', wrap(async () => guard.status()));

// 导入 maFile：令牌里的 identity_secret 只在这里读一次，落盘前由 store 加密
ipcMain.handle('guard:import', wrap(async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入 Steam 手机令牌（maFile）',
    // SDA / steamguard-cli 都把 maFile 放在这个目录，直接定位过去省得用户找
    defaultPath: (() => {
      const d = path.join(app.getPath('appData'), 'Steam Desktop Authenticator', 'maFiles');
      return fs.existsSync(d) ? d : app.getPath('documents');
    })(),
    properties: ['openFile'],
    filters: [
      { name: 'maFile / JSON', extensions: ['maFile', 'mafile', 'json', 'txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return guard.linkFromFile(res.filePaths[0]);
}));

ipcMain.handle('guard:check', wrap(async () => guard.check()));

// 直接粘贴 maFile 的 JSON 内容（用户常常找不到导出的文件）
ipcMain.handle('guard:importText', wrap(async (text) => {
  if (!text || typeof text !== 'string' || text.length > 200000) {
    throw Object.assign(new Error('没有读到有效的 maFile 内容'), { code: 'E_BAD_MAFILE' });
  }
  return guard.link(text);
}));
ipcMain.handle('guard:unlink', wrap(async () => guard.unlink()));
ipcMain.handle('guard:confirm', wrap(async (opts) => guard.confirmMarketListings(opts || {})));

ipcMain.handle('settings:get', wrap(async () => store.getSettings()));
ipcMain.handle('settings:set', wrap(async (patch) => {
  const r = store.setSettings(patch);
  // 代理设置变化时立即应用到登录分区（登录窗口 / 库存 / 市场请求全部生效）
  if (patch && patch.loginProxy !== undefined) {
    require('./main/session').applyProxy().catch((e) => logger.warn('应用代理失败', { message: e && e.message }));
  }
  return r;
}));

ipcMain.handle('steam:choosePath', wrap(async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择 Steam 安装目录',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  store.setSettings({ steamPath: p });
  return p;
}));

/* ---------------------------------- 账号 ---------------------------------- */

ipcMain.handle('accounts:list', wrap(async () => accounts.scanAccounts()));
ipcMain.handle('accounts:switch', wrap(async (steamIdOrName) => switcher.switchAccount(steamIdOrName)));
ipcMain.handle('accounts:status', wrap(async () => switcher.getStatus()));
// 界面上点账号信息直接复制（走主进程剪贴板，file:// 页面里也能用）
ipcMain.handle('clip:write', wrap(async (text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return true;
}));
// 头像直接读 Steam 客户端本地的 config/avatarcache，不依赖被墙的头像 CDN
ipcMain.handle('accounts:avatars', wrap(async (ids) =>
  require('./main/steamAvatars').forIds(Array.isArray(ids) ? ids : [])));

/* ---------------------------------- 游戏库 --------------------------------- */

ipcMain.handle('library:scan', wrap(async (opts) => library.scanLibrary(opts || {})));
ipcMain.handle('library:owned', wrap(async (steamId) => library.fetchOwnedGames(steamId)));
// 库存页"游戏"下拉：注册表 ∩ 库里已拥有的优先排序
ipcMain.handle('library:marketApps', wrap(async (steamId) => library.marketAppsFor(steamId)));

// 全量注册表（"全部支持的平台"用）。
// noMarket=true 的条目由渲染层过滤掉：这些 app 实测没有社区市场库存，
// 留在下拉里只会让用户点到必然失败的游戏。
// 批量补中文名：游戏库里 `App 92` 这类占位名和英文名都靠它填上
ipcMain.handle('library:names', wrap(async (appIds) =>
  require('./main/appNames').resolveMany(appIds)));

// 标题 → 中文名（每日促销 GOG/Epic 卡、免费领取卡没有 AppID，按标题解析）
ipcMain.handle('names:titles', wrap(async (titles) =>
  require('./main/appNames').resolveTitles(titles)));

ipcMain.handle('library:registry', wrap(async () => {
  const dead = library.noMarketSet();
  return require('./main/appRegistry')
    .all()
    .map((a) => ({ ...a, noMarket: dead.has(Number(a.appId)) }));
}));

ipcMain.handle('ui:newWindow', wrap(async (page) => {
  openAppWindow(page);
  return true;
}));
ipcMain.handle('ui:setZoom', wrap(async (factor) => {
  const f = Number(factor);
  if (!Number.isFinite(f)) throw new Error('缩放比例无效');
  const clamped = Math.min(1.6, Math.max(0.85, f));
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (w && w.webContents) w.webContents.setZoomFactor(clamped);
  }
  store.setSettings({ uiZoom: clamped });
  return clamped;
}));

/**
 * 解析用户自定义的 AppID：
 *   1) 拿游戏名（商店 appdetails，公开接口，不需要登录）
 *   2) 判断是否开通社区市场（市场搜索页 / 是否有可交易物品）
 *   3) 写入 settings.customApps 永久保存
 * 这样即使注册表没收录，用户自己填 AppID 也能拉库存、查价。
 */
ipcMain.handle('library:resolveApp', wrap(async (appId) => {
  const id = Number(appId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('AppID 必须是正整数'), { code: 'E_BAD_APPID' });
  }

  const registry = require('./main/appRegistry');
  let name = registry.isKnown(id) ? registry.nameOf(id) : '';
  let headerImage = '';
  let type = '';

  // 商店接口拿名字与类型（公开、无需登录；失败不影响主流程）
  if (!name) {
    try {
      // 必须带超时：网络卡住会让"添加"按钮一直转圈，用户以为坏了
      const r = await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${id}&l=schinese&filters=basic`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(6000),
        }
      );
      const j = await r.json();
      const d = j[String(id)];
      if (d && d.success && d.data) {
        name = d.data.name || '';
        headerImage = d.data.header_image || '';
        type = d.data.type || '';
      }
    } catch { /* 网络失败就先用占位名 */ }
  }
  if (!name) name = `App ${id}`;

  // 探测是否开通市场：查该 app 的市场可售列表，能返回就说明有市场
  let tradeable = false;
  let marketNote = '';
  let probeCount = 0;
  try {
    const u = new URL('https://steamcommunity.com/market/search/render/');
    u.searchParams.set('appid', String(id));
    u.searchParams.set('norender', '1');
    u.searchParams.set('count', '10');
    u.searchParams.set('search_descriptions', '0');
    // 同理：市场探测也不能无限等
    const r = await Promise.race([
      bridge.request(u.toString(), { headers: { Accept: 'application/json' } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('探测超时（8s）')), 8000)),
    ]);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { j = null; }
    if (j && typeof j.total_count === 'number') {
      tradeable = j.total_count > 0;
      probeCount = j.total_count;
      marketNote = tradeable
        ? `市场有 ${j.total_count} 件在售商品`
        : '该 AppID 在市场上没有在售商品（可能未开通市场）';
    } else {
      marketNote = '市场接口未返回结果，无法判断是否开通市场';
    }
  } catch (err) {
    marketNote = `市场探测失败：${err.message}`;
  }

  // 注册表里没有的，补进自定义列表并永久保存
  const custom = Array.isArray(store.getSettings().customApps) ? store.getSettings().customApps : [];
  if (!registry.isKnown(id)) {
    const next = custom.filter((x) => Number(x.appId) !== id);
    next.push({ appId: id, name, ctx: '2', tradeable, addedAt: Date.now() });
    store.setSettings({ customApps: next });
  }

  return { appId: id, name, headerImage, type, known: registry.isKnown(id), tradeable, probeCount, marketNote };
}));

/* ---------------------------------- 登录会话 -------------------------------- */

ipcMain.handle('session:login', wrap(async (steamIdHint) => session.openLogin(steamIdHint)));
ipcMain.handle('session:restore', wrap(async (steamId) => session.restoreSavedSession(steamId)));
ipcMain.handle('session:state', wrap(async () => session.listSessions()));
ipcMain.handle('session:logout', wrap(async (steamId) => session.dropSession(steamId)));

// 会话自检：判断"登录了却拉不到数据"到底卡在哪一步（返回不含 Cookie 明文）
ipcMain.handle('session:diag', wrap(async () => bridge.diagnose()));
ipcMain.handle('session:bridgeRefresh', wrap(async () => bridge.refresh()));
ipcMain.handle('session:bridgeShow', wrap(async () => bridge.showWindow()));
ipcMain.handle('session:bridgeHide', wrap(async () => bridge.hideWindow()));

/* ---------------------------------- 库存 ---------------------------------- */

ipcMain.handle('inventory:fetch', wrap(async (steamId, appId, contextId) =>
  inventory.fetchInventory(steamId, appId, contextId)));

// 自动探测：这个账号在哪些游戏里真的有物品（不靠猜，直接问 Steam）
ipcMain.handle('inventory:discover', wrap(async (steamId, appIds, opts) =>
  inventory.discoverApps(steamId, appIds, opts || {})));

// 一次拉多个游戏的库存并汇总（"所有支持交易市场的游戏都能拉"）
ipcMain.handle('inventory:fetchMany', wrap(async (steamId, appIds, opts) => {
  const list = Array.isArray(appIds) ? appIds : [];
  const ok = [];
  const failed = [];
  for (const appId of list) {
    try {
      const r = await inventory.fetchInventory(steamId, appId, null, opts || {});
      if (r.totalAssets > 0) ok.push({ appId, count: r.totalAssets, name: r.appName || '', ctx: r.contextId });
    } catch (err) {
      failed.push({ appId, error: err.message });
    }
  }
  return { ok, failed, totalApps: list.length };
}));

/* ---------------------------------- 行情 ---------------------------------- */

ipcMain.handle('market:quote', wrap(async (appId, hashNames) => market.quoteMany(appId, hashNames)));
ipcMain.handle('market:quoteOne', wrap(async (appId, hashName) => market.quoteOne(appId, hashName)));
ipcMain.handle('market:stats', wrap(async () => market.queueStats()));
// 当前网页登录账号在 Steam 市场上的全部买卖记录（含用其它方式成交的）
ipcMain.handle('market:myHistory', wrap(async (force) =>
  require('./main/marketHistory').myHistory({ force: !!force })));
ipcMain.handle('market:history', wrap(async (appId, hashName) => market.priceHistory(appId, hashName)));

/**
 * 单件物品的「实时 Steam 官方行情」：
 * 历史成交（中位价 + 日成交量）+ 当前在售底价/成交量。
 * 两者互相独立，历史失败不影响当前价，反之亦然。
 */
ipcMain.handle(
  'market:detail',
  wrap(async (appId, hashName) => {
    const [history, quote] = await Promise.all([
      market.priceHistory(appId, hashName).catch((err) => ({ error: err.message, code: err.code })),
      market.quoteOne(appId, hashName).catch((err) => ({ error: err.message, code: err.code })),
    ]);
    return {
      marketHashName: hashName,
      appId,
      history: history && history.error ? null : history,
      historyError: history && history.error ? history.error : null,
      quote: quote && quote.error ? null : quote,
      quoteError: quote && quote.error ? quote.error : null,
      at: Date.now(),
    };
  })
);

/* ---------------------------------- 上架 ---------------------------------- */

ipcMain.handle('sell:plan', wrap(async (payload) => seller.buildPlan(payload)));
ipcMain.handle('sell:run', wrap(async (payload) => seller.runQueue(payload)));
ipcMain.handle('sell:cancel', wrap(async () => seller.cancel()));
ipcMain.handle('sell:listings', wrap(async (steamId, appId) => seller.fetchMyListings(steamId, appId)));
ipcMain.handle('sell:remove', wrap(async (steamId, listingId) => seller.removeListing(steamId, listingId)));

/* ------------------------------- 事件推送 -------------------------------- */

seller.on('progress', (p) => win && win.webContents.send('sell:progress', p));
market.on('progress', (p) => win && win.webContents.send('market:progress', p));
switcher.on('status', (s) => win && win.webContents.send('accounts:status', s));

/* 版本更新：发现新版弹窗 + 下载进度（渲染进程据此显示百分比） */
updater.events.on('found', (d) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:found', d);
});
updater.events.on('dl-progress', (p) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:dlprogress', p);
});

/* ------------------------------ 免费游戏领取 ------------------------------ */

ipcMain.handle('free:list', wrap(async (force) => require('./main/freeGames').list(!!force)));

/* ---------------------------- 价格提醒 / 诊断包 ---------------------------- */

ipcMain.handle('health:check', wrap(async () => require('./main/health').check()));
ipcMain.handle('watch:state', wrap(async () => require('./main/invWatch').getState()));
ipcMain.handle('watch:run', wrap(async (force) => require('./main/invWatch').runOnce({ force: !!force })));
ipcMain.handle('watch:setEnabled', wrap(async (on) => require('./main/invWatch').setEnabled(on)));
ipcMain.handle('costs:list', wrap(async (sid) => require('./main/costs').list(sid)));
ipcMain.handle('costs:set', wrap(async (p) =>
  require('./main/costs').set(p && p.steamId, p && p.marketHashName, p && p.cost)));
ipcMain.handle('costs:remove', wrap(async (p) =>
  require('./main/costs').remove(p && p.steamId, p && p.marketHashName)));
ipcMain.handle('costs:clear', wrap(async (sid) => require('./main/costs').clear(sid)));
ipcMain.handle('costs:bulkSet', wrap(async (p) =>
  require('./main/costs').bulkSet(p && p.steamId, p && p.map, !!(p && p.overwrite))));
ipcMain.handle('costs:overview', wrap(async (sid) => require('./main/costs').overview(sid)));
ipcMain.handle('costs:importCsv', wrap(async (p) => {
  const costs = require('./main/costs');
  const pick = await dialog.showOpenDialog(win || undefined, {
    title: '导入成本 CSV（两列：market_hash_name, 每件成本）',
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { canceled: true };
  let text = '';
  try {
    text = fs.readFileSync(pick.filePaths[0], 'utf8');
  } catch (err) {
    throw new Error(`读不了这个文件：${err && err.message}`);
  }
  const map = costs.parseCsv(text);
  const n = Object.keys(map).length;
  if (!n) throw new Error('这个文件里没有可用行（第一列物品名，第二列成本数字）');
  const r = costs.bulkSet(p && p.steamId, map, !!(p && p.overwrite));
  logger.info('导入成本 CSV', { file: path.basename(pick.filePaths[0]), rows: n, ...r, costs: undefined });
  return { ...r, rows: n, file: path.basename(pick.filePaths[0]) };
}));
ipcMain.handle('risk:status', wrap(async () => require('./main/risk').status()));

ipcMain.handle('restock:state', wrap(async () => require('./main/restock').getState()));
ipcMain.handle('restock:run', wrap(async (force) =>
  require('./main/restock').runOnce({ force: !!force })));
ipcMain.handle('restock:setEnabled', wrap(async (on) =>
  require('./main/restock').setEnabled(on)));

ipcMain.handle('pricing:suggest', wrap(async (list) =>
  require('./main/pricing').suggest(list)));

ipcMain.handle('reports:get', wrap(async (days) => require('./main/reports').build(days)));
ipcMain.handle('reports:state', wrap(async () => require('./main/reports').getState()));
ipcMain.handle('reports:export', wrap(async (days) => {
  const reports = require('./main/reports');
  const r = await reports.build(days);
  const pick = await dialog.showSaveDialog(win || undefined, {
    title: '导出经营报表',
    defaultPath: `经营报表-近${r.days}天.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  fs.writeFileSync(pick.filePath, reports.csv(r), 'utf8');
  logger.info('导出经营报表', { file: path.basename(pick.filePath), days: r.days });
  return { file: pick.filePath, days: r.days };
}));

ipcMain.handle('health:state', wrap(async () => require('./main/health').getState()));
ipcMain.handle('health:setWatch', wrap(async (on) => require('./main/health').setWatch(on)));

ipcMain.handle('costs:exportCsv', wrap(async (sid) => {
  const costs = require('./main/costs');
  const pick = await dialog.showSaveDialog(win || undefined, {
    title: '导出成本 CSV',
    defaultPath: `成本记录-${String(sid || '').slice(-6)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  const text = costs.csvFor(sid);
  fs.writeFileSync(pick.filePath, text, 'utf8');
  logger.info('导出成本 CSV', { file: path.basename(pick.filePath), rows: Object.keys(costs.list(sid)).length });
  return { file: pick.filePath, rows: Object.keys(costs.list(sid)).length };
}));

/* --------------------------- 通知外发 / 阶梯降价 / 自动化 --------------------------- */

ipcMain.handle('update:state', wrap(async () => updater.getState()));
ipcMain.handle('update:check', wrap(async () => updater.check()));
ipcMain.handle('update:open', wrap(async (url) => updater.openDownload(url)));
ipcMain.handle('update:download', wrap(async (url) => updater.downloadUpdate(url)));

/* 代理自动探测：设置页按钮 + 登录窗口失败时自动兜底用 */
ipcMain.handle('net:detectProxy', wrap(async () => require('./main/proxyDetect').detectProxy()));

/* Steam 挂卡（卡牌掉落进度）与游戏玩家/市场统计 */
ipcMain.handle('cards:progress', wrap(async () => require('./main/cardsIdle').progress()));
ipcMain.handle('stats:popular', wrap(async () => require('./main/gameStats').popular()));
ipcMain.handle('stats:lookup', wrap(async (term) => require('./main/gameStats').lookup(term)));

ipcMain.handle('notify:state', wrap(async () => notify.getState()));
ipcMain.handle('notify:set', wrap(async (p = {}) => {
  const patch = {};
  if (typeof p.channel === 'string') patch.notifyChannel = p.channel;
  if (typeof p.desktop === 'boolean') patch.notifyDesktop = p.desktop;
  if (p.tgChat !== undefined) {
    patch.notifyConfig = { ...(store.getSettings().notifyConfig || {}), tgChat: String(p.tgChat || '').trim() };
  }
  /* QQ 配置写入顶层（qqbot.config() 与界面回显都从顶层读），
     同时同步一份进 notifyConfig，避免旧数据和新数据两处不一致。 */
  const qqKeys = ['qqAppId', 'qqGuildId', 'qqChannelId', 'qqChannelName'];
  let qqChanged = false;
  for (const k of qqKeys) {
    if (p[k] !== undefined) {
      patch[k] = String(p[k] || '').trim();
      qqChanged = true;
    }
  }
  if (qqChanged) {
    const merged = { ...(store.getSettings().notifyConfig || {}) };
    for (const k of qqKeys) if (patch[k] !== undefined) merged[k] = patch[k];
    patch.notifyConfig = { ...(patch.notifyConfig || merged), ...merged };
  }
  const putSecret = (name, value) => {
    if (value === undefined) return;
    const v = String(value || '').trim();
    if (v) store.saveSecret(name, v);
    else store.removeSecret(name);
  };
  putSecret('notify:tgToken', p.tgToken);
  putSecret('notify:webhook', p.webhook);
  putSecret('notify:scKey', p.scKey);
  putSecret('notify:qqSecret', p.qqSecret);
  store.setSettings(patch);
  logger.info('通知外发设置更新', { channel: store.getSettings().notifyChannel, desktop: store.getSettings().notifyDesktop });
  // QQ 凭据变化时重启实时网关（私聊/群聊绑定靠它收消息）
  if (p.qqAppId !== undefined || p.qqSecret !== undefined) {
    const qb = require('./main/qqbot');
    if (store.getSettings().qqAppId && store.readSecret('notify:qqSecret')) {
      qb.restartGateway().catch((e) => logger.warn('QQ 网关重启失败', { message: e && e.message }));
    } else {
      qb.stopGateway();
    }
  }
  return notify.getState();
}));
ipcMain.handle('notify:test', wrap(async () => notify.test()));
ipcMain.handle('notify:qqTargets', wrap(async () => require('./main/qqbot').listTargets()));
ipcMain.handle('notify:qqGateway', wrap(async () => require('./main/qqbot').gatewayState()));
ipcMain.handle('notify:qqRestart', wrap(async () => require('./main/qqbot').restartGateway()));
ipcMain.handle('notify:qqUnbind', wrap(async (kind) => {
  require('./main/qqbot').unbind(kind);
  return require('./main/qqbot').bindState();
}));

ipcMain.handle('saleWatch:state', wrap(async () => saleWatch.getState()));
ipcMain.handle('saleWatch:run', wrap(async (force) => saleWatch.checkOnce({ force: !!force })));
ipcMain.handle('saleWatch:refresh', wrap(async () => {
  saleWatch.reschedule();
  // 刚开启时先跑一次：只记录现有成交，之后的新卖出现在就能通知
  const st = saleWatch.getState();
  if (st.enabled && !st.lastAt) saleWatch.checkOnce().catch(() => {});
  return saleWatch.getState();
}));

ipcMain.handle('ladder:state', wrap(async () => require('./main/ladder').getState()));
ipcMain.handle('ladder:run', wrap(async (force) => require('./main/ladder').runOnce({ force: !!force })));
ipcMain.handle('ladder:setEnabled', wrap(async (on) => require('./main/ladder').setEnabled(on)));

// 自动守价（被压价跟价）
ipcMain.handle('priceGuard:state', wrap(async () => priceGuard.getState()));
ipcMain.handle('priceGuard:run', wrap(async (force) => priceGuard.runOnce({ force: !!force })));
ipcMain.handle('priceGuard:set', wrap(async (patch) => priceGuard.setOptions(patch || {})));

// 登录态预警
ipcMain.handle('sessionWatch:state', wrap(async () => sessionWatch.getState()));
ipcMain.handle('sessionWatch:run', wrap(async (force) => sessionWatch.checkOnce({ force: !!force })));

// 交易报价提醒（Steam Web API）
ipcMain.handle('tradeWatch:state', wrap(async () => tradeWatch.getState()));
ipcMain.handle('tradeWatch:run', wrap(async (force) => tradeWatch.checkOnce({ force: !!force })));
ipcMain.handle('tradeWatch:refresh', wrap(async () => {
  tradeWatch.reschedule();
  return tradeWatch.getState();
}));

// AI 助手（可选，兼容 OpenAI 接口）
ipcMain.handle('ai:report', wrap(async (days) => ai.weeklyReport(days)));
ipcMain.handle('ai:ask', wrap(async (question) => ai.ask(question)));
ipcMain.handle('ai:test', wrap(async () => ai.test()));
ipcMain.handle('ai:models', wrap(async () => ai.listModels()));

// 浏览器扩展采集入口
ipcMain.handle('ext:state', wrap(async () => ingest.getState()));
ipcMain.handle('ext:prices', wrap(async () => ingest.getPrices()));
ipcMain.handle('ext:clear', wrap(async () => ingest.clearPrices()));
ipcMain.handle('ext:openFolder', wrap(async () => {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, 'extension');
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return dir;
}));

// 应用内通知中心
ipcMain.handle('notices:list', wrap(async (limit) => notices.list(limit)));
ipcMain.handle('notices:read', wrap(async (id) => notices.markRead(id)));
ipcMain.handle('notices:readAll', wrap(async () => notices.markAll()));
ipcMain.handle('notices:clear', wrap(async () => notices.clear()));

// 备份与恢复
ipcMain.handle('backup:export', wrap(async () => backup.exportBundle()));
ipcMain.handle('backup:import', wrap(async () => backup.importBundle()));

ipcMain.handle('automation:get', wrap(async () => ({
  paused: store.getSettings().automationPaused === true,
  restock: store.getSettings().restock === true,
  ladder: store.getSettings().ladderEnabled === true,
  healthWatch: store.getSettings().healthWatch !== false,
})));
ipcMain.handle('automation:pause', wrap(async (on) => {
  store.setSettings({ automationPaused: !!on });
  logger.info('自动化总开关', { paused: !!on });
  try {
    if (win && !win.isDestroyed()) win.webContents.send('automation:changed', !!on);
  } catch { /* ignore */ }
  refreshTrayMenu();
  return { paused: !!on };
}));

ipcMain.handle('errors:recent', wrap(async (limit) => errors.recent(Number(limit) || 30)));
ipcMain.handle('errors:clear', wrap(async () => errors.clear()));

/* -------------------------------- 本地归档 -------------------------------- */

ipcMain.handle('archive:state', wrap(async () => require('./main/archive').getState()));
ipcMain.handle('archive:trades', wrap(async (sid, opts) =>
  require('./main/archive').trades(sid, opts || {})));
ipcMain.handle('archive:series', wrap(async (appId, hashName, days) =>
  require('./main/archive').series(appId, hashName, days)));
ipcMain.handle('archive:today', wrap(async (sid, ts) =>
  require('./main/archive').daySummary(sid, ts)));
ipcMain.handle('archive:export', wrap(async (sid) => {
  const archive = require('./main/archive');
  const rows = archive.trades(sid);
  if (!rows.length) return { empty: true, rows: 0 };
  const pick = await dialog.showSaveDialog(win || undefined, {
    title: '导出成交归档',
    defaultPath: `成交归档-${String(sid || '').slice(-6)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  fs.writeFileSync(pick.filePath, archive.tradesCsv(sid), 'utf8');
  logger.info('导出成交归档', { file: path.basename(pick.filePath), rows: rows.length });
  return { file: pick.filePath, rows: rows.length };
}));

ipcMain.handle('alerts:list', wrap(async () => require('./main/priceAlerts').list()));
ipcMain.handle('alerts:save', wrap(async (a) => require('./main/priceAlerts').save(a || {})));
ipcMain.handle('alerts:remove', wrap(async (id) => require('./main/priceAlerts').remove(String(id || ''))));
ipcMain.handle('diag:export', wrapEvent(async (_event, uiLogs) =>
  require('./main/diag').exportBundle(win, { uiLogs })));
ipcMain.handle('diag:openLogs', wrap(async () => require('./main/diag').openLogs()));
// 渲染层的操作记录也落盘：用户反馈时装订成一份日志更好定位
ipcMain.on('diag:log', (_e, text, tone) => {
  try {
    // 界面日志可能自带换行，压成一行，避免一条记录被拆成好几行、截断时只剩半句
    const msg = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 500);
    logger.info(`[ui] ${msg}`, tone ? { tone } : undefined);
  } catch { /* ignore */ }
});

/* ------------------------------ Epic 一键领取 ------------------------------ */

const epicClaim = require('./main/epicClaim');
ipcMain.handle('epic:status', wrap(async () => epicClaim.list()));
// 登录窗口由用户自己操作账号密码/2FA，我们只接收最后的授权码
ipcMain.handle('epic:login', wrap(async () => epicClaim.openLoginWindow(win)));
ipcMain.handle('epic:logout', wrap(async () => epicClaim.logoutAll()));
ipcMain.handle('epic:remove', wrap(async (id) => epicClaim.remove(id)));
ipcMain.handle('epic:setEnabled', wrap(async (id, enabled) => epicClaim.setEnabled(id, enabled)));
ipcMain.handle('epic:claim', wrap(async (offers, opts) => {
  const r = await epicClaim.claimMany(offers, opts || {});
  notifyClaimResult('Epic', r);
  return r;
}));
// 游戏库渐进加载：先返回已缓存的条目，之后每补一批目录就 push 一次
ipcMain.handle('epic:library', wrapEvent(async (event, accountId) =>
  require('./main/epicLibrary').fetchLibrary(accountId, {}, (payload) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send('epic:library:batch', { accountId, ...payload });
      }
    } catch { /* 窗口已关 */ }
  })));
// 用库里现有的条目判断哪些免费游戏已经拥有（刷新后不用再让你领一遍）
ipcMain.handle('epic:owned', wrap(async (offers, force) =>
  require('./main/epicLibrary').matchOffers(null, offers || [], { force: !!force })));

// Steam：免费包走商店的 addfreelicense，复用主程序的 persist:steam 登录态
ipcMain.handle('steam:freeStatus', wrap(async () => require('./main/steamClaim').status()));
ipcMain.handle('steam:claim', wrap(async (item) => {
  const r = await require('./main/steamClaim').claim(item);
  notifyClaimResult('Steam', r && Array.isArray(r.results) ? r : (r && r.ok ? { claimed: 1, titles: [item && item.title] } : r));
  return r;
}));

// GOG：库和赠送领取都认网页 Cookie，登录窗口只需要开一次
ipcMain.handle('gog:status', wrap(async () => require('./main/gogLibrary').status()));
ipcMain.handle('gog:login', wrap(async () => require('./main/gogLibrary').openLoginWindow(win)));
ipcMain.handle('gog:library', wrap(async () => require('./main/gogLibrary').fetchLibrary()));
ipcMain.handle('gog:owned', wrap(async (offers, force) =>
  require('./main/gogLibrary').matchOffers(offers || [], { force: !!force })));
ipcMain.handle('gog:claim', wrap(async () => {
  const r = await require('./main/gogLibrary').claim();
  notifyClaimResult('GOG', r);
  return r;
}));
ipcMain.handle('gog:logout', wrap(async () => require('./main/gogLibrary').logout()));

/* ---------------------------------- 授权 ---------------------------------- */

ipcMain.handle('license:status', wrap(async () => license.status()));
ipcMain.handle('license:activate', wrap(async (key) => license.activate(key)));

/* ----------------------------- 商店价格与挂机通告 ---------------------------- */

ipcMain.handle('store:price', wrap(async (appIdOrName) =>
  storeSearch.queryStorePrice(appIdOrName, { region: store.getSettings().storeRegion })));
ipcMain.handle('store:regionPrices', wrap(async (appIdOrName) => storeSearch.queryMultiRegionPrice(appIdOrName)));
ipcMain.handle('store:idleGames', wrap(async (force) =>
  require('./main/hotIdle').getHotIdleGames(!!force)));
ipcMain.handle('store:idleStats', wrap(async (force) => {
  const stats = await require('./main/idleMarket').all({ force: !!force });
  // 顺手记一笔当日最低价，卡片上的 7 天曲线就有数据了
  try {
    priceHistory.record(stats);
  } catch { /* 记录失败不影响行情 */ }
  return stats;
}));
ipcMain.handle('store:priceHistory', wrap(async () => priceHistory.series()));
// 正在玩的游戏（读 HKCU\Software\Valve\Steam\RunningAppID），给挂机列表置顶用
ipcMain.handle('store:playing', wrap(async () => require('./main/playing').current()));
ipcMain.handle('store:dailyDeals', wrap(async (force) => require('./main/dailyDeals').all({ force: !!force })));

// Ubisoft（Uplay）促销清单：游戏库 Ubisoft 标签页用
ipcMain.handle('plat:deals', wrap(async (platform, force) =>
  require('./main/ubiDeals').list(platform, !!force)));

/* 平台网页登录（Ubisoft / EA / 暴雪战网）：账号管理与游戏库平台页共用 */
ipcMain.handle('plat:status', wrap(async () => require('./main/platformLogin').statusAll()));
ipcMain.handle('plat:statusOne', wrap(async (platform) => require('./main/platformLogin').status(platform)));
ipcMain.handle('plat:login', wrap(async (platform) =>
  require('./main/platformLogin').openLoginWindow(platform, win)));
ipcMain.handle('plat:logout', wrap(async (platform) => require('./main/platformLogin').logout(platform)));

/* Ubisoft 账号库：官方 Ubiservices 接口（官方登录窗口 / 邮箱密码直连）+ 暴雪战网账号库 */
ipcMain.handle('ubi:login', wrap(async ({ email, password }) =>
  require('./main/ubiAccount').loginPassword(email, password)));
ipcMain.handle('ubi:loginWeb', wrap(async () =>
  require('./main/ubiAccount').loginWeb(win)));
ipcMain.handle('ubi:openBrowserLogin', wrap(async () =>
  require('./main/ubiAccount').openBrowserLogin()));
ipcMain.handle('ubi:loginFromUrl', wrap(async ({ url }) =>
  require('./main/ubiAccount').loginFromUrl(url)));
ipcMain.handle('ubi:login2fa', wrap(async ({ code }) => require('./main/ubiAccount').login2fa(code)));
ipcMain.handle('ubi:logout', wrap(async () => require('./main/ubiAccount').logoutAccount()));
ipcMain.handle('ubi:library', wrap(async (force) => require('./main/ubiAccount').fetchLibrary(!!force)));
ipcMain.handle('ubi:accountStatus', wrap(async () => require('./main/ubiAccount').status()));

/* 暴雪战网账号库：account.battle.net/games-and-subs（登录 Cookie 在平台登录分区） */
ipcMain.handle('bnet:library', wrap(async (force) =>
  require('./main/blizzardAccount').fetchLibrary(!!force)));
ipcMain.handle('bnet:logout', wrap(async () => require('./main/blizzardAccount').logout()));

ipcMain.handle('store:wishlistList', wrap(async () => require('./main/wishlist').list()));
ipcMain.handle('store:wishlistPrices', wrap(async (items) => require('./main/wishlist').prices(items)));
ipcMain.handle('store:idleWatchAdd', wrap(async (p) =>
  require('./main/idleMarket').addWatch(p && p.appId, p && p.name)));
ipcMain.handle('store:idleWatchRemove', wrap(async (appId) =>
  require('./main/idleMarket').removeWatch(appId)));

ipcMain.handle('store:holding', wrap(async (appId) => {
  const id = Number(appId);
  if (!id) throw Object.assign(new Error('AppID 不对'), { code: 'E_BAD_APPID' });
  const live = await session.getSession().catch(() => null);
  const sid = live && live.steamId;
  if (!sid) return { loggedIn: false };
  const inventory = require('./main/inventory');
  const costs = require('./main/costs');
  const seller = require('./main/seller');
  let inv;
  try {
    inv = await inventory.fetchInventory(sid, id, null, { noNote: true });
  } catch (e) {
    // 纯游戏、没有可交易饰品时 Steam 会回 k_EResultNoMatch，这不是故障
    const msg = String((e && e.message) || '');
    if (/k_EResultNoMatch|没有社区市场库存|NoMatch/.test(msg)) {
      return { loggedIn: true, appId: id, hasMarket: false };
    }
    throw e;
  }
  const groups = (inv && inv.groups) || [];
  const itemCount = groups.reduce((a, g) => a + (Number(g.qty) || 0), 0);
  const costMap = costs.list(sid);
  let costQty = 0;
  let costTotal = 0;
  for (const g of groups) {
    const rec = costMap[g.marketHashName || g.key];
    const c = rec && Number(rec.cost);
    if (c > 0) {
      costQty += Number(g.qty) || 0;
      costTotal += c * (Number(g.qty) || 0);
    }
  }
  let listings = 0;
  try {
    const r = await seller.fetchMyListings(sid, id);
    listings = r && Array.isArray(r.listings) ? r.listings.length : 0;
  } catch {
    /* 挂单读不到就留空 */
  }
  return {
    loggedIn: true,
    appId: id,
    itemCount,
    groupCount: groups.length,
    costQty,
    costTotal: Math.round(costTotal * 100) / 100,
    listings,
  };
}));

ipcMain.handle('storeAlerts:list', wrap(async () => require('./main/storeWatch').list()));
ipcMain.handle('storeAlerts:add', wrap(async (p) => {
  const item = require('./main/storeWatch').add(p && p.appId, p || {});
  require('./main/storeWatch').checkOnce().catch(() => {});
  return item;
}));
ipcMain.handle('storeAlerts:addMany', wrap(async (items) => {
  const sw = require('./main/storeWatch');
  const added = [];
  let dup = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 50)) {
    try {
      added.push(sw.add(it && it.appId, it || {}));
    } catch (e) {
      if (e && e.code === 'E_DUP_ALERT') dup++;
    }
  }
  if (added.length) sw.checkOnce().catch(() => {});
  return { added: added.length, dup, list: sw.list() };
}));
ipcMain.handle('storeAlerts:remove', wrap(async (id) => require('./main/storeWatch').remove(id)));
ipcMain.handle('storeAlerts:check', wrap(async () => require('./main/storeWatch').checkOnce()));

ipcMain.handle('store:itad', wrap(async (appId) => require('./main/itad').historyLow(appId)));
ipcMain.handle('store:itadStatus', wrap(async () => require('./main/itad').status()));
ipcMain.handle('store:itadKey', wrap(async (value) => {
  const v = String(value || '').trim();
  if (v) store.saveSecret('store:itadKey', v);
  else store.removeSecret('store:itadKey');
  return require('./main/itad').status();
}));

ipcMain.handle('dropWatch:state', wrap(async () => require('./main/dropWatch').getState()));
ipcMain.handle('dropWatch:run', wrap(async (force) => require('./main/dropWatch').checkOnce({ force: !!force })));
ipcMain.handle('dropWatch:refresh', wrap(async () => {
  require('./main/dropWatch').reschedule();
  return require('./main/dropWatch').getState();
}));
