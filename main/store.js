'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

let baseDir = null;
let settingsFile = null;
let cacheFile = null;
let secretsFile = null;

const DEFAULTS = {
  steamPath: null,
  quoteIntervalMs: 1800,
  quoteCacheMs: 10 * 60 * 1000,
  sellIntervalMs: 4000,
  confirmEach: true,
  autoKeepAlive: true,
  closeSteamBeforeSwitch: true,
  openInventoryAfterSwitch: false,
  encryptSsfn: true,
  priceStrategy: 'low-1',
  guardMinRatio: 0.7,
  theme: 'dark',
  // 用户自己添加的 AppID：[{ appId, name, ctx, tradeable, addedAt }]
  // 注册表覆盖不全时靠它兜底，且永久保存，下次开软件还在
  customApps: [],
  // 界面缩放（用户反馈整体太小，可自行微调并记住）
  uiZoom: 1.08,
  // 发现新的免费游戏时弹系统通知（托盘菜单里可关）
  freeNotify: true,
  // 价格提醒：[{ id, appId, marketHashName, name, dir, price, ... }]
  priceAlerts: [],
  // 库存变动监控（每 6 小时对比一次快照）
  invWatch: true,
  // 风险熔断：单件价格上限 / 低于成本比例 / 每日改价次数 / 单次批量件数
  guardEnabled: true,
  maxPriceYuan: 5000,
  minCostRatio: 0.5,
  maxDailyReprice: 200,
  maxBatch: 50,
  // 挂单自动补货（默认关闭，用户在挂单页手动开启）
  restock: false,
  restockDailyCap: 10,
  restockMaxPerRun: 3,
  restockIntervalMin: 20,
  // 账号定时巡检（每 3 小时）
  healthWatch: true,
  // 每日经营简报
  reportNotify: true,
  reportHour: 21,
  // 通知外发：none / telegram / wecom / dingtalk / serverchan / webhook / qqbot
  notifyChannel: 'none',
  notifyConfig: { tgChat: '' },
  // QQ 机器人（q.qq.com）：AppSecret 存在加密区，这里只放非敏感的标识
  qqAppId: '',
  qqGuildId: '',
  qqChannelId: '',
  qqChannelName: '',
  // 卖出通知：轮询成交历史，发现新卖出就推送
  saleWatchEnabled: false,
  saleWatchIntervalMin: 10,
  // 查价与挂机：商店区服、商店价格提醒、挂机监控列表、掉落提醒
  storeRegion: 'CN',
  storeAlerts: [],
  idleWatchApps: [],
  dropWatchEnabled: false,
  dropWatchMinYuan: 5,
  dropWatchIntervalMin: 30,
  dropIgnoreKeywords: '',
  notifyDesktop: true,
  notifyLastAt: 0,
  notifyLastError: '',
  // 维护模式：暂停补货、守价、巡检等后台自动任务（手动操作不受影响）
  automationPaused: false,
  // 自动化时段：开启后，补货/阶梯降价/自动守价只在这个小时段内跑（支持跨午夜）
  autoWindowEnabled: false,
  autoWindowStart: 8,
  autoWindowEnd: 23,
  // 风控名单：按市场名（不区分大小写，支持片段）匹配
  riskBlacklist: [],
  riskWhitelist: [],
  // 物品级策略：{ marketHashName: { auto: false, minPrice: 12.5 } }
  itemPolicies: {},
  // 阶梯降价（滞销自动清仓）
  ladderEnabled: false,
  ladderDays: 7,
  ladderStepPct: 5,
  ladderMaxSteps: 3,
  ladderMaxPerRun: 5,
  ladderIntervalMin: 60,
  // 更新检查：用户自填的 JSON 地址（version / url / notes）
  updateUrl: '',
  updateLastCheckAt: 0,
  updateLastVersion: '',
  // 窗口位置与大小（关闭/拖动时自动保存）
  winBounds: null,
  // 首次使用向导是否已完成（完成后不再自动弹出）
  wizardDone: false,
  // BUFF 手动比价：手续费率（%）与按物品记录的手填价格 { marketHashName: { price, at } }
  buffFeePct: 2.5,
  buffPrices: {},
  // 自动守价：被别人压价时跟到最低价 -0.01
  priceGuardEnabled: false,
  priceGuardNotifyOnly: false,
  priceGuardMinGap: 0.05,
  priceGuardMaxPerRun: 5,
  priceGuardDailyCap: 50,
  priceGuardIntervalMin: 30,
  // 买入成交自动记成本：只补没有成本的物品；overwrite 才覆盖手工填过的
  autoCostFromTrades: true,
  autoCostOverwrite: false,
  // 免打扰时段（只影响外发与桌面通知，后台任务照常跑）
  quietHoursEnabled: false,
  quietStart: 23,
  quietEnd: 8,
  // 每日经营目标（0 表示不设）
  dailyGoalYuan: 0,
  // 自动定价的尾数策略：none / 99 / 98 / int
  priceEnding: 'none',
  // 登录态预警：定期访问社区「我的主页」，失效时通知
  sessionWarnEnabled: true,
  // 交易报价提醒：Steam Web API Key（用户自己申请）+ 轮询间隔
  tradeWatchEnabled: false,
  steamApiKey: '',
  tradeWatchIntervalMin: 10,
  // AI 助手：兼容 OpenAI 的接口，默认关闭
  aiEnabled: false,
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  // 浏览器扩展：允许本机扩展把 Steam 市场当前价发进来
  extEnabled: false,
};

