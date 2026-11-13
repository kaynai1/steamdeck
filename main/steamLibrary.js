'use strict';

const fs = require('fs');
const path = require('path');
const vdf = require('./vdf');
const paths = require('./paths');
const store = require('./store');
const registry = require('./appRegistry');
const imageProxy = require('./imageProxy');
const appNames = require('./appNames');

/**
 * 游戏库识别 + 封面
 *
 * ★ 封面为什么不显示 ★
 * 老版本 coverUrl() 拼出了 header.jpg，但渲染层根本没用它，
 * 而是画了个渐变块 + 三个大写字母（APP_META 只认 4 个游戏，其余全变灰块）。
 * 所以看起来"图片都不显示"，其实是压根没渲染 img。
 * 现在后端一次给出多级回退 URL，前端用 <img> + onerror 逐级降级。
 */

/** 多级封面地址（按成功率排序）：header 最大最清晰，失败退 capsule，再退小图标 */
function coverUrls(appId) {
  const id = Number(appId) || 0;
  // 全部走本地 sdimg:// 代理：主进程内部会依次试 cdn/shared 多个域名，
  // 渲染层只面对一个稳定的本地地址，不受任何单个 CDN 被墙影响。
  return [
    imageProxy.appUrl(id, 'header.jpg'),
    imageProxy.appUrl(id, 'capsule_231x87.jpg'),
    imageProxy.appUrl(id, 'capsule_184x69.jpg'),
  ].filter(Boolean);
}

function coverUrl(appId) {
  return coverUrls(appId)[0];
}

/**
 * 竖版封面（2:3），游戏库网格用。
 * library_600x900.jpg 是 Steam 新版库的正式竖版图，比横版 header 更适合做卡片墙；
 * 实测在 steamcdn-a.akamaihd.net 上可正常取到。取不到时退回横版。
 */
function portraitCoverUrls(appId) {
  const id = Number(appId) || 0;
  return [
    imageProxy.appUrl(id, 'library_600x900.jpg'),
    imageProxy.appUrl(id, 'header.jpg'),
    imageProxy.appUrl(id, 'capsule_231x87.jpg'),
  ].filter(Boolean);
}

/** 占位名（`App 92`）没有信息量，当作"没有名字"处理 */
function isPlaceholderName(name) {
  return !name || /^App\s*\d+$/i.test(String(name).trim());
}

/** 通过本地 appmanifest_*.acf 扫描已安装游戏 */
function scanInstalled(steamPath) {
  const libs = paths.libraryFolders(steamPath, vdf);
  const games = [];
  const seen = new Set();

  for (const lib of libs) {
    const appsDir = path.join(lib, 'steamapps');
    let files = [];
    try {
      files = fs.readdirSync(appsDir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const data = vdf.parse(fs.readFileSync(path.join(appsDir, f), 'utf8'));
        const st = data.AppState;
        if (!st) continue;
        const appId = Number(st.appid);
        if (!appId || seen.has(appId)) continue;
        seen.add(appId);
        games.push({
          appId,
          name: appNames.nameOf(appId) || st.name || `App ${appId}`,
          installDir: st.installdir || '',
          sizeOnDisk: Number(st.SizeOnDisk) || 0,
          stateFlags: Number(st.StateFlags) || 0,
          lastUpdated: Number(st.LastUpdated) || 0,
          libraryPath: lib,
          installed: true,
          tradeable: registry.isKnown(appId),
          ctx: registry.ctxOf(appId),
          cover: coverUrl(appId),
          covers: coverUrls(appId),
          coversPortrait: portraitCoverUrls(appId),
        });
      } catch {
        /* 单个 acf 读取失败不影响整体 */
      }
    }
  }
  return games;
}

/** 转换 SteamID64 为 32 位 AccountID (对应 userdata 文件夹名) */
function toAccountId32(steamId) {
  if (!steamId) return null;
  const s = String(steamId).trim();
  if (/^\d{8,10}$/.test(s)) return s;
  try {
    const b = BigInt(s);
    if (b > 76561197960265728n) {
      return String(b - 76561197960265728n);
    }
  } catch {}
  return s;
}

