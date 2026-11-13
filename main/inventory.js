'use strict';

const store = require('./store');
const session = require('./session');
const bridge = require('./steamBridge');
const registry = require('./appRegistry');
const imageProxy = require('./imageProxy');

/**
 * 拉取库存。
 * 接口：/inventory/{steamid}/{appid}/{contextid}?l=schinese&count=2000
 * 返回里 assets[] 是"拥有的实物"，descriptions[] 才是商品信息，
 * 必须用 classid_instanceid 做交叉索引，market_hash_name 是查价的唯一钥匙。
 *
 * ★ 关于 500 ★
 * 同一个 URL，Steam 可能因为下面几种原因回 500：
 *   1) contextid 不对（比如 Steam 本体 753 必须是 6，填 2 就报错）
 *   2) count 过大且该 app 物品结构异常
 *   3) 该 app 根本没有库存资源（app 不支持社区物品）
 *   4) 会话被半失效（Cookie 还在但权限已降）
 * 老版本只抛 "库存接口返回 500"，等于什么都没说。
 * 现在：多套参数依次尝试，并把 Steam 真实返回的片段带出来，用户能直接看到原因。
 */

const MAX_PAGES = 20;

/** 单次请求：带完整诊断信息 */
async function hit(id, appId, ctx, extra) {
  const url = new URL(`https://steamcommunity.com/inventory/${id}/${appId}/${ctx}`);
  url.searchParams.set('l', extra.lang || 'schinese');
  url.searchParams.set('count', String(extra.count || 2000));
  if (extra.startAssetId) url.searchParams.set('start_assetid', extra.startAssetId);

  const res = await bridge.communityFetch(url.toString(), {
    headers: { Accept: 'application/json, text/plain, */*' },
  });

  // 取真实返回体片段，错误时给用户看
  let snippet = '';
  let json = null;
  try {
    const text = await res.text();
    snippet = String(text || '').slice(0, 600);
    if (res.ok) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
  } catch {
    /* ignore */
  }

  return { res, json, snippet, url: url.toString() };
}

/**
 * 拉取库存（带参数回退）。
 * 依次尝试：
 *   A. 注册表给出的 ctx + schinese + count=2000
 *   B. 同 ctx，english + count=75（小批量最稳）
 *   C. 强制 ctx=2（应对注册表没收录的 app）
 * 全部失败时抛出的错误里带 Steam 原始响应片段。
 */
