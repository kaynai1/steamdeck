'use strict';

/**
 * Steam 免费包「一键入库」
 *
 * 免费领取页里的 Steam 条目来自 GamerPower，链接先跳到 /open/ 再 302 到真正地址：
 *   · 落到 store.steampowered.com/app/<id>/ 的，是 Steam 商店的免费包/免费 DLC，
 *     页面（登录后）里自带 `AddFreeLicense(<包ID>, "标题")` 的「添加到库」按钮，
 *     所以可以走官方接口入库：
 *       1) 带登录态打开商店页，读出包 ID 和页面里的 g_sessionID
 *       2) POST https://store.steampowered.com/checkout/addfreelicense
 *          action=add_to_cart&sessionid=…&subid=<包ID>
 *   · 落到别的站（Alienware、SteelSeries 等）的，只能把地址交给用户去领，
 *     这里不冒充能自动完成。
 *
 * 浏览器会话复用主程序的 persist:steam 分区（session.authFetch），
 * 所以只要软件里登录过 Steam，就有登录态。
 */

const session = require('./session');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 跟到 GamerPower 链接的最终地址 */
async function resolveUrl(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  // 有些站会拦脚本请求，但只要拿到了最终地址就够了
  return res.url || url;
}

async function status() {
  try {
    const cookies = await session.readStoreCookies();
    return { linked: !!cookies.steamLoginSecure, steamId: '' };
  } catch {
    return { linked: false };
  }
}

async function storeGet(url) {
  return session.authFetch(url, {
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html' },
    signal: AbortSignal.timeout(25000),
  });
}

/**
 * 领取一个 Steam 免费包。
 * @param {{url:string,title?:string}} item
 * @returns {{ok:boolean,state:string,message:string,url?:string}}
 */
async function claim(item) {
  const src = item && item.url;
  if (!src) throw err('E_BAD_ITEM', '这个条目没有链接');

  let finalUrl = src;
  try {
    finalUrl = await resolveUrl(src);
  } catch {
    /* 解析失败就按原链接继续判断 */
  }

  if (!/^https?:\/\/store\.steampowered\.com\/app\/\d+/i.test(finalUrl)) {
    return {
      ok: false,
      state: 'external',
      message: '这个活动要跳转到第三方站点领取',
      url: finalUrl,
    };
  }

  const pageUrl = finalUrl.includes('?') ? `${finalUrl}&cc=cn&l=schinese` : `${finalUrl}?cc=cn&l=schinese`;
  const res = await storeGet(pageUrl);
  if (res.status === 401 || /\/login\/?\?/i.test(res.url || '')) {
    return { ok: false, state: 'login', message: 'Steam 网页登录已过期，请重新登录' };
  }
  if (!res.ok) return { ok: false, state: 'failed', message: `Steam 商店返回 HTTP ${res.status}` };

  const html = await res.text();
  const pkg = html.match(/AddFreeLicense\(\s*(\d+)/i);
  if (!pkg) {
    if (/添加到库|Add to Account|AddFreeLicense/i.test(html)) {
      return { ok: false, state: 'failed', message: '商店页结构不认识（没读到免费包 ID）' };
    }
    // 已拥有时页面显示的是「下载 / 开始游戏」
    if (/下载|开始游戏|Play Now/i.test(html)) {
      return { ok: true, state: 'owned', message: '已在库中' };
    }
    return {
      ok: false,
      state: 'failed',
      message: '商店页没有「添加到库」按钮（可能需要先拥有基础游戏，或活动已结束）',
    };
  }

  let sid = (html.match(/g_sessionID\s*=\s*"([^"]+)"/i) || [])[1] || '';
  if (!sid) {
    try {
      sid = (await session.readStoreCookies()).sessionid || '';
    } catch { /* ignore */ }
  }
  if (!sid) return { ok: false, state: 'login', message: '取不到 Steam 会话（sessionid），请重新登录' };

  const body = new URLSearchParams({
    action: 'add_to_cart',
    sessionid: sid,
    subid: pkg[1],
  });

  const post = await session.authFetch('https://store.steampowered.com/checkout/addfreelicense', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
      Referer: pageUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });

  await sleep(300);
  const text = await post.text();

  if (!post.ok) {
    return { ok: false, state: 'failed', message: `领取失败：HTTP ${post.status}` };
  }
  if (/"success"\s*:\s*1/i.test(text) || /^\s*\[\s*\]\s*$/.test(text)) {
    return { ok: true, state: 'claimed', message: '已领取' };
  }
  if (/already|owns/i.test(text)) {
    return { ok: true, state: 'owned', message: '已在库中' };
  }
  if (/<html/i.test(text)) {
    return { ok: false, state: 'login', message: 'Steam 要求重新登录，请重新登录后再试' };
  }
  return {
    ok: false,
    state: 'failed',
    message: `领取没有成功：${text.replace(/\s+/g, ' ').slice(0, 120)}`,
  };
}

module.exports = { status, claim, _resolveUrl: resolveUrl };
