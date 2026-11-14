'use strict';

/**
 * 常用游戏中文译名词典（内置，离线可用）
 *
 * ★ 为什么需要 ★
 * Steam 商店接口（appdetails / GetItems / storesearch）的 name 字段只对
 * 「有官方译名」的游戏返回中文（如 黑神话：悟空 / 艾尔登法环）；
 * Euro Truck Simulator 2、Project Zomboid 这类游戏的官方名字字段各语言都是英文。
 * 但玩家社区有约定俗成的中文名，卡片下方只显示英文名不够友好。
 *
 * 这里收录常见游戏（以用户可见频率为准），译名以商店页/发行商公布的中文名为准。
 * appId 级与英文标题级都能查；匹配规则在 appNames.js 里做归一化包含校验。
 */

const EN = 'en';
const ZH = 'zh';

/** appId → { en, zh } */
const APP_ZH = {
  227300: { en: 'Euro Truck Simulator 2', zh: '欧洲卡车模拟2' },
  270880: { en: 'American Truck Simulator', zh: '美国卡车模拟' },
  394360: { en: 'Hearts of Iron IV', zh: '钢铁雄心4' },
  281990: { en: 'Stellaris', zh: '群星' },
  236850: { en: 'Europa Universalis IV', zh: '欧陆风云4' },
  1158310: { en: 'Crusader Kings III', zh: '十字军之王3' },
  203770: { en: 'Crusader Kings II', zh: '十字军之王2' },
  529340: { en: 'Victoria 3', zh: '维多利亚3' },
  108600: { en: 'Project Zomboid', zh: '僵尸毁灭工程' },
  251570: { en: '7 Days to Die', zh: '七日杀' },
  271590: { en: 'Grand Theft Auto V', zh: '侠盗猎车手5' },
  105600: { en: 'Terraria', zh: '泰拉瑞亚' },
  413150: { en: 'Stardew Valley', zh: '星露谷物语' },
  252490: { en: 'Rust', zh: '腐蚀' },
  218620: { en: 'PAYDAY 2', zh: '收获日2' },
  204360: { en: 'Castle Crashers', zh: '城堡破坏者' },
  113200: { en: 'The Binding of Isaac', zh: '以撒的结合' },
  250900: { en: 'The Binding of Isaac: Rebirth', zh: '以撒的结合：重生' },
  219950: { en: 'NiGHTS Into Dreams', zh: '梦精灵：入梦' },
  223470: { en: 'POSTAL 2', zh: '喋血街头2' },
  225540: { en: 'Just Cause 3', zh: '正当防卫3' },
  221040: { en: 'Resident Evil 6', zh: '生化危机6' },
  304930: { en: 'Unturned', zh: '未转变者' },
  440: { en: 'Team Fortress 2', zh: '军团要塞2' },
  550: { en: 'Left 4 Dead 2', zh: '求生之路2' },
  620: { en: 'Portal 2', zh: '传送门2' },
  400: { en: 'Portal', zh: '传送门' },
  43110: { en: 'Wallpaper Engine', zh: '壁纸引擎' },
  8930: { en: "Sid Meier's Civilization V", zh: '文明5' },
  289070: { en: "Sid Meier's Civilization VI", zh: '文明6' },
  359550: { en: "Tom Clancy's Rainbow Six Siege", zh: '彩虹六号：围攻' },
  1174180: { en: 'Red Dead Redemption 2', zh: '荒野大镖客：救赎2' },
  1091500: { en: 'Cyberpunk 2077', zh: '赛博朋克2077' },
  1085660: { en: 'Destiny 2', zh: '命运2' },
  75210: { en: 'The Long Dark', zh: '漫漫长夜' },
  252950: { en: 'Rocket League', zh: '火箭联盟' },
  236390: { en: 'War Thunder', zh: '战争雷霆' },
  4000: { en: "Garry's Mod", zh: '盖瑞模组' },
  739630: { en: 'Phasmophobia', zh: '恐鬼症' },
  1794680: { en: 'Vampire Survivors', zh: '吸血鬼幸存者' },
  1145360: { en: 'Hades', zh: '哈迪斯' },
  367520: { en: 'Hollow Knight', zh: '空洞骑士' },
  1030300: { en: 'Hollow Knight: Silksong', zh: '空洞骑士：丝之歌' },
  582010: { en: 'Monster Hunter: World', zh: '怪物猎人：世界' },
  2246340: { en: 'Monster Hunter Wilds', zh: '怪物猎人：荒野' },
  1172620: { en: 'Sea of Thieves', zh: '盗贼之海' },
  814380: { en: 'Sekiro: Shadows Die Twice', zh: '只狼：影逝二度' },
  292030: { en: 'The Witcher 3: Wild Hunt', zh: '巫师3：狂猎' },
  377160: { en: 'Fallout 4', zh: '辐射4' },
  1151640: { en: 'Apex Legends', zh: 'Apex 英雄' },
  1250410: { en: 'Microsoft Flight Simulator', zh: '微软模拟飞行' },
  2379780: { en: 'Balatro', zh: '小丑牌' },
  1966720: { en: 'Lethal Company', zh: '致命公司' },
  1811260: { en: 'Supermarket Simulator', zh: '超市模拟器' },
  990080: { en: 'Hogwarts Legacy', zh: '霍格沃茨之遗' },
  1817070: { en: "Marvel's Spider-Man Remastered", zh: '漫威蜘蛛侠：复刻版' },
  648800: { en: 'Raft', zh: '木筏求生' },
  244210: { en: 'Assetto Corsa', zh: '神力科莎' },
  632360: { en: 'Risk of Rain 2', zh: '雨中冒险2' },
  322500: { en: "Don't Starve Together", zh: '饥荒联机版' },
  322330: { en: "Don't Starve", zh: '饥荒' },
  1046930: { en: 'Dwarf Fortress', zh: '矮人要塞' },
  1868140: { en: 'DAVE THE DIVER', zh: '潜水员戴夫' },
  2923300: { en: 'Banana', zh: '香蕉' },
  2977660: { en: 'Cats', zh: '猫猫' },
  3014060: { en: 'Egg', zh: '彩蛋' },
  1203620: { en: 'Enshrouded', zh: '雾锁王国' },
  208400: { en: 'Killing Floor 2', zh: '杀戮空间2' },
  1245620: { en: 'ELDEN RING', zh: '艾尔登法环' },
  2358720: { en: 'Black Myth: Wukong', zh: '黑神话：悟空' },
  578080: { en: 'PUBG: BATTLEGROUNDS', zh: '绝地求生' },
  1938010: { en: 'Call of Duty (HQ)', zh: '使命召唤' },
  1517290: { en: 'Battlefield 2042', zh: '战地2042' },
  2807960: { en: 'Battlefield 6', zh: '战地6' },
  2050650: { en: 'Resident Evil 4 (2023)', zh: '生化危机4' },
  1546560: { en: 'Street Fighter 6', zh: '街头霸王6' },
  1446780: { en: 'Life is Strange: True Colors', zh: '奇异人生：本色' },
  2933620: { en: 'Call of Duty: Black Ops 6', zh: '使命召唤：黑色行动6' },
};