/** 从 userdata/<id>/config/localconfig.vdf 拿"已拥有"列表（含未安装） */
function scanOwned(steamId) {
  const settings = store.getSettings();
  const ud = paths.userdataDir(settings.steamPath);
  if (!ud) return { apps: [], warning: '未找到 userdata 目录' };

  let targetId = toAccountId32(steamId);
  if (!targetId) {
    try {
      const dirs = fs.readdirSync(ud).filter((d) => /^\d+$/.test(d));
      const real = dirs.filter((d) => d !== '0').sort((a, b) => Number(b) - Number(a));
      targetId = real[0] || dirs[0];
    } catch {
      return { apps: [], warning: 'userdata 目录无法读取' };
    }
  }
  if (!targetId) return { apps: [], warning: '暂无任何本地账号数据' };

  const file = path.join(ud, targetId, 'config', 'localconfig.vdf');
  if (!fs.existsSync(file)) {
    return { apps: [], warning: `账号 ${targetId} 的 localconfig.vdf 不存在（可能从未登录过）` };
  }

  let data;
  try {
    data = vdf.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { apps: [], warning: `localconfig.vdf 解析失败：${err.message}` };
  }

  const apps = [];
  try {
    const userLocal = data.UserLocalConfigStore || {};
    const software = userLocal.Software || {};
    const valve = software.Valve || {};
    const steam = valve.Steam || {};
    const appsNode = steam.apps || {};

    for (const [appIdStr, info] of Object.entries(appsNode)) {
      const appId = Number(appIdStr);
      if (!appId || appId === 0 || appId === 7) continue;

      const localName = (info && typeof info === 'object' && info.name) || '';
      // 优先级：商店中文名缓存 → 本地记录的名字 → 内置注册表 → AppID 占位符
      let name = appNames.nameOf(appId) || localName;
      if (!name && registry.isKnown(appId)) name = registry.nameOf(appId);

      const app = {
        appId,
        name: name || `App ${appId}`,
        hasName: !isPlaceholderName(name),
        installed: false,
        tradeable: registry.isKnown(appId),
        ctx: registry.ctxOf(appId),
        cover: coverUrl(appId),
        covers: coverUrls(appId),
        coversPortrait: portraitCoverUrls(appId),
      };
      if (info && typeof info === 'object') {
        app.lastPlayed = Number(info.LastPlayed) || 0;
        app.playtime = Number(info.Playtime) || 0;
        app.playtime2Weeks = Number(info.Playtime2Weeks || info.Playtime2wks) || 0;
      }
      apps.push(app);
    }
  } catch {
    /* 结构异常时返回空，让上层提示 */
  }

  return { steamId: targetId, apps, warning: apps.length ? null : 'localconfig.vdf 里没有 app 记录' };
}

/** 官方 Web API 或会话免 Key 自动拉取完整游戏库 */
async function fetchOwnedGames(steamId, apiKey) {
  if (!steamId) throw Object.assign(new Error('缺少 SteamID'), { code: 'E_NO_STEAMID' });

  // 1. 尝试从已登录的会话中自动获取/申请 API Key
  const sessionModule = require('./session');
  let key = apiKey || store.getSettings().apiKey || process.env.STEAM_API_KEY;
  if (!key) {
    key = await sessionModule.autoGetApiKey();
  }

  // 2. 如果成功拿到 Key，走官方官方 API (数据最全最稳)
  if (key) {
    try {
      const url =
        `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}` +
        `&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1`;

      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        const games = (json.response && json.response.games) || [];
        if (games.length > 0) {
          return {
            steamId,
            count: games.length,
            games: games
              .map((g) => ({
                appId: g.appid,
                name: g.name,
                playtime: g.playtime_forever || 0,
                playtime2Weeks: g.playtime_2weeks || 0,
                lastPlayed: (g.rtime_last_played || 0) * 1000,
                cover: coverUrl(g.appid),
                covers: coverUrls(g.appid),
                coversPortrait: portraitCoverUrls(g.appid),
                tradeable: registry.isKnown(g.appid),
                ctx: registry.ctxOf(g.appid),
              }))
              .sort((a, b) => b.playtime - a.playtime),
          };
        }
      }
    } catch (err) {
      console.warn('[fetchOwnedGames] API call failed:', err.message);
    }
  }

  // 3. 兜底方案：通过已登录社区会话抓取个人主页游戏列表
  const commGames = await sessionModule.fetchGamesFromCommunity(steamId);
  if (commGames.length > 0) {
    return {
      steamId,
      count: commGames.length,
      games: commGames,
    };
  }

  // 4. 再次兜底：扫描本地 userdata/<id>/config/localconfig.vdf
  const localScan = scanOwned(steamId);
  if (localScan.apps && localScan.apps.length > 0) {
    return {
      steamId,
      count: localScan.apps.length,
      games: localScan.apps,
    };
  }

  throw Object.assign(
    new Error('无法自动获取游戏库。请确认该账号已在 SteamDesk 中登录，或在设置中填入 Steam Web API Key。'),
    { code: 'E_NO_API_KEY' }
  );
}

