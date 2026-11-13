'use strict';

const { EventEmitter } = require('events');
const store = require('./store');
const session = require('./session');
const market = require('./market');
const bridge = require('./steamBridge');
const imageProxy = require('./imageProxy');
const logger = require('./logger');

const emitter = new EventEmitter();

/**
 * 上架模块核心约束（务必读）：
 *  1. POST /market/sellitem/ 的 price 单位是"分"，且是**卖家到手**金额，
 *     Steam 会在这个数上再加 5% + 10% 手续费（各自最低 ¥0.07）才是买家实付。
 *     实测：传 30 分 → 买家付 44 分。所以界面上的"挂单价"（买家实付）
 *     必须先反算成到手金额再提交，否则每件都会挂贵 0.14 元。
 *     1286.00 元 → 128600。这里统一用"元"进出，换算只在本文件内发生。
 *  2. assetid 是单件粒度。有 4 件就要发 4 次请求，没有批量接口。
 *  3. 改价没有接口，只能 removemarketitem 下架后重新上架。
 *     所以"改价"在业务上等于"下架 + 上架"，需要记录新 listingid。
 *  4. 成功返回 { success: true } 但不含 listingid，
 *     必须再从 /market/mylistings/render/ 拉一次并建立 assetid → listingid 映射。
 */

let running = false;
let cancelFlag = false;
let lastProgress = { state: 'idle', total: 0, done: 0, ok: 0, fail: 0, message: '', current: null };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