async function fetchInventory(steamId, appId = 730, contextId = null, opts = {}) {
  const ses = await session.getSession(steamId);
  if (!ses || !ses.cookies || !ses.cookies.steamLoginSecure) {
    throw Object.assign(
      new Error('该账号没有可用的登录会话。请先在账号管理里点"登录"完成一次网页登录。'),
      { code: 'E_NO_SESSION' }
    );
  }
  const id = ses.steamId || steamId;
  const app = Number(appId) || 730;
  const ctx = contextId != null && contextId !== '' ? String(contextId) : String(registry.ctxOf(app));

  const attempts = [
    { lang: 'schinese', count: 2000, ctx },
    { lang: 'english', count: 75, ctx },
  ];
  if (ctx !== '2') attempts.push({ lang: 'english', count: 75, ctx: '2' });

  const traces = [];
  let first = null;

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    let r;
    try {
      r = await hit(id, app, a.ctx, { lang: a.lang, count: a.count });
    } catch (err) {
      traces.push(`第${i + 1}次 ${a.lang}/count=${a.count}/ctx=${a.ctx} → 网络失败: ${err.message}`);
      continue;
    }

    // 被踢回登录页：直接给明确结论，不用继续试
    if (bridge.looksLikeLogin(r.res)) {
      throw Object.assign(
        new Error('登录会话已失效，社区接口把请求当成未登录。请到账号管理重新登录一次。'),
        { code: 'E_NO_SESSION' }
      );
    }

    if (r.res.status === 401 || r.res.status === 403) {
      const hint =
        r.res.status === 403
          ? '库存不可见（403）。该账号的"游戏详情"隐私设为私密，请到 Steam 隐私设置里改成公开。'
          : '未授权（401）。登录会话已过期或无效，请重新网页登录。';
      throw Object.assign(new Error(`${hint}\nSteam 原始返回：${r.snippet || '(空)'}`), {
        code: r.res.status === 403 ? 'E_PRIVATE' : 'E_NO_SESSION',
        detail: { status: r.res.status, body: r.snippet, url: r.url },
      });
    }

    if (r.res.status === 429) {
      throw Object.assign(new Error('请求过于频繁（429）。请稍等一两分钟再试。'), { code: 'E_RATE_LIMIT' });
    }

    if (r.res.ok && r.json) {
      if (r.json.success === 1) {
        first = { json: r.json, ctx: a.ctx, attempt: i + 1 };
        break;
      }
      // success != 1：Steam 明确说这个 app 没东西
      traces.push(`第${i + 1}次 ctx=${a.ctx} → success=${r.json.success}，${r.snippet.slice(0, 160)}`);
      continue;
    }

    traces.push(`第${i + 1}次 ctx=${a.ctx} count=${a.count} → HTTP ${r.res.status}，${r.snippet.slice(0, 200)}`);
  }

  if (!first) {
    // 全部参数都失败，且失败原因是"这个 app 没有库存资源"（k_EResultNoMatch / 500），
    // 就把该 app 记进"不支持社区市场"名单，之后不再出现在游戏下拉里。
    // 用户的原话是"游戏不支持市场就给取消掉，不要在里面"。
    const noMarket = traces.every((t) => /HTTP 500|EResultNoMatch|success=/.test(t));
    // 后台监控等多账号场景传 noNote：某个号没库存不代表这个游戏没有市场，
    // 不能因此把它从全局的游戏下拉里删掉
    if (noMarket && !opts.noNote) noteNoMarket(app, traces[0] || '');

    const msg =
      `库存拉取失败（appid ${app}，contextid ${ctx}）。\n` +
      `已尝试 ${attempts.length} 组参数均未成功：\n` +
      traces.map((t) => '· ' + t).join('\n') +
      (noMarket
        ? `\n\nSteam 返回 k_EResultNoMatch：这个游戏没有社区市场库存，已自动从游戏列表里移除。`
        : `\n\n常见原因：该账号在这个游戏里确实没有可交易物品；或该游戏不支持社区库存；或会话已过期需要重新登录。`);
    throw Object.assign(new Error(msg), {
      code: 'E_INV_ALL_FAIL',
      detail: { appId: app, ctx, traces, noMarket },
    });
  }

  // 用成功的 ctx 继续翻页
  const assets = first.json.assets || [];
  const descMap = new Map();
  for (const d of first.json.descriptions || []) descMap.set(`${d.classid}_${d.instanceid}`, d);

  let startAssetId = first.json.more_items ? first.json.last_assetid : null;
  let page = 1;

  while (startAssetId && page < MAX_PAGES) {
    await sleep(600);
    let r;
    try {
      r = await hit(id, app, first.ctx, { lang: 'schinese', count: 2000, startAssetId });
    } catch {
      break;
    }
    if (!r.res.ok || !r.json || r.json.success !== 1) break;
    for (const a of r.json.assets || []) assets.push(a);
    for (const d of r.json.descriptions || []) descMap.set(`${d.classid}_${d.instanceid}`, d);
    startAssetId = r.json.more_items ? r.json.last_assetid : null;
    page++;
  }

  const items = assets.map((a) => {
    const key = `${a.classid}_${a.instanceid}`;
    const d = descMap.get(key) || {};
    const tradable = Number(d.tradable) === 1;
    const marketable = Number(d.marketable) === 1;
    return {
      assetId: a.assetid,
      appId: Number(a.appid),
      contextId: String(a.contextid),
      classId: a.classid,
      instanceId: a.instanceid,
      amount: Number(a.amount) || 1,
      name: formatRealItemName(d.name, d.type),
      rawName: d.name || '',
      marketHashName: d.market_hash_name || '',
      type: d.type || '',
      // 走本地 sdimg:// 代理：主进程多域名回退 + 带 Referer，避免某个 CDN 被墙就整片空白
      iconUrl: d.icon_url ? imageProxy.ecoUrl(d.icon_url) : null,
      tradable,
      marketable,
      commodity: Number(d.commodity) === 1,
      tradeHoldText: extractTradeHold(d),
      descriptions: extractDescriptions(d),
    };
  });

  const grouped = groupByHashName(items);

  const payload = {
    steamId: id,
    appId: app,
    appName: registry.nameOf(app),
    contextId: first.ctx,
    usedAttempt: first.attempt,
    totalAssets: items.length,
    sellableAssets: items.filter((i) => i.marketable).length,
    tradableAssets: items.filter((i) => i.tradable).length,
    // descriptions 已搬到 groups 上（同组各件完全一致），
    // 逐件再带一份会让大库存的 IPC 载荷白翻几倍
    items: items.map(({ descriptions, ...rest }) => rest),
    groups: grouped,
    groupCount: grouped.length,
    fetchedAt: Date.now(),
  };

  store.setInventoryCache(id, app, first.ctx, {
    totalAssets: payload.totalAssets,
    sellableAssets: payload.sellableAssets,
    tradableAssets: payload.tradableAssets,
  });
  store.saveCache();

  return payload;
}

