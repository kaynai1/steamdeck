'use strict';

/**
 * 挂机掉落游戏资讯与 Steam 游戏特惠/价格查询模块
 *
 * 1. 挂机掉落游戏动态（Banana / Cats / Egg / CS2 等各类掉落道具与香蕉类热点游戏，附带上线日期与掉落机制）
 * 2. 官方商店特惠与价格查询（store.steampowered.com/api/appdetails + steamspy / store search）
 */

// 优质精选与最新热门挂机掉落游戏跟踪列表
const IDLE_DROPS_REGISTRY = [
  {
    appId: 2923300,
    name: 'Banana',
    category: '挂机点击 / 道具掉落',
    releaseDate: '2024-04-23',
    status: '持续热门 · 掉落正常',
    statusTag: 'active',
    dropInterval: '每 3 小时掉落普通香蕉，每 18 小时掉落稀有香蕉',
    hasMarket: true,
    avgPrice: '¥0.03 ~ ¥1,000+',
    desc: '点击香蕉类鼻祖，通过游戏在线挂机自动掉落各种不同外观的香蕉饰品，可在 Steam 社区市场自由买卖。',
    tips: '建议挂机时保持 Steam 登录，每日定时前往市场挂单变现。',
  },
  {
    appId: 2977660,
    name: 'Cats',
    category: '寻物点击 / 掉落道具',
    releaseDate: '2024-05-21',
    status: '掉落正常 · 每日掉落',
    statusTag: 'active',
    dropInterval: '每 3 小时随机掉落 1 款猫咪主题道具',
    hasMarket: true,
    avgPrice: '¥0.05 ~ ¥300+',
    desc: '黑白手绘风格寻猫游戏，在线挂机与点击均可获得独特品种猫咪饰品，全系列道具均可在市场挂牌出售。',
    tips: '部分隐藏限定猫单价可达数十元，掉落后可立刻在「饰品仓库」查价挂出。',
  },
  {
    appId: 3014060,
    name: 'Egg',
    category: '挂机开蛋 / 社区收藏',
    releaseDate: '2024-06-03',
    status: '稳定运营 · 限量蛋',
    statusTag: 'active',
    dropInterval: '每 24 小时自动产出 1 枚彩蛋',
    hasMarket: true,
    avgPrice: '¥0.04 ~ ¥100+',
    desc: '经典极简挂机游戏，只需保持游戏开启即可按自然日周期开出限量蛋道具，可交易可出售。',
    tips: '节假日活动期间会掉落黄金/节日限定蛋。',
  },
  {
    appId: 730,
    name: 'Counter-Strike 2',
    category: '周常周本 / 核心掉落',
    releaseDate: '2023-09-28',
    status: '官方每周升级礼包',
    statusTag: 'premier',
    dropInterval: '每周二晚重置，经验升级必得 1 箱子 + 1 涂鸦/皮肤',
    hasMarket: true,
    avgPrice: '¥3.00 ~ ¥70.00 (箱子保底)',
    desc: '最具保值和流动性的掉落游戏。每周升 1 级即可自选武器箱与武器皮肤，箱子单价极高（如电竞箱/梦魇箱/变革箱）。',
    tips: '建议周三周四刷新后第一时间获取并上架，新箱子发布初期单价可达 50~100 元。',
  },
  {
    appId: 570,
    name: 'Dota 2',
    category: 'MOBA / 比赛与观赛掉落',
    releaseDate: '2013-07-09',
    status: '长期运营 · 随机掉落',
    statusTag: 'premier',
    dropInterval: '游玩对局结束随机掉落套装、信使或珍藏',
    hasMarket: true,
    avgPrice: '¥0.10 ~ ¥500+',
    desc: 'Valve 官方大作，游戏内掉落的饰品可合成、解封与交易，部分冷门绝版信使具有高收藏溢价。',
    tips: '掉落的大部分散件可在本软件一键清仓打包售卖。',
  },
  {
    appId: 440,
    name: 'Team Fortress 2',
    category: '射击 / 随机掉落系统',
    releaseDate: '2007-10-10',
    status: '每周定时掉落上限',
    statusTag: 'active',
    dropInterval: '每周约 10 小时游戏时间内掉落 6~12 件武器与箱子',
    hasMarket: true,
    avgPrice: '¥0.05 ~ ¥200+',
    desc: '经典的军团要塞 2 掉落池，武器可通过合成金属换取曼恩企业补给箱钥匙（Steam 硬通货）。',
    tips: '箱子与特殊武器可直接通过「饰品仓库」按最低价秒出。',
  },
  {
    appId: 252490,
    name: 'Rust',
    category: '生存沙盒 / 官方 Twitch 与时长掉落',
    releaseDate: '2018-02-08',
    status: '时长与官方活动掉落',
    statusTag: 'premier',
    dropInterval: '游玩累计达到固定时长随机掉落桶子/皮肤',
    hasMarket: true,
    avgPrice: '¥5.00 ~ ¥2,000+',
    desc: 'Rust 皮肤市场极其活跃，不仅有官方周期性箱子木桶掉落，更有独家限量枪皮防具。',
    tips: '稀有木桶开出的老皮肤单价常年高位，流动性好。',
  },
  {
    appId: 304930,
    name: 'Unturned (未转变者)',
    category: '沙盒末日 / 免费掉落饰品与箱子',
    releaseDate: '2017-07-07',
    status: '持续热门 · 免费畅玩',
    statusTag: 'active',
    dropInterval: '每周游玩累计时长自动掉落各系列武器箱与皮肤',
    hasMarket: true,
    avgPrice: '¥0.03 ~ ¥80.00',
    desc: '老牌免费沙盒生存游戏，在 Steam 社区市场拥有成熟独立的交易品类，掉落箱子可直接挂牌变现。',
    tips: '可配合饰品仓库的自动查价功能一键清仓上架。',
  },
];