function emitProgress(patch) {
  lastProgress = { ...lastProgress, ...patch };
  emitter.emit('progress', lastProgress);
  return lastProgress;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildCookieHeader() {
  const ses = await session.getSession();
  if (!ses || !ses.cookies || !ses.cookies.steamLoginSecure) {
    throw Object.assign(
      new Error('没有可用的登录会话。请先在账号管理里完成网页登录，上架必须带登录 Cookie。'),
      { code: 'E_NO_SESSION' }
    );
  }
  // 只取社区域 Cookie（getSession 已保证是社区域，不会混入商店域同名值）
  return {
    cookie: Object.entries(ses.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
    sessionId: ses.cookies.sessionid,
    steamId: ses.steamId,
  };
}

/**
 * 生成上架计划：把用户勾选的物品整理成待执行队列，
 * 并在这一步就把"不能上架的"拦掉，不要等请求失败才发现。
 */
async function buildPlan(payload) {
  const {
    items = [],
    strategy = 'low-1',
    guardMinRatio = 0.7,
    steamId = '',
    source = '',
  } = payload || {};
  const risk = require('./risk');

  const plan = [];
  for (const it of items) {
    const row = {
      assetId: it.assetId,
      appId: it.appId || 730,
      contextId: it.contextId || '2',
      marketHashName: it.marketHashName,
      name: it.name,
      qty: 1,
      priceYuan: Number(it.priceYuan) || 0,
      lowestPrice: Number(it.lowestPrice) || 0,
      medianPrice: Number(it.medianPrice) || 0,
      netYuan: 0,
      blocking: null,
      warn: null,
    };

    // 1) 可售性拦截：社区市场只看 marketable。
    //    tradable=false 只代表玩家间不能交易（常见于刚获得的物品），
    //    这类物品在 Steam 官网上本来就能直接上架，不能拦。
    if (it.marketable === false) {
      row.blocking = '该物品不能在 Steam 市场出售';
    }

    // 2) 价格计算
    if (!row.blocking) {
      if (!row.priceYuan) {
        const low = row.lowestPrice;
        const med = row.medianPrice;
        if (strategy === 'low-1' && low > 0) row.priceYuan = Math.round((low - 0.01) * 100) / 100;
        else if (strategy === 'low-97' && low > 0) row.priceYuan = Math.round(low * 0.97 * 100) / 100;
        else if (strategy === 'low-95' && low > 0) row.priceYuan = Math.round(low * 0.95 * 100) / 100;
        else if (strategy === 'med-102' && med > 0) row.priceYuan = Math.round(med * 1.02 * 100) / 100;
      }

      if (!row.priceYuan || row.priceYuan <= 0.02) {
        row.blocking = '无法确定价格：市场无行情数据，请手动填写';
      }
    }

    // 3) 价格保护：偏离最低价过多时拦住（防止少打一个零）
    if (!row.blocking && row.lowestPrice > 0) {
      const ratio = row.priceYuan / row.lowestPrice;
      if (ratio < guardMinRatio) {
        row.blocking = `价格偏低：${row.priceYuan.toFixed(2)} 元仅为市场最低价的 ${(ratio * 100).toFixed(0)}%，已按保护规则拦截`;
      } else if (ratio > 1.5) {
        row.warn = `比市场最低价高 ${((ratio - 1) * 100).toFixed(0)}%，可能长期卖不掉`;
      }
    }

    // 4) 物品级策略：只约束后台自动化，手动操作仍由用户自己决定
    if (!row.blocking) {
      const autoSource = /^(ladder|guard|restock)$/.test(String(source || ''));
      const pol =
        autoSource && row.marketHashName ? (store.getSettings().itemPolicies || {})[row.marketHashName] : null;
      if (pol) {
        if (pol.auto === false) {
          row.blocking = '这件物品已关闭自动改价（物品策略）';
        } else if (Number(pol.minPrice) > 0 && row.priceYuan < Number(pol.minPrice)) {
          row.blocking = `低于这件物品的最低自动价 ¥${Number(pol.minPrice).toFixed(2)}（物品策略）`;
        }
      }
    }

    // 5) 风控：单件价格上限 / 低于成本下限 / 黑名单。放在最后，前面的拦截信息优先
    if (!row.blocking) {
      const reason = risk.checkItem({
        steamId,
        priceYuan: row.priceYuan,
        lowestPrice: row.lowestPrice,
        marketHashName: row.marketHashName,
        source,
      });
      if (reason) row.blocking = reason;
    }

    row.netYuan = row.blocking ? 0 : market.netOf(row.priceYuan);
    plan.push(row);
  }

  const executable = plan.filter((r) => !r.blocking);
  const blocked = plan.filter((r) => r.blocking);
  const totalNet = executable.reduce((s, r) => s + r.netYuan, 0);
  const totalGross = executable.reduce((s, r) => s + r.priceYuan, 0);

  return {
    plan,
    executable,
    blocked,
    summary: {
      total: plan.length,
      executable: executable.length,
      blocked: blocked.length,
      totalGross: Math.round(totalGross * 100) / 100,
      totalNet: Math.round(totalNet * 100) / 100,
      estimatedSeconds: executable.length * Math.ceil((store.getSettings().sellIntervalMs || 4000) / 1000 + 1.2),
    },
  };
}

/** 单件上架 */
async function sellOne(ctx, row) {
  // 界面上的 priceYuan 是"买家实付"，sellitem 要的是"卖家到手"，中间要扣手续费。
  const priceInCents = market.sellerCentsFor(Math.round(row.priceYuan * 100));
  if (priceInCents < 1) {
    throw Object.assign(
      new Error('挂单价太低：扣完最低手续费后卖家没有到手金额，请调到 0.15 元以上'),
      { code: 'E_PRICE_TOO_LOW' }
    );
  }

  // 走社区页面通道：在 steamcommunity.com 页内 POST，
  // Cookie / Origin / Referer / Sec-Fetch 由 Chromium 原生带上，等价于网页点"出售"。
  // sessionid 不再由主进程拼：通道会在页面里现读 g_sessionID / document.cookie，
  // 保证表单字段和浏览器实际发出的 Cookie 是同一份（否则 Steam 会回"会话校验失败"）。
  const res = await bridge.postForm(
    'https://steamcommunity.com/market/sellitem/',
    {
      appid: String(row.appId),
      contextid: String(row.contextId),
      assetid: String(row.assetId),
      amount: '1',
      price: String(priceInCents),
    },
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    }
  );

  if (res.status === 429) {
    throw Object.assign(new Error('被限流（429）'), { code: 'E_RATE_LIMIT', retryable: true });
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('登录状态失效或无权限，请重新登录'), { code: 'E_AUTH' });
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`返回内容不是 JSON（可能是登录页跳转）：${text.slice(0, 80)}`), {
      code: 'E_BAD_RESPONSE',
    });
  }

  if (json && (json.success === 1 || json.success === true)) {
    /**
     * ★ 关键：success=true 不代表已经挂上 ★
     * 开了 Steam 手机令牌的账号，挂单会停在"待确认"状态，
     * Steam 在同一个响应里用 needs_mobile_confirmation 告诉你。
     * 老版本直接当成成功，用户看到的"已上架"其实永远不会上架，
     * 必须去手机点确认——这就是"点了交易还是要手机上点"的原因。
     */
    return {
      ok: true,
      needsMobileConfirm: Boolean(json.needs_mobile_confirmation),
      needsEmailConfirm: Boolean(json.needs_email_confirmation),
    };
  }

  const msg = (json && json.message) || '未知错误';
  // 会话类错误单独标码：调用方会刷新通道后重试一次
  const sessionIssue = /session|会话|expired|not logged in/i.test(msg);
  const channel = res.channel || 'page';
  const sidTxt = res.sessionIdLen ? `sessionid ${res.sessionIdLen} 位` : '没取到 sessionid';
  throw Object.assign(
    new Error(sessionIssue ? `${humanizeSellError(msg)}（通道 ${channel}，${sidTxt}）` : humanizeSellError(msg)),
    {
      code: sessionIssue ? 'E_SESSION' : 'E_SELL_FAILED',
      raw: msg,
    }
  );
}