/** 过滤空译名，生成两张查询表 */
const byApp = new Map();
const byTitle = new Map(); // normKey(en) → zh
for (const [id, v] of Object.entries(APP_ZH)) {
  if (!v || !v.zh || !v.en) continue;
  byApp.set(String(id), v.zh);
  byTitle.set(norm(v.en), v.zh);
}

function norm(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

/** appId → 中文名（没有返回 ''） */
function zhByApp(appId) {
  return byApp.get(String(Number(appId))) || '';
}

/**
 * 标题 → 中文名。先做词典精确/包含匹配，命中才返回。
 * @param {string} title 原始标题（英文或中英混合）
 * @returns {string} 中文名或 ''
 */
function zhByTitle(title) {
  const key = norm(title);
  if (!key) return '';
  if (byTitle.has(key)) return byTitle.get(key);
  // 词典键与标题互相包含：短键（<8 字符）只允许精确匹配，
  // 否则 rust 会误伤 Rustic Farm Life 这类标题
  for (const [k, zh] of byTitle) {
    if (k.length < 8) continue;
    if (key.includes(k) || k.includes(key)) {
      const shorter = Math.min(k.length, key.length);
      if (shorter >= 8) return zh;
    }
  }
  return '';
}

/** 清洗免费领取类标题：去掉 Giveaway / Steam Key / (Playtest) 等后缀再参与匹配 */
function cleanGiveawayTitle(t) {
  return String(t || '')
    .replace(/（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/\b(steam|gog|epic|humble|fanatical)\b/gi, ' ')
    .replace(/\b(key|keys|gift|giveaway|give\s*away|free|playtest|beta|demo|alpha|dlc)\b/gi, ' ')
    .replace(/\s*-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { zhByApp, zhByTitle, cleanGiveawayTitle, _byApp: byApp, _byTitle: byTitle, EN, ZH };
