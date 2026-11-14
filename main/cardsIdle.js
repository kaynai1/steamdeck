'use strict';

/**
 * Steam 挂卡（集换式卡牌掉落进度）
 *
 * 数据源：Steam 社区徽章页 https://steamcommunity.com/profiles/{steamId}/badges/
 * 用已保存的网页登录会话直接读 HTML，逐行解析出「还有 N 张卡片可掉落」的游戏。
 *
 * 页面结构（多年稳定）：
 *   <div class="badge_row">
 *     <a class="badge_row_overlay" href="…/gamecards/<appid>/"></a>
 *     <div class="badge_title …>游戏名</div>
 *     <div class="progress_info_bold">还剩 4 张卡片可掉落</div>
 *     … playtime "已记录的游戏时间 12.3 小时" / "达到 2 小时后卡片掉落率减半"
 *   </div>
 * 解析时同一行内配对，避免跨行错位。
 */

const session = require('./session');

const BADGE_URL = (sid) => `https://steamcommunity.com/profiles/${sid}/badges/`;

/** 从一段徽章 HTML 里解析出（appid, 名称, 剩余卡数, 时长文本） */
function parseBadgeRows(html) {
  const rows = [];
  const blocks = String(html || '').split(/<div class="badge_row\s/).slice(1);
  for (const b of blocks) {
    const idm = b.match(/gamecards\/(\d+)/);
    if (!idm) continue;
    const appId = Number(idm[1]);
    const nm = b.match(/badge_title[^>]*>\s*([^<]+?)\s*<\//);
    const name = nm ? nm[1].trim() : `App ${appId}`;
    // 「还剩 4 张卡片可掉落」/「4 card drops remaining」/「还有 4 张卡片可掉落」
    const dm = b.match(/(?:还剩|剩余|还有)\s*(\d+)\s*(?:张|个|枚)?\s*(?:卡片|卡牌)/) ||
      b.match(/(\d+)\s*card\s*drops\s*remaining/i);
    const drops = dm ? Number(dm[1]) : 0;
    const pm = b.match(/([\d.,]+)\s*(?:小时|hours?)/i);
    const hours = pm ? Number(String(pm[1]).replace(',', '')) : 0;
    // 半速提示：玩满 2 小时后掉落率减半，挂卡时挑还没到 2 小时的更划算
    const half = /减半|half/.test(b);
    rows.push({ appId, name, drops, hours, halfSpeed: half });
  }
  return rows;
}

/**
 * 拉取当前登录账号的挂卡进度。
 * 返回 { loggedIn:false } 或 { loggedIn:true, games, totalDrops, at }。
 */
async function progress() {
  const ses = await session.getSession().catch(() => null);
  if (!ses || !ses.steamId || !ses.cookies || !ses.cookies.steamLoginSecure) {
    return { loggedIn: false };
  }
  const html = await session.authFetch(BADGE_URL(ses.steamId)).then((r) => r.text());
  const games = parseBadgeRows(html)
    .filter((g) => g.drops > 0)
    .sort((a, b) => b.drops - a.drops);
  const totalDrops = games.reduce((s, g) => s + g.drops, 0);
  return { loggedIn: true, games, totalDrops, at: Date.now() };
}

module.exports = { progress, parseBadgeRows };