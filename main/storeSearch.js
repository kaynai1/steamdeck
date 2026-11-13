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

async function queryStorePrice(appIdOrSearch, opts = {}) {
  let appId = Number(appIdOrSearch);
  const cc = REGION_CC[String(opts.region || 'CN').toUpperCase()] || 'CN';
  const lang = cc === 'CN' ? 'schinese' : 'english';

  // 如果输入的是游戏名，先走 Steam 商店搜索建议拿 AppID
  if (!appId || isNaN(appId)) {
    try {
      const sUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
        appIdOrSearch
      )}&l=${lang}&cc=${cc}`;
      const sRes = await fetch(sUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      const sJson = await sRes.json();
      if (sJson && sJson.items && sJson.items.length) {
        appId = Number(sJson.items[0].id);
      }
    } catch {
      /* search failed, fallback */
    }
  }

  if (!appId || isNaN(appId) || appId <= 0) {
    throw new Error('未找到匹配的 Steam 游戏，请输入正确的 AppID 或游戏名称');
  }

  const detailUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=${lang}&filters=basic,price_overview,release_date,platforms`;
  const r = await fetch(detailUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });

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
};
