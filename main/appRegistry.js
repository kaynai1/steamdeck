'use strict';

/**
 * Steam 社区市场：支持交易的 appid 注册表
 *
 * ★ 为什么需要这个表 ★
 * 库存接口是 /inventory/{steamid}/{appid}/{contextid}，
 * 每个游戏的 contextid 不一定是 2（例如 Steam 本体 753 是 6）。
 * 老版本把游戏写死成 CS2/Dota2/Rust/TF2 四个，导致"只能拉 TF2"。
 * 这里收录所有已知带社区市场的游戏，并给每个游戏正确的 contextid。
 *
 * ★ 但注册表不是上限 ★
 * 任何 appid 只要该账号有物品，库存接口都能拉。所以：
 *   1) 下拉框 = 注册表 ∩ 你库里的游戏
 *   2) 再给一个"自定义 AppID"入口，任何游戏都能填
 *   3) 扫描游戏库时会自动探测哪些游戏真的有物品（见 inventory.discoverApps）
 */

/** contextId 2 = 游戏内物品；6 = Steam 本体（卡牌/背景/表情/宝石） */
const CTX_ITEM = 2;
const CTX_STEAM = 6;

/** appId -> { name, ctx } */
const MARKET_APPS = {
  // ===== Steam 本体 =====
  753: { name: 'Steam 本体（卡牌/背景/表情）', ctx: CTX_STEAM },

  // ===== Valve =====
  730: { name: 'Counter-Strike 2', ctx: CTX_ITEM },
  570: { name: 'Dota 2', ctx: CTX_ITEM },
  440: { name: 'Team Fortress 2', ctx: CTX_ITEM },
  620: { name: 'Portal 2', ctx: CTX_ITEM },
  4000: { name: "Garry's Mod", ctx: CTX_ITEM },
  550: { name: 'Left 4 Dead 2', ctx: CTX_ITEM },
  240: { name: 'Counter-Strike: Source', ctx: CTX_ITEM },
  300: { name: 'Day of Defeat: Source', ctx: CTX_ITEM },
  320: { name: 'Half-Life 2: Deathmatch', ctx: CTX_ITEM },
  340: { name: 'Half-Life 2: Lost Coast', ctx: CTX_ITEM },
  360: { name: 'Half-Life Deathmatch: Source', ctx: CTX_ITEM },
  380: { name: 'Half-Life 2: Episode One', ctx: CTX_ITEM },
  420: { name: 'Half-Life 2: Episode Two', ctx: CTX_ITEM },
  500: { name: 'Left 4 Dead', ctx: CTX_ITEM },
  700: { name: 'Dota 2 Test', ctx: CTX_ITEM },
  1250: { name: 'Killing Floor', ctx: CTX_ITEM },
  5500: { name: 'Killing Floor Mod', ctx: CTX_ITEM },

  // ===== 热门第三方带市场 =====
  252490: { name: 'Rust', ctx: CTX_ITEM },
  304930: { name: 'Unturned', ctx: CTX_ITEM },
  107410: { name: 'Arma 3', ctx: CTX_ITEM },
  236390: { name: 'War Thunder', ctx: CTX_ITEM },
  238960: { name: 'Path of Exile', ctx: CTX_ITEM },
  578080: { name: 'PUBG: BATTLEGROUNDS', ctx: CTX_ITEM },
  359550: { name: "Tom Clancy's Rainbow Six Siege", ctx: CTX_ITEM },
  271590: { name: 'Grand Theft Auto V', ctx: CTX_ITEM },
  292030: { name: 'The Witcher 3: Wild Hunt', ctx: CTX_ITEM },
  489830: { name: 'Skyrim Special Edition', ctx: CTX_ITEM },
  377160: { name: 'Fallout 4', ctx: CTX_ITEM },
  218620: { name: 'PAYDAY 2', ctx: CTX_ITEM },
  236110: { name: 'Dungeon Defenders', ctx: CTX_ITEM },
  244850: { name: 'Space Engineers', ctx: CTX_ITEM },
  251570: { name: '7 Days to Die', ctx: CTX_ITEM },
  261550: { name: 'Mount & Blade II: Bannerlord', ctx: CTX_ITEM },
  268500: { name: 'Mount & Blade: Warband', ctx: CTX_ITEM },
  289070: { name: "Sid Meier's Civilization VI", ctx: CTX_ITEM },
  289650: { name: "Assassin's Creed Unity", ctx: CTX_ITEM },
  311210: { name: 'Call of Duty: Black Ops III', ctx: CTX_ITEM },
  332800: { name: 'Five Nights at Freddy\'s 3', ctx: CTX_ITEM },
  346110: { name: 'ARK: Survival Evolved', ctx: CTX_ITEM },
  391220: { name: "Rise of the Tomb Raider", ctx: CTX_ITEM },
  413150: { name: 'Stardew Valley', ctx: CTX_ITEM },
  431960: { name: 'Wallpaper Engine', ctx: CTX_ITEM },
  453480: { name: 'Shadowverse', ctx: CTX_ITEM },
  465240: { name: 'The Dead Linger', ctx: CTX_ITEM },
  49520: { name: 'Borderlands 2', ctx: CTX_ITEM },
  49540: { name: 'Borderlands: The Pre-Sequel', ctx: CTX_ITEM },
  8980: { name: 'Borderlands: Game of the Year', ctx: CTX_ITEM },
  200260: { name: 'Batman: Arkham City GOTY', ctx: CTX_ITEM },
  208650: { name: 'Batman: Arkham Knight', ctx: CTX_ITEM },
  232090: { name: 'Killing Floor 2', ctx: CTX_ITEM },
  233860: { name: 'Kenshi', ctx: CTX_ITEM },
  242760: { name: 'The Forest', ctx: CTX_ITEM },
  250320: { name: 'The Binding of Isaac: Rebirth', ctx: CTX_ITEM },
  255710: { name: 'Cities: Skylines', ctx: CTX_ITEM },
  264710: { name: 'Subnautica', ctx: CTX_ITEM },
  268910: { name: 'Cuphead', ctx: CTX_ITEM },
  281990: { name: 'Stellaris', ctx: CTX_ITEM },
  286160: { name: 'Tabletop Simulator', ctx: CTX_ITEM },
  294100: { name: 'RimWorld', ctx: CTX_ITEM },
  322330: { name: "Don't Starve Together", ctx: CTX_ITEM },
  346900: { name: 'Frostpunk', ctx: CTX_ITEM },
  364360: { name: 'Total War: WARHAMMER', ctx: CTX_ITEM },
  365590: { name: 'Payday 2 Beta', ctx: CTX_ITEM },
  367520: { name: 'Hollow Knight', ctx: CTX_ITEM },
  374320: { name: 'Dark Souls III', ctx: CTX_ITEM },
  377840: { name: 'Final Fantasy IX', ctx: CTX_ITEM },
  387990: { name: 'Infestation: Survivor Stories', ctx: CTX_ITEM },
  392160: { name: 'X4: Foundations', ctx: CTX_ITEM },
  394360: { name: 'Hearts of Iron IV', ctx: CTX_ITEM },
  400170: { name: 'Delver', ctx: CTX_ITEM },
  401710: { name: 'Zombie Army Trilogy', ctx: CTX_ITEM },
  412220: { name: 'Divinity: Original Sin 2', ctx: CTX_ITEM },
  435150: { name: 'Divinity: Original Sin 2 DE', ctx: CTX_ITEM },
  460950: { name: 'Katana Zero', ctx: CTX_ITEM },
  477160: { name: 'Human: Fall Flat', ctx: CTX_ITEM },
  524220: { name: 'NieR:Automata', ctx: CTX_ITEM },
  548430: { name: 'Deep Rock Galactic', ctx: CTX_ITEM },
  552500: { name: 'Warhammer: Vermintide 2', ctx: CTX_ITEM },
  582010: { name: 'Monster Hunter: World', ctx: CTX_ITEM },
  588650: { name: 'Dead Cells', ctx: CTX_ITEM },
  632360: { name: 'Risk of Rain 2', ctx: CTX_ITEM },
  648800: { name: 'Raft', ctx: CTX_ITEM },
  739630: { name: 'Phasmophobia', ctx: CTX_ITEM },
  761890: { name: 'Citadel: Forged with Fire', ctx: CTX_ITEM },
  814380: { name: 'Sekiro: Shadows Die Twice', ctx: CTX_ITEM },
  892970: { name: 'Valheim', ctx: CTX_ITEM },
  945360: { name: 'Among Us', ctx: CTX_ITEM },
  990080: { name: 'Hogwarts Legacy', ctx: CTX_ITEM },
  1091500: { name: 'Cyberpunk 2077', ctx: CTX_ITEM },
  1172470: { name: 'Apex Legends', ctx: CTX_ITEM },
  1245620: { name: 'ELDEN RING', ctx: CTX_ITEM },
  1599340: { name: 'Lost Ark', ctx: CTX_ITEM },
  1966720: { name: 'Lethal Company', ctx: CTX_ITEM },
};