/** 合并本地已装 + 已拥有 + 在线数据，得到统一游戏库 */
async function scanLibrary(opts = {}) {
  const settings = store.getSettings();
  const steamPath = opts.steamPath || settings.steamPath || paths.detectSteamPath();

  const installed = scanInstalled(steamPath);
  const owned = scanOwned(opts.steamId);

  const map = new Map();
  for (const g of owned.apps) {
    map.set(g.appId, {
      appId: g.appId,
      name: g.name || `App ${g.appId}`,
      hasName: g.hasName !== undefined ? g.hasName : !isPlaceholderName(g.name),
      installed: false,
      tradeable: g.tradeable,
      ctx: g.ctx,
      playtime: g.playtime || 0,
      playtime2Weeks: g.playtime2Weeks || 0,
      lastPlayed: g.lastPlayed || 0,
      cover: g.cover,
      covers: g.covers,
      coversPortrait: g.coversPortrait,
    });
  }
  for (const g of installed) {
    const prev = map.get(g.appId) || {};
    map.set(g.appId, {
      ...prev,
      appId: g.appId,
      name: appNames.nameOf(g.appId) || g.name,
      hasName: true,
      installed: true,
      tradeable: g.tradeable,
      ctx: g.ctx,
      sizeOnDisk: g.sizeOnDisk,
      lastUpdated: g.lastUpdated,
      libraryPath: g.libraryPath,
      cover: g.cover,
      covers: g.covers,
      coversPortrait: g.coversPortrait,
    });
  }

  const list = [...map.values()].sort((a, b) => {
    if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
    return (b.playtime || 0) - (a.playtime || 0);
  });

  return {
    steamPath,
    total: list.length,
    installedCount: installed.length,
    tradeableCount: list.filter((g) => g.tradeable).length,
    games: list,
    warning: owned.warning,
  };
}

/** 给库存页下拉用：注册表 ∩ 库里有的 + 库外注册表全集（标记来源） */
/** 已被 Steam 明确判定"没有社区市场"的 app（拉库存返回 k_EResultNoMatch / 500） */
function noMarketSet() {
  try {
    const map = (store.getSettings() || {}).noMarketApps || {};
    return new Set(Object.keys(map).map(Number).filter((n) => n > 0));
  } catch {
    return new Set();
  }
}

function marketAppsFor(steamId) {
  const owned = scanOwned(steamId);
  const ownedIds = new Set(owned.apps.map((a) => Number(a.appId)));
  const dead = noMarketSet();
  const list = registry
    .all()
    .filter((a) => !dead.has(Number(a.appId)))
    .map((a) => ({
      ...a,
      owned: ownedIds.has(a.appId),
    }));
  list.sort((a, b) => {
    if (a.owned !== b.owned) return a.owned ? -1 : 1;
    return 0;
  });
  return list;
}

module.exports = {
  scanLibrary,
  scanInstalled,
  scanOwned,
  fetchOwnedGames,
  coverUrl,
  coverUrls,
  portraitCoverUrls,
  marketAppsFor,
  noMarketSet,
  TRADEABLE_APPS: new Set(Object.keys(registry.MARKET_APPS).map(Number)),
};