/**
 * 自动探测：给定一组 appid，测出这个账号在哪些游戏里真的有物品。
 * 并发 3，每个先试 count=1（最省流量），有物品再记录数量。
 * 这就是"所有支持交易市场的游戏都能拉"的落地方式——不靠猜，直接问 Steam。
 */
async function discoverApps(steamId, appIds, opts = {}) {
  const ses = await session.getSession(steamId);
  if (!ses || !ses.cookies || !ses.cookies.steamLoginSecure) {
    throw Object.assign(new Error('请先完成网页登录再探测库存。'), { code: 'E_NO_SESSION' });
  }
  const id = ses.steamId || steamId;
  const list = Array.from(new Set((appIds || []).map(Number).filter((n) => n > 0)));
  const concurrency = Math.max(1, Number(opts.concurrency) || 3);
  const out = [];

  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const app = list[idx++];
      const ctx = String(registry.ctxOf(app));
      const tries = ctx === '2' ? ['2'] : [ctx, '2'];
      let found = null;
      for (const c of tries) {
        try {
          const r = await hit(id, app, c, { lang: 'english', count: 1 });
          if (r.res.ok && r.json && r.json.success === 1 && (r.json.total_inventory_count || (r.json.assets || []).length)) {
            found = {
              appId: app,
              name: registry.nameOf(app),
              ctx: c,
              count: Number(r.json.total_inventory_count) || (r.json.assets || []).length,
            };
            break;
          }
        } catch {
          /* 单个失败不影响整体 */
        }
        await sleep(280);
      }
      if (found) out.push(found);
      await sleep(280);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  out.sort((a, b) => b.count - a.count);
  return { steamId: id, probed: list.length, found: out };
}

/**
 * 从物品描述里解析"交易冷却"信息。
 *
 * ★ 只认英文正则是错的 ★
 * 库存接口带的是 l=schinese，Steam 返回描述也是中文：
 *   "在 2025 年 11 月 15 日 下午 4:00 (GMT) 之前无法交易"
 * 早先只匹配 "Tradable After ..."，中文环境下永远落到兜底的"当前不可交易"，
 * 用户只看到"冷却中"却不知道哪天解禁。
 */