/** 补：更多只做市场常见的第三方（避免遗漏） */
const EXTRA = {
  205790: "Dota 2 Test",
  247040: "Dead Island: Epidemic",
  265630: "Chivalry: Medieval Warfare",
  295110: "Just Survive",
  306130: "The Elder Scrolls Online",
  323190: "Farming Simulator 15",
  327070: "GRAV",
  353120: "Black Desert Online",
  434050: "Duke Nukem 3D: Megaton Edition",
  443710: "9th Dawn II",
  505460: "Foxhole",
  578900: "Okami HD",
  582500: "Warhammer: Vermintide 2 - Collector",
  599140: "Graveyard Keeper",
  601150: "Devil May Cry 5",
  632470: "Disco Elysium",
  678960: "CODE VEIN",
  728880: "Overcooked! 2",
  750920: "Shadow of the Tomb Raider",
  883710: "Resident Evil 2",
  952060: "Resident Evil 3",
  1062520: "Persona 5 Royal",
  1144200: "Ready or Not",
  1174180: "Red Dead Redemption 2",
  1203220: "NARAKA: BLADEPOINT",
  1237970: "Titanfall 2",
  1446780: "Monster Hunter Rise",
  1817070: "Marvel's Spider-Man Remastered",
  1888930: "The Last of Us Part I",
  1938090: "Call of Duty HQ",
  2050650: "Resident Evil 4",
  2358720: "Black Myth: Wukong",
};
for (const [k, v] of Object.entries(EXTRA)) {
  if (!MARKET_APPS[k]) MARKET_APPS[k] = { name: v, ctx: CTX_ITEM };
}