/**
 * 每天大概掉落几件（经验估算，只用于在卡片上算「大概值多少钱 / 天」）
 * 这些数字来自各游戏公开的掉落规则，实际有随机性，所以页面上都标了「估算」。
 */
const DROPS_PER_DAY = {
  2923300: 8, // Banana：每 3 小时 1 件
  2977660: 8, // Cats：每 3 小时 1 件
  3014060: 1, // Egg：每天 1 枚
  730: 0.3, // CS2：每周 1 箱 + 1 涂鸦
  570: 1, // Dota 2：对局随机
  440: 1.4, // TF2：每周约 10 小时掉 6~12 件
  252490: 0.5, // Rust：时长掉落
  304930: 1, // Unturned：时长掉落
};

/** 获取挂机掉落游戏推荐列表（带每日掉落估算） */
function getIdleDropGames() {
  return IDLE_DROPS_REGISTRY.map((g) => ({ ...g, dropsPerDay: DROPS_PER_DAY[g.appId] || 1 }));
}

/**
 * 实时查询 Steam 商店游戏价格与折扣信息
 * 走 Steam 官方公开的 store.steampowered.com/api/appdetails
 * 支持人民币格式化、折扣计算与基础信息
 */
const REGION_CC = { CN: 'CN', HK: 'HK', TW: 'TW', US: 'US', JP: 'JP', EU: 'DE', RU: 'RU' };

/** 带重试的 fetch：直连 Steam 商店偶发超时/重置，单次 6 秒太紧，重试 2 次基本都能成 */
async function fetchRetry(url, timeoutMs = 12000, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr || new Error('网络请求失败');
}

/** 区服 → AppID 的解析缓存（游戏名搜索比较贵，别每次区服都搜一遍） */
const appIdCache = new Map(); // term -> { appId, at }