let settings = { ...DEFAULTS };
let cache = { quotes: {}, listings: {}, inventory: {} };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function init(userDataDir) {
  baseDir = userDataDir;
  fs.mkdirSync(baseDir, { recursive: true });
  settingsFile = path.join(baseDir, 'settings.json');
  cacheFile = path.join(baseDir, 'cache.json');
  secretsFile = path.join(baseDir, 'secrets.bin');

  settings = { ...DEFAULTS, ...readJson(settingsFile, {}) };
  const loaded = readJson(cacheFile, null);
  if (loaded && typeof loaded === 'object') cache = { quotes: {}, listings: {}, inventory: {}, ...loaded };
}

function getSettings() {
  return { ...settings };
}

function setSettings(patch) {
  settings = { ...settings, ...patch };
  writeJson(settingsFile, settings);
  return { ...settings };
}

/* -------------------------------- 行情缓存 -------------------------------- */

function getQuote(key) {
  const rec = cache.quotes[key];
  if (!rec) return null;
  if (Date.now() - rec.at > settings.quoteCacheMs) return { ...rec, stale: true };
  return { ...rec, stale: false };
}

function setQuote(key, data) {
  cache.quotes[key] = { ...data, at: Date.now() };
}

function saveCache() {
  writeJson(cacheFile, cache);
}

function clearExpiredQuotes() {
  const limit = Date.now() - settings.quoteCacheMs;
  for (const [k, v] of Object.entries(cache.quotes)) {
    if (!v || v.at < limit) delete cache.quotes[k];
  }
}

function getListingMap(steamId, appId) {
  return cache.listings[`${steamId}:${appId}`] || {};
}

function setListingMap(steamId, appId, map) {
  cache.listings[`${steamId}:${appId}`] = { ...map, _at: Date.now() };
}

function getInventoryCache(steamId, appId, contextId) {
  return cache.inventory[`${steamId}:${appId}:${contextId}`] || null;
}

function setInventoryCache(steamId, appId, contextId, payload) {
  cache.inventory[`${steamId}:${appId}:${contextId}`] = { ...payload, _at: Date.now() };
}

/* -------------------------------- 凭证加密 -------------------------------- */

/**
 * 用系统密钥加密敏感数据（Windows DPAPI / macOS Keychain）。
 * 若系统不支持加密，则拒绝写入而不是明文落盘。
 */
function encryptSecret(plain) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw Object.assign(new Error('系统加密不可用，已拒绝以明文保存凭证。请检查系统密钥环。'), {
      code: 'E_NO_ENCRYPT',
    });
  }
  return safeStorage.encryptString(plain);
}

function saveSecret(name, plain) {
  const buf = encryptSecret(plain);
  const all = readSecrets();
  all[name] = buf.toString('base64');
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(all), { mode: 0o600 });
}

function readSecret(name) {
  const all = readSecrets();
  if (!all[name]) return null;
  try {
    return safeStorage.decryptString(Buffer.from(all[name], 'base64'));
  } catch {
    return null;
  }
}

function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  } catch {
    return {};
  }
}

function removeSecret(name) {
  const all = readSecrets();
  if (!all[name]) return;
  delete all[name];
  fs.writeFileSync(secretsFile, JSON.stringify(all), { mode: 0o600 });
}

module.exports = {
  init,
  getSettings,
  setSettings,
  DEFAULTS,
  getQuote,
  setQuote,
  saveCache,
  clearExpiredQuotes,
  getListingMap,
  setListingMap,
  getInventoryCache,
  setInventoryCache,
  saveSecret,
  readSecret,
  removeSecret,
  get baseDir() { return baseDir; },
};