function humanizeSellError(msg) {
  const m = String(msg);
  if (/not marketable/i.test(m)) return '该物品不可在市场出售';
  if (/trade hold|tradable/i.test(m)) return '物品仍在交易冷却期，暂时不能出售';
  if (/already.*(listed|sold)/i.test(m)) return '该物品已在出售或已售出';
  if (/price/i.test(m)) return '价格不合法（可能超出允许范围）';
  if (/session/i.test(m)) return '会话校验失败，请重新登录后再试';
  if (/limit/i.test(m)) return '已超出上架数量上限';
  return m;
}

/**
 * 执行上架队列。
 * 逐件执行，失败停在当前件并写明原因，绝不静默跳过或自动重挂（避免重复上架）。
 */
async function runQueue(payload) {
  if (running) throw Object.assign(new Error('已有上架任务正在进行'), { code: 'E_BUSY' });

  const settings = store.getSettings();
  const { items = [], strategy = 'low-1', guardMinRatio, steamId = '', source = '' } = payload || {};
  const risk = require('./risk');
  const limits = risk.limits();

  if (limits.enabled && items.length > limits.maxBatch) {
    throw Object.assign(
      new Error(`单次最多上架 ${limits.maxBatch} 件（风控限制），请分批操作`),
      { code: 'E_RISK_BATCH' }
    );
  }
  if (
    limits.enabled &&
    (source === 'reprice' || source === 'ladder' || source === 'guard') &&
    limits.maxDailyReprice > 0
  ) {
    const used = risk.status().repricedToday;
    if (used >= limits.maxDailyReprice) {
      throw Object.assign(
        new Error(`今天的改价次数已达上限 ${limits.maxDailyReprice} 次，明天再试或到设置里调整`),
        { code: 'E_RISK_DAILY' }
      );
    }
  }

  const built = await buildPlan({
    items,
    strategy,
    guardMinRatio: guardMinRatio ?? settings.guardMinRatio,
    steamId,
    source,
  });

  const queue = built.executable;
  if (!queue.length) {
    return { ...built, executed: [], message: '没有可执行的物品（全部被拦截）' };
  }

  const ctx = await buildCookieHeader();

  // 上架前先把社区通道刷新一次：让 Steam 重新下发 sessionid，
  // 页面里的 g_sessionID 与 Cookie 必然同源，避免长时间挂着的旧页面导致 Session mismatch
  try {
    // 打开市场页而不是社区首页：Steam 会按市场上下文下发 sessionid，
    // 页面上的 g_sessionID 就是 sellitem 该用的那个值
    await bridge.refresh('https://steamcommunity.com/market/');
  } catch { /* 刷新失败不阻断，后续仍会尝试 */ }

  running = true;
  cancelFlag = false;
  const executed = [];
  let ok = 0;
  let fail = 0;
  let pendingConfirm = 0;

  emitProgress({
    state: 'running',
    total: queue.length,
    done: 0,
    ok: 0,
    fail: 0,
    message: '开始上架',
    current: null,
  });

  try {
    for (let i = 0; i < queue.length; i++) {
      if (cancelFlag) break;
      const row = queue[i];
      emitProgress({
        state: 'running',
        current: { index: i + 1, name: row.name, priceYuan: row.priceYuan, assetId: row.assetId },
        message: `上架中 ${i + 1}/${queue.length}：${row.name}`,
      });

      let attempt = 0;
      let done = false;
      let lastErr = null;
      let refreshed = false;

      while (attempt < 3 && !done) {
        attempt++;
        try {
          const res = await sellOne(ctx, row);
          done = true;
          if (res && res.needsMobileConfirm) {
            row.needsMobileConfirm = true;
            pendingConfirm += 1;
          }
        } catch (err) {
          lastErr = err;
          // 会话字段与 Cookie 错位时，重新导航社区首页让 Steam 下发新 Cookie，再试一次
          if (err.code === 'E_SESSION' && !refreshed) {
            refreshed = true;
            emitProgress({ state: 'running', message: `会话已失效，刷新后重试：${row.name}` });
            try {
              await bridge.refresh();
            } catch { /* 刷新失败就按原错误继续走后面逻辑 */ }
            continue;
          }
          if (err.code === 'E_AUTH') {
            // 授权问题重试没意义，直接终止整个队列
            executed.push({ ...row, status: 'failed', error: err.message });
            fail++;
            emitProgress({ state: 'aborted', message: `登录失效，队列已中止：${err.message}` });
            throw err;
          }
          if (err.retryable && attempt < 3) {
            const backoff = 8000 * attempt;
            emitProgress({
              state: 'running',
              message: `限流，退避 ${backoff / 1000}s 后重试（${attempt}/3）：${row.name}`,
            });
            await sleep(backoff);
            continue;
          }
          break;
        }
      }

      if (done) {
        executed.push({ ...row, status: 'listed' });
        ok++;
      } else {
        executed.push({
          ...row,
          status: 'failed',
          // 附上 Steam 原文，下次再失败时用户看到的就是可定位的信息
          error: lastErr
            ? lastErr.raw && lastErr.raw !== lastErr.message
              ? `${lastErr.message}（Steam 原文：${lastErr.raw}）`
              : lastErr.message
            : '未知错误',
        });
        fail++;
      }

      emitProgress({
        state: 'running',
        done: i + 1,
        ok,
        fail,
        message: done ? `已上架 ${row.name}` : `失败：${row.name}`,
      });

      if (i < queue.length - 1) await sleep(settings.sellIntervalMs);
    }

    // 上架完拉一次挂单列表，建立 assetid → listingid 映射
    let listingMap = null;
    if (ok > 0) {
      emitProgress({ state: 'syncing', message: '同步挂单列表，确认 listingid' });
      try {
        // 传 null：查全部游戏，别只查这一批的 appid
        const synced = await syncListings(ctx, null);
        listingMap = synced.map;
      } catch (err) {
        emitProgress({ state: 'running', message: `挂单列表同步失败（不影响已上架结果）：${err.message}` });
      }
    }

    /**
     * 待确认的挂单：导入过 maFile 的话直接在软件里批准。
     * 没导入就保持"待确认"，由渲染层引导用户去手机确认。
     */
    let autoConfirmed = 0;
    let confirmError = null;
    if (pendingConfirm > 0) {
      try {
        const guard = require('./steamGuard');
        const st = await guard.status();
        if (st.linked) {
          emitProgress({ state: 'syncing', message: `正在软件内确认 ${pendingConfirm} 件挂单…` });
          /*
           * sellitem 成功后，Steam 那边生成"待确认"项有 1~3 秒延迟，
           * 立刻查 getlist 常常是空的。所以最多轮询 4 次，
           * 直到确认数够了或者列表里彻底没有市场挂单为止。
           */
          for (let attempt = 0; attempt < 4 && autoConfirmed < pendingConfirm; attempt++) {
            if (attempt) await sleep(1500);
            const r = await guard.confirmMarketListings();
            autoConfirmed += r.confirmed || 0;
            if (r.failed && r.failed.length) {
              confirmError = r.failed[0].error;
            }
            // 列表里一条市场挂单都没有 → 还没生成，等下一次轮询
            if (!r.targeted) continue;
            if (r.confirmed) confirmError = null;
          }
          if (!autoConfirmed) {
            confirmError = confirmError || 'Steam 暂未生成确认项，可稍后在「市场挂单」点确认';
          }
          if (autoConfirmed) {
            // 确认后重新拉一次挂单，页面上立刻能看到
            try {
              await sleep(800);
              await syncListings(ctx, null);
            } catch { /* 同步失败不影响上架结果 */ }
          }
        }
      } catch (err) {
        confirmError = err.message;
      }
    }

    const state = cancelFlag ? 'cancelled' : 'done';
    emitProgress({
      state,
      needsConfirm: pendingConfirm - autoConfirmed,
      message:
        `完成：成功 ${ok}，失败 ${fail}` +
        (autoConfirmed ? `，已自动确认 ${autoConfirmed} 件` : '') +
        (pendingConfirm - autoConfirmed > 0
          ? `，还有 ${pendingConfirm - autoConfirmed} 件等待确认`
          : ''),
    });

    if ((source === 'reprice' || source === 'ladder' || source === 'guard') && ok > 0) {
      risk.addReprice(ok);
    }

    return {
      ...built,
      executed,
      ok,
      fail,
      pendingConfirm,
      autoConfirmed,
      confirmError,
      cancelled: cancelFlag,
      listingMap,
      message: `成功 ${ok} 件，失败 ${fail} 件`,
    };
  } finally {
    running = false;
    cancelFlag = false;
  }
}

