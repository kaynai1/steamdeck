'use strict';

/**
 * 汇率换算（用于各区服价格 → 人民币参考）
 *
 * 数据源：open.er-api.com 免费公开接口（无需 Key，含 TWD/RUB/BRL 等全币种）。
 * 失败时回落到内置近似汇率（手工维护的参考值），并标注"近似"。
 * 缓存 12 小时，避免每次查价都打接口。
 */

const https = require('https');

const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const CACHE_MS = 12 * 3600 * 1000;

/** 内置近似兜底（每 1 USD，参考近年均值，仅在网络失败时用） */
const FALLBACK_PER_USD = {
  CNY: 7.2,
  HKD: 7.8,
  TWD: 32,
  JPY: 152,
  KRW: 1360,
  RUB: 90,
  TRY: 34,
  ARS: 1000,
  BRL: 5.4,
  EUR: 0.92,
  USD: 1,
};

let cache = { at: 0, rates: null, source: '' };

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'User-Agent': 'SteamDesk-FX' }, timeout: 10000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 200000) text += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(text);
          if (res.statusCode >= 200 && res.statusCode < 300 && json && json.rates) resolve(json);
          else reject(new Error(`HTTP ${res.statusCode}`));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 拿到以 USD 为基准的汇率表（每 1 USD 兑 X） */
async function ratesPerUsd() {
  if (cache.rates && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const json = await getJson(FX_URL);
    cache = { at: Date.now(), rates: json.rates, source: '实时汇率' };
  } catch {
    if (!cache.rates) cache = { at: Date.now(), rates: FALLBACK_PER_USD, source: '近似汇率' };
    else cache.source = '近似汇率';
  }
  return cache;
}

/**
 * 任意币种金额 → 人民币。
 * @returns {cny: number|null, note: string} note 标注实时/近似；CNY 直接原值。
 */
async function toCny(amount, currency) {
  const cur = String(currency || '').toUpperCase();
  const v = Number(amount);
  if (!Number.isFinite(v)) return { cny: null, note: '' };
  if (cur === 'CNY') return { cny: v, note: '' };
  const { rates, source } = await ratesPerUsd();
  const perUsd = rates[cur] || rates[`${cur}`];
  const cnyPerUsd = rates.CNY;
  if (!perUsd || !cnyPerUsd) return { cny: null, note: '' };
  const usd = v / perUsd;
  return { cny: Math.round(usd * cnyPerUsd * 100) / 100, note: source };
}

module.exports = { toCny, ratesPerUsd, FALLBACK_PER_USD };