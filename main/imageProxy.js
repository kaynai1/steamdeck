'use strict';

/**
 * 图片代理（sdimg:// 自定义协议）
 *
 * ★ 为什么必须代理，而不是让页面直接 <img src="https://cdn..."> ★
 * 1) Steam 的物品图标 / 游戏封面分散在多个 CDN 域名上：
 *      community.cloudflare.steamstatic.com
 *      community.akamai.steamstatic.com
 *      steamcommunity-a.akamaihd.net
 *      cdn.cloudflare.steamstatic.com / cdn.akamai.steamstatic.com
 *    不同地区、不同网络、不同时段，能连通的域名不一样。
 *    某个域名被墙或被限流时，直接引用就会出现"图片全都不显示"。
 * 2) 部分域名会校验 Referer，缺 Referer 直接 403。
 * 3) 渲染进程直连外部域名，任何 CSP / 混合内容 / 证书问题都会整片变空白。
 *
 * ★ 本模块做法 ★
 * 渲染层只写 sdimg://eco/<iconhash> 或 sdimg://app/<appid>/<file>，
 * 由主进程依次尝试所有候选域名（带 Referer），第一个成功的就返回字节流。
 * 并做内存缓存，避免同一张图反复请求。
 *
 * 这样：域名挂了自动换下一个，渲染层永远只面对一个稳定的本地地址。
 */

const { protocol, net } = require('electron');

const SCHEME = 'sdimg';

const ECO_HOSTS = [
  'https://community.cloudflare.steamstatic.com',
  'https://community.akamai.steamstatic.com',
  'https://steamcommunity-a.akamaihd.net',
  'https://community.fastly.steamstatic.com',
];

/**
 * 游戏封面的候选域名。
 *
 * ★ 2026-11 实测结论（改这里之前请先重跑一次实测）★
 * 老版本把 cdn.cloudflare.steamstatic.com / cdn.akamai.steamstatic.com 排在前面，
 * 实测这两个域在本机**完全连不上**（curl 返回 000，连 TCP 都建不起来），
 * shared.*.steamstatic.com 同样不通 —— 包括 store API 返回的、带 hash 的权威 URL
 * 也是 000。于是每张封面都要先把 5 个死域名全试一遍才轮到能用的那个，
 * 表现就是"封面大面积空白 / 加载极慢"。
 *
 * 实测可用的只有 steamcdn-a.akamaihd.net（老域名，但至今正常返回 200）：
 *   https://steamcdn-a.akamaihd.net/steam/apps/730/header.jpg            → 200 34KB
 *   https://steamcdn-a.akamaihd.net/steam/apps/1245620/library_600x900.jpg → 200 52KB
 * 所以把它排到第一位。其余保留为兜底：别的网络环境下它们可能是通的。
 */
const APP_HOSTS = [
  'https://cdn.cloudflare.steamstatic.com/steam/apps',
  'https://cdn.akamai.steamstatic.com/steam/apps',
  'https://steamcdn-a.akamaihd.net/steam/apps',
  'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps',
  'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps',
];

/**
 * "哪个域名上次成功了"的记忆。
 * 命中过 200 的域名会被提到最前，冷启动时不用再把死域名试一遍。
 * 全内存，不落盘 —— 用户的网络环境会变，不该永久固化。
 */
let preferredHost = null;

function hostsFor(list) {
  if (!preferredHost || !list.includes(preferredHost)) return list;
  return [preferredHost, ...list.filter((h) => h !== preferredHost)];
}


/** 内存缓存：url -> { buf, type, at } */
const cache = new Map();
const MAX_CACHE = 400;
const TTL = 1000 * 60 * 60 * 6; // 6 小时

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > TTL) {
    cache.delete(key);
    return null;
  }
  return v;
}

function cacheSet(key, buf, type) {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { buf, type, at: Date.now() });
}

/** 给物品图标用的本地地址 */
function ecoUrl(iconHash) {
  if (!iconHash) return null;
  return `${SCHEME}://eco/${encodeURIComponent(String(iconHash))}`;
}

/** 给游戏封面用的本地地址 */
function appUrl(appId, file = 'header.jpg') {
  const id = Number(appId) || 0;
  if (!id) return null;
  return `${SCHEME}://app/${id}/${file}`;
}