/** 探测时优先尝试的高价值游戏（有物品概率大，先试这些） */
const PROBE_PRIORITY = [
  753, 730, 570, 440, 252490, 620, 4000, 550, 304930, 107410,
  236390, 238960, 578080, 359550, 271590, 292030, 218620, 346110,
  431960, 367520, 413150, 892970, 1091500, 1245620,
];

function ctxOf(appId) {
  const a = MARKET_APPS[Number(appId)];
  return a ? a.ctx : CTX_ITEM;
}

function nameOf(appId) {
  const a = MARKET_APPS[Number(appId)];
  return a ? a.name : `App ${appId}`;
}

function isKnown(appId) {
  return !!MARKET_APPS[Number(appId)];
}

/** 注册表全量（给"全部支持的平台"下拉兜底用） */
function all() {
  return Object.entries(MARKET_APPS)
    .map(([id, v]) => ({ appId: Number(id), name: v.name, ctx: v.ctx }))
    .sort((a, b) => (PROBE_PRIORITY.indexOf(a.appId) + 1 || 999) - (PROBE_PRIORITY.indexOf(b.appId) + 1 || 999) || a.name.localeCompare(b.name));
}

module.exports = {
  MARKET_APPS,
  CTX_ITEM,
  CTX_STEAM,
  PROBE_PRIORITY,
  ctxOf,
  nameOf,
  isKnown,
  all,
};
