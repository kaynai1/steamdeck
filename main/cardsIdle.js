'use strict';

/**
 * Steam 挂卡（集换式卡牌掉落进度）
 *
 * 数据源：Steam 社区徽章页
 *   https://steamcommunity.com/profiles/{steamId}/badges/?sort=p
 *   ?sort=p 只列出「还有卡片可掉落」的游戏，比全量徽章页轻得多。
 *
 * 解析（按 badge_row 分块、块内配对，避免跨行错位）：
 *   · gamecards/{appid} → AppID
 *   · badge_title → 游戏名
 *   · 进度文案多语言变体：
 *     「还剩 4 张卡片可掉落」「剩余 4 張卡片可掉落」「4 card drops remaining」
 *   · 「2 小时后卡片掉落率减半 / 2 hours until card drop rate halves」→ 未满 2 小时
 *
 * 网络连不上 steamcommunity.com 时（常见于国内直连），若用户没配代理，
 * 自动探测本机代理（Clash / v2rayN 常见端口），找到可用代理就自动启用并重试一次。
 */

const session = require('./session');

const BADGE_URL = (sid) => `https://steamcommunity.com/profiles/${sid}/badges/?sort=p`;

/** 从一段徽章 HTML 里解析出（appid, 名称, 剩余卡数, 时长, 未满2小时） */
function parseBadgeRows(html) {
  const rows = [];
  const blocks = String(html || '').split(/<div class="badge_row[\s"]/).slice(1);
  for (const b of blocks) {
    const idm = b.match(/gamecards\/(\d+)/);
    if (!idm) continue;
    const appId = Number(idm[1]);
    const nm = b.match(/badge_title[^>]*>\s*([^<]+?)\s*<\//);
    const name = nm ? nm[1].replace(/\s*·\s*查看进度\s*$/, '').trim() : `App ${appId}`;
    // 中 / 繁 / 英三套「还剩 N 张卡」文案
    const dm =
      b.match(/(?:还剩|剩余|还有|還剩|剩餘)\s*(\d+)\s*(?:张|張|个|個|枚)?\s*(?:卡片|卡牌)/) ||
      b.match(/(\d+)\s*(?:张|張)?\s*(?:卡片|卡牌)\s*(?:可掉落|待掉落)/) ||
      b.match(/(\d+)\s*card\s*drops\s*remaining/i) ||
      b.match(/(\d+)\s*cards?\s*remaining/i);
    const drops = dm ? Number(dm[1]) : 0;
    const pm = b.match(/([\d.,]+)\s*(?:小时|小時|hours?)/i);
    const hours = pm ? Number(String(pm[1]).replace(',', '')) : 0;
    // 「玩满 2 小时后掉落率减半」提示出现 = 还没到 2 小时（高掉率阶段）
    const half = /减半|減半|halve/i.test(b);
    rows.push({ appId, name, drops, hours, underTwoHours: half });
  }
  return rows;
}

/** 网络失败时的错误文案（带代理指引） */
function netErrMessage(e) {
  const raw = (e && e.message) || String(e || '网络错误');
  if (/ERR_CONNECTION|timed?out|fetch|network|reset/i.test(raw)) {
    return '连不上 steamcommunity.com（Steam 社区徽章页）。国内网络通常直连不通：请开启 Clash / v2rayN 等代理后在「设置 → 登录窗口代理」点「检测代理」，或直接点「读取进度」重试（软件会自动探测本机代理）。';
  }
  return raw;
}

/**
 * 拉取当前登录账号的挂卡进度。
 * 返回 { loggedIn:false } 或 { loggedIn:true, games, totalDrops, at, suspicious }。
 * suspicious = 页面里一个徽章行都没有（多半是被重定向到登录页/异常页）。
 */
async function progress() {
  const ses = await session.getSession().catch(() => null);
  if (!ses || !ses.steamId || !ses.cookies || !ses.cookies.steamLoginSecure) {
    return { loggedIn: false };
  }

  const fetchOnce = () =>
    session.authFetch(BADGE_URL(ses.steamId)).then((r) => {
      if (r.status && r.status >= 400) throw new Error(`徽章页返回 HTTP ${r.status}`);
      return r.text();
    });

  let html;
  try {
    html = await fetchOnce();
  } catch (e) {
    // 自动代理重试：没配代理时探测一次，找到可用代理就启用后重试
    const store = require('./store');
    if (!String(store.getSettings().loginProxy || '').trim()) {
      let detected = null;
      try {
        detected = await require('./proxyDetect').detectProxy();
      } catch { detected = null; }
      if (detected && detected.found) {
        store.setSettings({ loginProxy: detected.proxy });
        await session.applyProxy().catch(() => {});
        try {
          html = await fetchOnce();
        } catch (e2) {
          throw Object.assign(new Error(netErrMessage(e2)), { code: 'E_BADGES_NET' });
        }
        require('./logger').info('挂卡读取自动启用本机代理后成功', { proxy: detected.proxy });
      } else {
        throw Object.assign(new Error(netErrMessage(e)), { code: 'E_BADGES_NET' });
      }
    } else {
      throw Object.assign(new Error(netErrMessage(e)), { code: 'E_BADGES_NET' });
    }
  }

  const hasBadgeRows = /badge_row/.test(html);
  const games = parseBadgeRows(html)
    .filter((g) => g.drops > 0)
    .sort((a, b) => b.drops - a.drops);
  const totalDrops = games.reduce((s, g) => s + g.drops, 0);
  return { loggedIn: true, games, totalDrops, at: Date.now(), suspicious: !hasBadgeRows };
}

module.exports = { progress, parseBadgeRows };