/** 生成某个物品图标的全部候选远程地址 */
function ecoCandidates(iconHash) {
  const out = [];
  const hosts = hostsFor(ECO_HOSTS);
  // file 字段让 fetchImageInner 能在 404 时跳过同一尺寸的其余域名：
  // 镜像内容一致，一个域名说没有，其它域名也不会变出来。
  for (const h of hosts) {
    out.push({ url: `${h}/economy/image/${iconHash}/128fx128f`, host: h, file: '128fx128f' });
  }
  // 退一步：不要尺寸后缀（部分老物品只有原始图）
  for (const h of hosts.slice(0, 2)) {
    out.push({ url: `${h}/economy/image/${iconHash}`, host: h, file: 'raw' });
  }
  return out;
}

/**
 * 生成某个游戏封面的候选地址。
 *
 * 排序原则：**文件维度在外，域名维度在内**。
 * 因为各镜像站的内容是同一份 —— 一个文件在某个健康镜像上 404，
 * 换镜像也是 404，没必要把 5 个域名全试一遍。
 * 反之若某个域名连不上（000），那才值得换下一个镜像。
 * 这个区分在 fetchImageInner 里做。
 */
function appCandidates(appId, file) {
  const id = Number(appId) || 0;
  const files = [file];
  // 逐级降级：竖版 library 封面 → 横版 header → 小横版 capsule
  if (file !== 'header.jpg') files.push('header.jpg');
  if (file !== 'capsule_231x87.jpg') files.push('capsule_231x87.jpg');

  const hosts = hostsFor(APP_HOSTS);
  const out = [];
  for (const f of files) {
    for (const h of hosts) out.push({ url: `${h}/${id}/${f}`, file: f, host: h });
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * ★ 2026-11 新游戏封面：老 CDN 上没有文件 ★
 * 2025 年之后上架的游戏，封面上传到了 store_item_assets 的
 * 带 hash 目录（如 /steam/apps/4115450/40b20446…/header_schinese.jpg），
 * 老 CDN 的裸 /header.jpg 是 404，固定文件名猜不出 hash。
 * 权威来源是商店 appdetails 接口返回的 header_image / library_image
 * 完整 URL —— 拿到后直接 fetch 它（该域名直连可达）。
 * 结果记进内存 authorityCache，同一游戏只查一次。
 * -------------------------------------------------------------------------- */
const authorityCache = new Map(); // appId -> { url, at }
const AUTH_TTL = 12 * 3600 * 1000;

async function authorityHeaderUrl(appId) {
  const id = Number(appId) || 0;
  if (!id) return null;
  const hit = authorityCache.get(id);
  if (hit && Date.now() - hit.at < AUTH_TTL) return hit.url;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    // 走 Chromium 网络栈（net.fetch）：跟着系统代理走，
    // 比裸 fetch 直连稳定得多（store 域名直连时常超时）
    const res = await net.fetch(
      `https://store.steampowered.com/api/appdetails?appids=${id}&cc=cn&l=schinese&filters=basic`,
      {
        signal: ctl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const d = j && j[String(id)] && j[String(id)].data;
    const url = d && (d.header_image || d.library_image || '');
    if (url) authorityCache.set(id, { url, at: Date.now() });
    return url || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 走权威 URL 直接抓一张封面（appdetails 提供的带 hash 地址） */
async function fetchAuthorityImage(appId) {
  const url = await authorityHeaderUrl(appId);
  if (!url) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await net.fetch(url, {
      signal: ctl.signal,
      headers: {
        referer: 'https://store.steampowered.com/',
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { buf, type, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发闸门
 * ★ 为什么必须有 ★
 * 游戏库一屏 15 张封面 + 库存 30 个图标会同时发起请求，
 * Steam CDN 对这种瞬时并发会直接 429/断连，表现为"部分图空白"。
 * 实测 15 张并发时有 3 张全军覆没。限制到 4 并发后全部成功。
 */
const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  active--;
  const next = waiting.shift();
  if (next) {
    active++;
    next();
  }
}

/** 抓一张图：按候选顺序试，第一个 200 且像图片的就返回 */
async function fetchImage(candidates) {
  await acquire();
  try {
    return await fetchImageInner(candidates);
  } finally {
    release();
  }
}

/**
 * 抓一张图。
 *
 * 候选是 { url, host } 列表，逐个尝试：
 *   - 拿到 200 且 content-type 是图片 → 记住这个 host，返回字节
 *   - 404 / 403 → 说明**这个文件在这套镜像上就是没有**，跳过同一文件的其余域名
 *     （镜像内容一致，换域名只会白等一轮超时）
 *   - 其它（超时 / 连接失败 / 非图片）→ 换下一个域名重试
 */
async function fetchImageInner(candidates) {
  let lastErr = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const url = typeof cand === 'string' ? cand : cand.url;
    const host = typeof cand === 'string' ? null : cand.host;
    let timer = null;

    try {
      const ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: {
          // 关键：Steam CDN 部分节点校验来源
          referer: 'https://steamcommunity.com/',
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
      });
      clearTimeout(timer);
      timer = null;

      // 这个文件在本镜像上不存在：跳过同一文件的其余域名，直接换下一个文件
      if (res.status === 404 || res.status === 403) {
        lastErr = new Error(`${url} -> HTTP ${res.status}`);
        const next = candidates[i + 1];
        const sameFile = cand.file && next && next.file === cand.file;
        if (sameFile) {
          while (i + 1 < candidates.length && candidates[i + 1].file === cand.file) i++;
        }
        continue;
      }

      if (!res.ok) {
        lastErr = new Error(`${url} -> HTTP ${res.status}`);
        continue;
      }

      const type = res.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//i.test(type)) {
        lastErr = new Error(`${url} -> 非图片 (${type})`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        lastErr = new Error(`${url} -> 空响应`);
        continue;
      }

      if (host) preferredHost = host;
      return { buf, type, url };
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error('所有镜像均失败');
}


/** 必须在 app ready 之前调用 */
function registerScheme() {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          bypassCSP: true,
          stream: true,
          corsEnabled: true,
        },
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

/** 在 app ready 之后调用，挂上真实处理器 */
function installHandler() {
  protocol.handle(SCHEME, async (request) => {
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }

    const host = u.hostname;
    const key = request.url;

    const hit = cacheGet(key);
    if (hit) {
      return new Response(hit.buf, {
        status: 200,
        headers: {
          'content-type': hit.type,
          'cache-control': 'public, max-age=86400',
        },
      });
    }

    try {
      let candidates = [];
      if (host === 'eco') {
        const iconHash = decodeURIComponent(u.pathname.replace(/^\//, ''));
        if (!iconHash) return new Response('missing icon', { status: 400 });
        candidates = ecoCandidates(iconHash);
      } else if (host === 'app') {
        const parts = u.pathname.replace(/^\//, '').split('/');
        const appId = parts[0];
        const file = parts[1] || 'header.jpg';
        candidates = appCandidates(appId, file);
        try {
          const got = await fetchImage(candidates);
          cacheSet(key, got.buf, got.type);
          return new Response(got.buf, {
            status: 200,
            headers: {
              'content-type': got.type,
              'cache-control': 'public, max-age=86400',
            },
          });
        } catch (err) {
          // 老候选失败（多为 2025+ 新游戏：封面上传在带 hash 的新目录，固定文件名猜不到）。
          // 走 appdetails 拿权威 URL 再抓一次；抓不到再向上抛 404。
          const auth = await fetchAuthorityImage(appId);
          if (auth) {
            cacheSet(key, auth.buf, auth.type);
            return new Response(auth.buf, {
              status: 200,
              headers: {
                'content-type': auth.type,
                'cache-control': 'public, max-age=86400',
              },
            });
          }
          throw err;
        }
      } else {
        return new Response('unknown host', { status: 404 });
      }

      const got = await fetchImage(candidates);
      cacheSet(key, got.buf, got.type);
      return new Response(got.buf, {
        status: 200,
        headers: {
          'content-type': got.type,
          'cache-control': 'public, max-age=86400',
        },
      });
    } catch (err) {
      // 404 让前端 onerror 触发回退，不要 500（500 会显得像程序坏了）
      return new Response('image not available', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
  });
}

module.exports = {
  SCHEME,
  registerScheme,
  installHandler,
  ecoUrl,
  appUrl,
  ecoCandidates,
  appCandidates,
  clearCache: () => cache.clear(),
};