/**
 * 拉取自己的挂单列表。
 *
 * ★ 老版本的问题 ★
 * fetchMyListings(steamId, appId = 730) 一路把 appid=730 传进 mylistings/render，
 * 于是「市场挂单」页只显示 CS2 的挂单：753 的卡牌/背景、其它游戏的饰品
 * 即使上架成功也看不到、下不掉。只有恰好返回 400 才退回不带 appid 的查询。
 *
 * 现在：默认**不带 appid** 查全量（这才符合"我的挂单"的语义），
 * 只在被拒时退回带 appid 的旧参数；并按 asset.appid 记录每件挂单属于哪个游戏。
 * 另外补了翻页 —— mylistings 一次只回 100 条，挂单多了会漏。
 */
/**
 * 从挂单资产里取物品图标。
 * mylistings 给的 icon_url 是完整地址（community.cloudflare.steamstatic.com/economy/image/<hash>/96fx96f），
 * 而库存接口给的是裸 hash —— 两种都要能吃下，统一换成 sdimg://eco/<hash> 走本地代理，
 * 这样渲染层不会因为某个 CDN 域名被墙而整片空白。
 */
function iconUrlOf(asset) {
  const raw = asset && (asset.icon_url || asset.icon_url_large);
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;
  // 完整地址：抠出 /economy/image/ 后面那段 hash
  const m = /\/economy\/image\/([^/?#]+)/.exec(str);
  if (m) return imageProxy.ecoUrl(m[1]);
  // 其它域名的完整地址代理不认，别硬塞进去让前端 404
  if (/^https?:\/\//i.test(str)) return null;
  // 裸 hash（实测形如 IzMF03bk9WpSBq-S-ekoE33L-...，带 - 和 _，不能只用 \w 判断）
  return imageProxy.ecoUrl(str);
}

const MAX_LISTING_PAGES = 10;
const LISTING_PAGE_SIZE = 100;

function buildListingsUrl({ appId, start = 0 }) {
  const url = new URL('https://steamcommunity.com/market/mylistings/render/');
  url.searchParams.set('query', '');
  url.searchParams.set('start', String(start));
  url.searchParams.set('count', String(LISTING_PAGE_SIZE));
  url.searchParams.set('norender', '1');
  url.searchParams.set('cc', 'CN');
  url.searchParams.set('l', 'schinese');
  if (appId) url.searchParams.set('appid', String(appId));
  return url.toString();
}

async function getListingsJson(url) {
  // 走 bridge 让 Cookie 按域自动匹配。
  // 曾经这里返回 400：用错域的凭证请求社区接口，Steam 判定会话无效。
  const res = await bridge.communityFetch(url, {
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`挂单列表返回 ${res.status}`), {
      code: 'E_HTTP',
      status: res.status,
    });
  }
  return res.json();
}

/**
 * @param {number|null} appId 传 null 表示查全部游戏
 * @returns {{ map: object, apps: object, scopeAppId: number|null, total: number }}
 */
async function syncListings(ctx, appId = null) {
  let scopeAppId = appId ? Number(appId) : null;
  let first;
  try {
    first = await getListingsJson(buildListingsUrl({ appId: scopeAppId }));
  } catch (err) {
    if (scopeAppId === null && err.status === 400) {
      // 不带 appid 被拒：退回 730 的旧参数，至少能拿到 CS2 那部分，不让整页不可用
      scopeAppId = 730;
      first = await getListingsJson(buildListingsUrl({ appId: scopeAppId }));
    } else {
      throw err;
    }
  }

  const map = {};
  const apps = {};

  /**
   * ★ /mylistings/render/ 返回的是"扁平"结构，不是网页版那种 listinginfo ★
   * 实测一条长这样：
   *   { listingid:"6233…", price:42, fee:14, steam_fee:7, publisher_fee:7,
   *     status:1, time_created:1792521405,
   *     asset:{ id:"3644…", appid:753, contextid:"6", name:"Ruby 8", … } }
   * 老代码读的是 l.listinginfo.listingid，永远取不到 → 挂单页恒为 0 条，
   * 用户"商城在卖的这儿看不到"。
   *
   * 金额语义也一并修正：
   *   price   = 卖家到手（分）
   *   fee     = Steam + 发行商手续费（分）
   *   买家实付 = price + fee —— 这才是用户填的"挂单价"
   */
  const absorb = (json) => {
    for (const l of (json && json.listings) || []) {
      const asset = l.asset || {};
      const info = l.listinginfo || {};
      const assetId = asset.id || asset.assetid;
      const listingId = l.listingid || info.listingid;
      if (!assetId || !listingId) continue;

      const app = Number(asset.appid) || 753;
      apps[app] = (apps[app] || 0) + 1;

      const cents = (v) => (v == null || v === '' ? null : Number(v));
      const sellerCents = cents(l.converted_price != null ? l.converted_price : l.price);
      const feeCents = cents(l.converted_fee != null ? l.converted_fee : l.fee);
      const grossCents =
        sellerCents == null ? null : sellerCents + (feeCents || 0);

      map[assetId] = {
        listingId,
        appId: app,
        contextId: String(asset.contextid || ''),
        marketHashName: asset.market_hash_name || '',
        name: asset.name || '',
        icon: iconUrlOf(asset),
        // 买家实付 = 挂单价（用户填的那个数）
        price: grossCents == null ? null : grossCents / 100,
        // Steam 实际结算给卖家的金额，比按 15% 估算更准（Steam 有最低手续费）
        netYuan: sellerCents == null ? null : sellerCents / 100,
        feeYuan: feeCents == null ? null : feeCents / 100,
        state: l.status != null ? l.status : info.status != null ? info.status : null,
        createdAt: l.time_created || info.created || null,
      };
    }
  };

  absorb(first);

  let collected = Object.keys(map).length;
  const total = Number(first && first.total_count) || collected;
  let page = 1;
  while (total > collected && page < MAX_LISTING_PAGES) {
    await sleep(700);
    let json;
    try {
      json = await getListingsJson(buildListingsUrl({ appId: scopeAppId, start: collected }));
    } catch {
      break; // 翻页失败就用手上已有的，不把整次同步判为失败
    }
    const before = collected;
    absorb(json);
    collected = Object.keys(map).length;
    if (collected === before) break; // 没有新增，说明已到底
    page++;
  }

  store.setListingMap(ctx.steamId, scopeAppId || 'all', map);
  store.saveCache();
  return { map, apps, scopeAppId, total };
}

/** 获取当前账号的挂单列表（给"市场挂单"页用） */
async function fetchMyListings(steamId, appId = null) {
  const ctx = await buildCookieHeader();
  const r = await syncListings(ctx, appId);
  return {
    steamId: ctx.steamId,
    appId: r.scopeAppId,
    scopeAppId: r.scopeAppId,
    count: Object.keys(r.map).length,
    total: r.total,
    map: r.map,
    apps: r.apps,
  };
}

/**
 * 下架单个挂单
 *
 * ★ 曾经 400 的原因 ★
 * removelisting 是市场写接口，Steam 会校验 Referer 是否来自「市场页」。
 * 通道窗口默认停在社区首页（https://steamcommunity.com/），
 * 从首页上下文发出的 POST 一律被判 400 Bad Request —— 和网页上点「下架」的差别就在这里。
 * 所以下架前先把通道切到 https://steamcommunity.com/market/，失败再强制重开一次。
 */
async function removeListing(steamId, listingId) {
  const id = String(listingId == null ? '' : listingId).trim();
  if (!/^\d{5,}$/.test(id)) {
    throw Object.assign(new Error('挂单编号不对，请刷新挂单列表后重试'), { code: 'E_BAD_ID' });
  }

  const url = 'https://steamcommunity.com/market/removelisting/' + encodeURIComponent(id);
  const opts = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      // 页面通道里这两个头由 Chromium 自己生成；主进程兜底通道靠它们过 Steam 的校验
      Referer: 'https://steamcommunity.com/market/',
      Origin: 'https://steamcommunity.com',
    },
  };

  const post = async () => {
    // 只发 sessionid（由通道页面自己补上），和 Steam 网页发的表单完全一致
    const r = await bridge.postForm(url, {}, opts);
    return r;
  };

  try {
    await bridge.ensurePage('https://steamcommunity.com/market/');
  } catch {
    /* 切页失败也继续试：兜底通道仍可能成功 */
  }

  let res = await post();
  // 400/403：多半还是页面上下文不对，强制重开市场页再试一次
  if (res.status === 400 || res.status === 403) {
    const body = await res.text().catch(() => '');
    logger.warn('下架返回 400，刷新市场页后重试', { listingId: id, body: String(body || '').slice(0, 200) });
    try {
      await bridge.refresh('https://steamcommunity.com/market/');
      res = await post();
    } catch {
      /* 重试失败就走下面的错误处理 */
    }
  }

  const text = await res.text().catch(() => '');
  if (res.status === 429) {
    throw Object.assign(new Error('被限流，请稍后再试'), { code: 'E_RATE_LIMIT' });
  }
  if (!res.ok) {
    const hint =
      res.status === 400 || res.status === 403
        ? '（Steam 拒绝了这次请求，通常是在网页端掉线了，请到「账号管理」重新登录 Steam 网页会话）'
        : '';
    const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 80);
    throw Object.assign(new Error(`下架失败：Steam 返回 ${res.status}${hint}${detail ? ` · ${detail}` : ''}`), {
      code: 'E_HTTP',
      status: res.status,
    });
  }
  // 成功时通常返回空体或 200
  if (text && /error|fail/i.test(text) && !/success/i.test(text)) {
    throw Object.assign(new Error(`下架失败：${text.slice(0, 120)}`), { code: 'E_REMOVE_FAILED' });
  }

  return { ok: true, listingId: id };
}

function cancel() {
  if (!running) return { ok: false, message: '当前没有执行中的任务' };
  cancelFlag = true;
  emitProgress({ message: '已请求取消，当前件完成后停止' });
  return { ok: true };
}

module.exports = {
  buildPlan,
  runQueue,
  fetchMyListings,
  removeListing,
  syncListings,
  cancel,
  on: emitter.on.bind(emitter),
};