async function resolveAppId(term, cc, lang) {
  const key = String(term).trim().toLowerCase();
  const cached = appIdCache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.appId;
  const sUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
    term
  )}&l=${lang}&cc=${cc}`;
  const sRes = await fetchRetry(sUrl, 10000, 1);
  const sJson = await sRes.json();
  let appId = 0;
  if (sJson && sJson.items && sJson.items.length) {
    appId = Number(sJson.items[0].id);
  }
  if (appId) appIdCache.set(key, { appId, at: Date.now() });
  return appId;
}

/**
 * 多区服价格对比（不需要任何 API Key）
 * Steam 官方 appdetails 用 ?cc= 就能查任意区服，这里并发 9 个常用区，
 * 10 分钟缓存，单个区失败不影响其它区的展示。
 */
const MULTI_REGIONS = [
  { cc: 'cn', label: '🇨🇳 中国大陆', lang: 'schinese' },
  { cc: 'hk', label: '🇭🇰 中国香港', lang: 'tchinese' },
  { cc: 'tw', label: '🇹🇼 中国台湾', lang: 'tchinese' },
  { cc: 'us', label: '🇺🇸 美国', lang: 'english' },
  { cc: 'jp', label: '🇯🇵 日本', lang: 'japanese' },
  { cc: 'kr', label: '🇰🇷 韩国', lang: 'koreana' },
  { cc: 'ru', label: '🇷🇺 俄罗斯', lang: 'russian' },
  { cc: 'tr', label: '🇹🇷 土耳其', lang: 'turkish' },
  { cc: 'ar', label: '🇦🇷 阿根廷', lang: 'spanish' },
  { cc: 'br', label: '🇧🇷 巴西', lang: 'portuguese' },
];

/**
 * CheapShark 历史最低价（免费无 Key，需要带应用标识的 User-Agent）。
 * 链路：/deals?steamAppID=X 拿当前跨店最低 → /deals?id= 拿 cheapestPrice 史低。
 * 失败返回 null（不阻塞区服价格展示）。
 */
const CS_UA = 'SteamDesk/2.6.67 (+https://github.com/kaynai1/steamdeck)';
const csCache = new Map(); // appId -> { at, data }

async function fetchHistoryLow(appId) {
  const hit = csCache.get(appId);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  let data = null;
  try {
    const listRes = await fetch(`https://www.cheapshark.com/api/1.0/deals?steamAppID=${appId}&sortBy=Price`, {
      headers: { 'User-Agent': CS_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const list = await listRes.json();
    if (Array.isArray(list) && list.length) {
      const d0 = list[0];
      data = { currentLowestUsd: Number(d0.salePrice) || null, store: `store ${d0.storeID}` };
      const detRes = await fetch(`https://www.cheapshark.com/api/1.0/deals?id=${d0.dealID}`, {
        headers: { 'User-Agent': CS_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      const det = await detRes.json();
      const ever = det && det.cheapestPrice;
      if (ever && ever.price != null) {
        data.everUsd = Number(ever.price);
        data.everAt = Number(ever.date) ? Number(ever.date) * 1000 : 0;
      }
    }
  } catch {
    data = null;
  }
  csCache.set(appId, { at: Date.now(), data });
  return data;
}

const regionCache = new Map(); // appId -> { at, rows: [] }

async function queryMultiRegionPrice(appIdOrSearch) {
  let appId = Number(appIdOrSearch);
  if (!appId || isNaN(appId)) {
    appId = await resolveAppId(String(appIdOrSearch), 'cn', 'schinese');
  }
  if (!appId) throw new Error('未找到匹配的 Steam 游戏，请输入正确的 AppID 或游戏名称');

  const cached = regionCache.get(appId);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    return { appId, fromCache: true, at: cached.at, ...cached.full };
  }

  // 并行：各区价格 + CheapShark 史低
  const [results, history] = await Promise.all([
    Promise.allSettled(
      MULTI_REGIONS.map(async (r) => {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${r.cc}&l=${r.lang}&filters=basic,price_overview`;
        const res = await fetchRetry(url, 12000, 1);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const d = json[String(appId)];
        if (!d || !d.success || !d.data) throw new Error('商店未收录');
        const data = d.data;
        const po = data.price_overview || null;
        return {
          cc: r.cc,
          region: r.label,
          name: data.name || '',
          isFree: Boolean(data.is_free),
          currency: po ? po.currency : '',
          finalFormatted: data.is_free ? '免费' : po ? po.final_formatted : '未定价',
          initialFormatted: po ? po.initial_formatted : '',
          finalYuan: po ? po.final / 100 : 0,
          discountPercent: po ? po.discount_percent || 0 : 0,
          isUnavailable: !po && !data.is_free,
        };
      })
    ),
    fetchHistoryLow(appId),
  ]);

  // 汇率换算：一次拿汇率表，逐区换算人民币参考价
  let fx = null;
  try {
    fx = await require('./fxRates').ratesPerUsd();
  } catch {
    fx = null;
  }
  const cnyPerUsd = fx && fx.rates ? fx.rates.CNY : null;
  const toCnyOf = (finalYuanNum, currency) => {
    const cur = String(currency || '').toUpperCase();
    const v = Number(finalYuanNum);
    if (!Number.isFinite(v) || !fx || !fx.rates) return null;
    if (cur === 'CNY') return Math.round(v * 100) / 100;
    const perUsd = fx.rates[cur];
    if (!perUsd || !cnyPerUsd) return null;
    return Math.round((v / perUsd) * cnyPerUsd * 100) / 100;
  };

  const rows = MULTI_REGIONS.map((r, i) => {
    const res = results[i];
    if (res.status === 'fulfilled') {
      const row = { ok: true, ...res.value };
      row.cny = toCnyOf(row.finalYuan, row.currency);
      return row;
    }
    return { ok: false, cc: r.cc, region: r.label, error: (res.reason && res.reason.message) || '查询失败' };
  });

  // 史低换算人民币
  let historyOut = null;
  if (history) {
    historyOut = { ...history };
    if (cnyPerUsd && history.everUsd != null) historyOut.everCny = Math.round(history.everUsd * cnyPerUsd * 100) / 100;
    if (cnyPerUsd && history.currentLowestUsd != null) historyOut.currentLowestCny = Math.round(history.currentLowestUsd * cnyPerUsd * 100) / 100;
  }

  const full = {
    rows,
    history: historyOut,
    fxNote: fx ? fx.source : '',
    fxAt: fx ? Date.now() : 0,
  };
  regionCache.set(appId, { at: Date.now(), full });
  return { appId, fromCache: false, at: Date.now(), ...full };
}

async function queryStorePrice(appIdOrSearch, opts = {}) {
  let appId = Number(appIdOrSearch);
  const cc = REGION_CC[String(opts.region || 'CN').toUpperCase()] || 'CN';
  const lang = cc === 'CN' ? 'schinese' : 'english';

  // 如果输入的是游戏名，先走 Steam 商店搜索建议拿 AppID（带重试，之前 6 秒单次太容易超时）
  if (!appId || isNaN(appId)) {
    appId = await resolveAppId(appIdOrSearch, cc, lang);
  }

  if (!appId || isNaN(appId) || appId <= 0) {
    throw new Error('未找到匹配的 Steam 游戏，请输入正确的 AppID 或游戏名称');
  }

  const detailUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=${lang}&filters=basic,price_overview,release_date,platforms`;
  const r = await fetchRetry(detailUrl, 12000, 2);

  if (!r.ok) {
    throw new Error(`Steam 商店接口响应异常 (HTTP ${r.status})`);
  }

  const json = await r.json();
  const d = json[String(appId)];
  if (!d || !d.success || !d.data) {
    throw new Error(`未查到 AppID ${appId} 的商店详情，可能是锁区或非公开应用`);
  }

  const data = d.data;
  const isFree = Boolean(data.is_free);
  const po = data.price_overview || {};

  return {
    appId,
    name: data.name || `App ${appId}`,
    isFree,
    currency: po.currency || 'CNY',
    initialPriceYuan: po.initial ? po.initial / 100 : 0,
    finalPriceYuan: isFree ? 0 : po.final ? po.final / 100 : 0,
    initialPriceFormatted: po.initial_formatted || (isFree ? '免费' : '未定价'),
    finalPriceFormatted: isFree ? '免费开玩' : po.final_formatted || '未定价',
    discountPercent: po.discount_percent || 0,
    headerImage: data.header_image || `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`,
    releaseDate: (data.release_date && data.release_date.date) || '待定',
    comingSoon: Boolean(data.release_date && data.release_date.coming_soon),
    platforms: data.platforms || { windows: true },
    region: cc,
    type: data.type || 'game',
    steamStoreUrl: `https://store.steampowered.com/app/${appId}/`,
  };
}

module.exports = {
  getIdleDropGames,
  queryStorePrice,
  queryMultiRegionPrice,
};