function extractTradeHold(d) {
  const arr = Array.isArray(d.descriptions) ? d.descriptions : [];
  const text = arr
    .map((x) => (x && (x.value || x)) || '')
    .join(' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  // 英文：Tradable After Nov 15, 2025 (8:00:00) GMT
  let m = text.match(/Tradable After[:\s]+([A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4}[^|]*)/i);
  if (m) return `冷却至 ${m[1].replace(/\s*\(?GMT\)?\s*$/i, '').trim()}`;

  // 中文：在 2025 年 11 月 15 日 下午 4:00 (GMT) 之前无法交易
  m = text.match(
    /((?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日[^|。]{0,26}?)\s*之前\s*(?:无法|不能|不可)/
  );
  if (m) {
    const raw = m[1].replace(/\(GMT\)/gi, '').replace(/\s+/g, ' ').trim();
    return `冷却至 ${raw}`;
  }

  // 市场本来就不收这件东西（永久下架），不要再标成"冷却中"，那是误导
  if (Number(d.marketable) === 0) return '';
  // 描述里只说了不能交易、没给日期
  // 只有「可交易」被锁、市场仍可卖：社区市场只要求 marketable，不受这条限制
  if (Number(d.tradable) === 0) return '交易冷却中（仍可上架市场，只是不能玩家间交易）';
  return '';
}

/**
 * 记录"这个 app 没有社区市场库存"。
 * 存进 settings.noMarketApps，游戏下拉与库存页据此把它剔除，
 * 免得用户每次都点到一个必然报错的游戏。
 */
function noteNoMarket(appId, reason) {
  const id = Number(appId);
  if (!id || id === 753) return; // Steam 本体的卡牌/背景永远有市场
  try {
    const settings = store.getSettings();
    const map = Object.assign({}, settings.noMarketApps || {});
    if (map[String(id)]) return;
    map[String(id)] = { at: Date.now(), reason: String(reason || '').slice(0, 200) };
    store.setSettings({ noMarketApps: map });
  } catch {
    /* 写设置失败不影响主流程 */
  }
}

function extractDescriptions(d) {
  const arr = Array.isArray(d.descriptions) ? d.descriptions : [];
  return arr
    .map((x) => {
      const raw = (x && (x.value || x.name)) || '';
      return raw.replace(/<[^>]+>/g, '').trim();
    })
    .filter(Boolean);
}

function formatRealItemName(rawName, rawType) {
  let name = String(rawName || '').trim();
  const type = String(rawType || '').trim();
  if (!name) return '未知物品';

  // 1. 如果名字仅仅是 ":emoji_name:"，尝试结合游戏/类型形成友好名称
  if (/^:[a-zA-Z0-9_\-]+:$/.test(name) && type) {
    const gamePart = type.replace(/\s*(表情|个人资料背景|集换式卡牌|卡牌).*$/i, '').trim();
    if (gamePart) {
      return `${gamePart} - ${name}`;
    }
  }

  // 2. 如果名字是纯英文而 type 中有清晰的中文游戏名归属
  if (/^[a-zA-Z0-9_\-\s]+$/.test(name) && type && /[一-龥]/.test(type)) {
    const gamePart = type.replace(/\s*(表情|个人资料背景|集换式卡牌|卡牌).*$/i, '').trim();
    if (gamePart && !name.includes(gamePart)) {
      return `${gamePart} · ${name}`;
    }
  }

  return name;
}

/** 市场 appid 解析（与 market.js 同一规则，但本地实现避免循环依赖） */
function marketAppIdOf(appId, hashName) {
  const base = Number(appId) || 753;
  if (base === 753) return 753;
  const m = /^(\d+)-/.exec(String(hashName || ''));
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return base > 0 ? base : 753;
}

/**
 * 按 market_hash_name 聚合。
 *
 * ★ 为什么要聚合 ★
 * 库存接口返回的是**逐件**的 assets —— 一个玩家可能有 200 个同名箱子。
 * 老版本把 4000 件资产原样交给渲染层，前端就渲染 4000 行 DOM，
 * 一屏滚不动，也看不出"这个箱子我有 200 个"。
 * 聚合后行数通常降到几百，数量与总市值一目了然。
 *
 * 每个组带 assets[] 明细：同名的两件物品 tradable 可能不同
 * （其中一批刚掉落、还在冷却），所以组级标记按"整组都能卖"才为 true，
 * 并分别给出三种数量，不让一件的状态代表全部。
 */
function groupByHashName(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.marketHashName || `${it.appId}:${it.classId}_${it.instanceId || 0}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        marketHashName: it.marketHashName,
        // 查价必须用"这件物品真正所在的市场 appid"：
        // 社区物品(卡牌/背景/表情)挂在源游戏下，不是 753。
        // 注意：这里不能 require('market')，否则与 market 形成循环依赖。
        appId: marketAppIdOf(it.appId, it.marketHashName),
        sourceAppId: it.appId,
        name: it.name,
        type: it.type,
        iconUrl: it.iconUrl,
        commodity: it.commodity,
        // 描述在组上存一份就够（同组各件完全一致），
        // 逐件存会让 4000 件的载荷白翻好几倍
        descriptions: it.descriptions || [],
        qty: 0,
        sellableQty: 0,
        marketableQty: 0,
        tradableQty: 0,
        assets: [],
      };
      map.set(key, g);
    }
    g.qty += 1;
    if (it.marketable) g.marketableQty += 1;
    if (it.tradable) g.tradableQty += 1;
    // 能不能上架只看 marketable：交易冷却（tradable=false）不影响社区市场出售
    if (it.marketable) g.sellableQty += 1;
    g.assets.push({
      assetId: it.assetId,
      contextId: it.contextId,
      amount: it.amount,
      marketable: it.marketable,
      tradable: it.tradable,
      tradeHoldText: it.tradeHoldText,
    });
  }

  const list = [...map.values()];
  for (const g of list) {
    g.marketable = g.marketableQty === g.qty;
    g.tradable = g.tradableQty === g.qty;
    const hold = g.assets.find((a) => a.tradeHoldText);
    g.tradeHoldText = hold ? hold.tradeHoldText : '';
  }
  return list.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { fetchInventory, discoverApps, groupByHashName, noteNoMarket };
