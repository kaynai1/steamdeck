'use strict';

/* ==========================================================================
   SteamDesk 渲染层
   原则：
    1. 所有网络/文件操作都走 window.api，渲染层不直接碰 Node
    2. 价格一切以"元"显示、以"元"提交，换算在后端做
    3. 上架前必须能看清"挂单价 / 到手多少"，不能让用户盲点
   ========================================================================== */

// 注意：Electron 的 contextBridge 会在页面全局作用域里创建变量 `api`，
// 这里若再写 `const api = window.api` 会抛 SyntaxError 导致整个脚本不执行，
// 表现为"界面能显示但全部按钮点不动"。因此改用不冲突的局部名。
const SD = window.api;

const S = {
  info: null,
  settings: null,
  accounts: [],
  // SteamID64 -> dataURL；读的是 Steam 客户端本地头像缓存，没有的继续用昵称首字
  avatars: {},
  avatarsLoading: false,
  currentSteamId: null,
  invRows: [],                     // 聚合后的"物品组"，一行 = 一种物品
  invExpanded: new Set(),          // 展开了明细的组
  invView: { q: '', filter: 'all', cat: 'all', sort: 'qty', limit: 150 },
  invMeta: null,
  selected: new Set(),
  quotes: {},
  listings: null,
  // 浏览器扩展采集到的网页价格：{ marketHashName: { price, at, appId } }
  webPrices: {},
  lib: [],
  libApp: 'all',
  libQuery: '',
  libShape: 'wide',
  libSource: 'steam',
  epicLib: { items: [], loading: false, accountId: '', at: 0, error: '', partial: false },
  gogLib: { items: [], loading: false, at: 0, error: '', linked: false },
  logs: [],
  switching: false,
  selling: false,
  free: {
    items: [], filter: 'all', at: 0, errors: [], loaded: false, loading: false,
    gameOnly: false, claimed: {}, busy: false,
    // 自动领取失败的条目：卡片上额外给一个「网页领取」入口（item.id → true）
    webFallback: {},
    // 最近一次领取的逐条结果，用于顶部结果面板（失败原因 / 重试）
    lastRun: null,
  },
  epic: { linked: false, displayName: '', busy: false },
  steamFree: { linked: false },
  gogFree: { linked: false },
  // Steam 成交历史（当前网页登录账号，含其它软件/网页成交）
  mh: { items: [], loading: false, kind: 'sell', page: 0, total: 0, at: 0, steamId: '', truncated: false, error: '' },
  // 价格提醒（主进程 settings.priceAlerts 的镜像）
  priceAlerts: [],
  // 成交历史里是否展开了收益统计
  mhStats: false,
  // 库存页是否处于「全部账号汇总」模式
  invAll: false,
  // 成本价记录（当前账号）：{ marketHashName: { cost, at } }
  costs: {},
  costAcc: '',
  // 挂单页多选：assetId 集合
  ordSel: new Set(),
  // 挂单页：只看超过 7 天的滞销挂单
  ordStaleOnly: false,
  // 挂单页分页：一次渲染这么多行，避免上千条挂单把界面卡死
  ordLimit: 200,
};

/** 库存列表每页渲染多少组。一次渲染上千行 DOM 会直接把界面卡死。 */
const INV_PAGE = 150;
/** 展开单件时最多列多少条 */
const ASSET_PAGE = 100;

/* --------------------------------- 工具函数 -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const money = (n) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Steam 市场手续费（人民币）：5% + 发行商 10%，各自向下取整、各自最低 ¥0.07。
 * 低价物品几乎全是两份最低手续费（共 ¥0.14），所以不能再用"除以 1.15"估算。
 * 例：买家付 0.30 → 卖家到手 0.16；买家付 1.00 → 到手 0.85。
 */
const FEE_MIN_CENTS = 7;
const feeCentsOfSeller = (sellerCents) => {
  const s = Math.max(0, Math.floor(Number(sellerCents) || 0));
  return Math.max(FEE_MIN_CENTS, Math.floor(s * 0.05)) + Math.max(FEE_MIN_CENTS, Math.floor(s * 0.1));
};
const grossCentsOf = (sellerCents) => {
  const s = Math.max(0, Math.floor(Number(sellerCents) || 0));
  return s ? s + feeCentsOfSeller(s) : 0;
};
/** 买家实付（分）→ 卖家到手（分）：二分找不超过实付的最大到手额 */
const sellerCentsFor = (grossCents) => {
  const g = Math.max(0, Math.floor(Number(grossCents) || 0));
  if (!g) return 0;
  let lo = 0;
  let hi = g;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (grossCentsOf(mid) <= g) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};
/** 给定买家实付价（元），算出卖家到手（元） */
const netOf = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return sellerCentsFor(Math.round(n * 100)) / 100;
};

/**
 * 挂单到手金额。
 * Steam 的挂单接口会直接给出结算额（netYuan），比本地按手续费模型估算更准——
 * 低价物品有最低手续费，0.45 的挂单实际到手并不是 0.39。
 */
function netOfListing(info) {
  const n = Number(info && info.netYuan);
  if (Number.isFinite(n) && n > 0) return n;
  const p = Number(info && info.price) || 0;
  return p > 0 ? netOf(p) : 0;
}

const initial = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

/** 把底层网络错误换成用户看得懂的话 */
const netText = (msg) => {
  const s = String(msg || '');
  if (/ERR_CONNECTION|ERR_NAME|ERR_NETWORK|timed out|超时|ECONN|ENOTFOUND|ETIMEDOUT/i.test(s)) {
    return '连不上 Steam 社区（网络或代理问题），检查网络后再试';
  }
  return s || '请求失败';
};

let toastTimer = null;
function toast(msg, isErr) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast on' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast' + (isErr ? ' err' : ''); }, 2600);
}

/** 点卡片上的文字直接复制到剪贴板 */
async function copyText(text, what) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return;
  const r = await call(SD.clipboard.write(s), { noLog: true, silent: true });
  toast(r.ok ? `已复制${what ? ' ' + what : ''}` : '复制失败，请重试', !r.ok);
}

function status(text, detail) {
  $('#sbLeft').textContent = text || '就绪';
  if (detail !== undefined) $('#sbRight').textContent = detail || '';
}

/**
 * 应用内确认弹窗（替代 window.confirm）。
 * 系统 MessageBox 停在应用外面：不跟随主题、不能选中数字、按钮样式被系统接管，
 * 用户看到的就是"太简陋"。这里用和更新弹窗同一套外观，并把关键数字排成表格。
 *
 * @param {object} o
 * @param {string} o.title    标题
 * @param {string} [o.sub]    副标题
 * @param {Array}  [o.rows]   [{ k:'挂单总额', v:'¥12.30', cls:'green' }]
 * @param {string[]} [o.notes] 底部说明
 * @param {string} [o.okText] 确认按钮文字
 * @param {'info'|'warn'|'danger'} [o.tone] 图标颜色
 * @param {string} [o.icon]   图标字符，默认随 tone
 * @returns {Promise<boolean>} 用户是否点了确认
 */
function askConfirm(o = {}) {
  const box = $('#askModal');
  if (!box) return Promise.resolve(window.confirm(o.title || '确认操作？'));

  const tone = o.tone || 'info';
  const ico = $('#askIco');
  ico.className = 'ask-ico' + (tone === 'info' ? '' : ' ' + tone);
  ico.textContent = o.icon || (tone === 'danger' ? '!' : tone === 'warn' ? '!' : '?');
  $('#askTitle').textContent = o.title || '确认操作';
  $('#askSub').textContent = o.sub || '';
  $('#askSub').style.display = o.sub ? '' : 'none';

  const grid = $('#askGrid');
  grid.innerHTML = (o.rows || [])
    .filter(Boolean)
    .map(
      (r) =>
        `<div class="ask-row"><span class="k">${esc(r.k)}</span>` +
        `<span class="v ${r.cls || ''}">${esc(String(r.v))}</span></div>`
    )
    .join('');
  grid.style.display = (o.rows || []).length ? '' : 'none';

  const notes = $('#askNotes');
  notes.innerHTML = (o.notes || [])
    .filter(Boolean)
    .map((n) => `<li>${esc(n)}</li>`)
    .join('');
  notes.style.display = (o.notes || []).length ? '' : 'none';

  const okBtn = $('#askOk');
  const cancelBtn = $('#askCancel');
  okBtn.textContent = o.okText || '确认';
  okBtn.className = 'btn p' + (tone === 'danger' ? ' danger' : '');

  // 敏感操作：必须手动输入件数/金额才能确认，防手滑点快了
  const typedWrap = $('#askTypedWrap');
  const typed = $('#askTyped');
  const typedLabel = $('#askTypedLabel');
  const need = o.confirmText ? String(o.confirmText) : '';
  if (typedWrap) typedWrap.style.display = need ? '' : 'none';
  if (typedLabel) typedLabel.textContent = need ? o.confirmLabel || `输入「${need}」以确认` : '';
  if (typed) typed.value = '';
  okBtn.disabled = !!need;

  box.classList.add('on');
  if (need && typed) setTimeout(() => typed.focus(), 60);

  return new Promise((resolve) => {
    let settled = false;
    const typedOk = () => !need || (typed && typed.value.trim() === need);
    const finish = (val) => {
      if (settled) return;
      settled = true;
      box.classList.remove('on');
      okBtn.disabled = false;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      box.removeEventListener('click', onMask);
      document.removeEventListener('keydown', onKey, true);
      if (typed) typed.removeEventListener('input', onTyped);
      resolve(val);
    };
    const onTyped = () => {
      okBtn.disabled = !typedOk();
    };
    if (typed) typed.addEventListener('input', onTyped);
    const onOk = () => {
      if (!typedOk()) return;
      finish(true);
    };
    const onCancel = () => finish(false);
    // 点遮罩空白处 = 取消；点弹窗内部不关
    const onMask = (e) => {
      if (e.target === box) finish(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === 'Enter' && document.activeElement !== cancelBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (!okBtn.disabled) finish(true);
      }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    box.addEventListener('click', onMask);
    // 捕获阶段拦截，避免回车同时触发背后的输入框
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 30);
  });
}

function log(text, tone) {
  S.logs.unshift({ text, tone: tone || 'n', at: Date.now() });
  if (S.logs.length > 40) S.logs.length = 40;
  renderLogs();
  // 同步落盘一份，出问题时诊断包里能看到界面上发生过什么
  if (SD.diag && SD.diag.log) SD.diag.log(text, tone || 'n');
}

/** 统一处理 api 返回的 { ok, data, error } 包装 */
async function call(promise, opts = {}) {
  try {
    const res = await promise;
    if (res && res.ok === false) {
      const msg = (res.error && res.error.message) || '操作失败';
      if (!opts.silent) toast(msg, true);
      if (!opts.noLog) log(msg, 'r');
      return { ok: false, error: res.error, message: msg };
    }
    return { ok: true, data: res ? res.data : undefined };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!opts.silent) toast(msg, true);
    if (!opts.noLog) log(msg, 'r');
    return { ok: false, message: msg };
  }
}

/* --------------------------------- 页面切换 -------------------------------- */

function goto(page) {
  S.page = page;
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  $$('.pg').forEach((p) => p.classList.toggle('on', p.dataset.p === page));
  if (page === 'orders' && !S.listings) syncOrders({ quiet: true });
  if (page === 'overview') {
    renderCostOverview();
    renderTodo();
    renderTasks();
  }
  if (page === 'library' && S.libSource === 'steam' && !S.lib.length) scanLibrary({ quiet: true });
  // 进库存页时保证"所有支持交易市场的游戏"都在下拉里可选
  if (page === 'inventory') ensureInvAppOptions();
  if (page === 'storeNews') {
    if (!idleStatsCache.length) loadIdleGames();
    renderStoreAlerts();
  }
  if (page === 'dailyDeals') {
    if (!dealData) loadDailyDeals();
    else renderDeals();
  }
  if (page === 'free' && !S.free.loaded) loadFree({ quiet: true });
}

$$('.nav').forEach((b) => b.addEventListener('click', () => goto(b.dataset.page)));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) goto(go.dataset.go);
});

/* --------------------------------- 窗口控制 -------------------------------- */

$('#winMin').onclick = () => SD.app.minimize();
$('#winMax').onclick = () => SD.app.maximize();
$('#winClose').onclick = () => SD.app.close();

/* --------------------------------- 外观主题 -------------------------------- */

// 默认浅色：首屏白底更像 Win11 原生应用，也避免新用户一打开就是"黑乎乎一片"
let currentTheme = localStorage.getItem('steamdesk_theme') || 'light';

function applyTheme(theme, notify = false) {
  currentTheme = theme;
  localStorage.setItem('steamdesk_theme', theme);

  const root = document.documentElement;
  const isSysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;

  if (theme === 'light') {
    root.dataset.theme = 'light';
  } else if (theme === 'dark') {
    root.dataset.theme = 'dark';
  } else {
    // auto: 跟随系统
    delete root.dataset.theme;
  }

  syncThemeSeg(theme);
  updateThemeIcon();

  if (notify) {
    const desc = theme === 'auto'
      ? `跟随系统（当前呈现${isSysLight ? '浅色白底' : '深色暗黑'}）`
      : theme === 'light'
      ? '浅色模式（清爽白底）'
      : '深色模式（经典暗黑）';
    toast(`外观已设为：${desc}`);
  }
}

function syncThemeSeg(theme) {
  const box = $('#setTheme');
  if (!box) return;
  box.querySelectorAll('[data-theme]').forEach((b) => {
    b.classList.toggle('on', b.dataset.theme === theme);
  });
}

function updateThemeIcon() {
  const btn = $('#btnTheme');
  if (!btn) return;
  const isSysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const activeLight = currentTheme === 'light' || (currentTheme === 'auto' && isSysLight);

  btn.title = `外观模式：${currentTheme === 'auto' ? '跟随系统' : currentTheme === 'light' ? '浅色白底' : '深色暗黑'}（点击切换）`;
  if (activeLight) {
    btn.innerHTML = `<svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v1.8M8 12.7V14.5M1.5 8h1.8M12.7 8H14.5M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/></svg>`;
  } else {
    btn.innerHTML = `<svg class="ico" viewBox="0 0 16 16"><path d="M13.2 9.8A5.5 5.5 0 116.2 2.8a5 5 0 007 7z"/></svg>`;
  }
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (currentTheme === 'auto') {
      updateThemeIcon();
    }
  });
}

if ($('#btnTheme')) {
  $('#btnTheme').onclick = () => {
    const cycle = { auto: 'light', light: 'dark', dark: 'auto' };
    const next = cycle[currentTheme] || 'auto';
    applyTheme(next, true);
  };
}

if ($('#setTheme')) {
  $('#setTheme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (b && b.dataset.theme !== currentTheme) applyTheme(b.dataset.theme, true);
  });
}

if ($('#setStoreRegion')) {
  $('#setStoreRegion').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-region]');
    if (!b) return;
    $$('#setStoreRegion .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    const r = await call(SD.settings.set({ storeRegion: b.dataset.region }), { silent: true });
    if (r.ok) {
      S.settings = r.data;
      toast(`商店区服已切到${b.textContent}`);
    }
  });
}

// 启动时初始化主题
applyTheme(currentTheme, false);

/* --------------------------------- 设置抽屉 -------------------------------- */

const drawer = $('#drawer');
const drawerMask = $('#drawerMask');

function openDrawer() {
  fillSettingsForm();
  drawer?.classList.add('on');
  drawerMask?.classList.add('on');
}

function closeDrawer() {
  drawer?.classList.remove('on');
  drawerMask?.classList.remove('on');
}

$('#btnSettings').onclick = openDrawer;
$('#drawerClose').onclick = closeDrawer;
if (drawerMask) drawerMask.onclick = closeDrawer;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawer?.classList.contains('on')) {
    closeDrawer();
  }
});

/* ------------------------------ 手机令牌与待确认 -----------------------------
 * 导入 maFile 之后，挂单可以在软件里直接批准（/mobileconf/ajaxop），
 * 不需要再打开网页、更不用掏手机。没导入就退回原来的网页确认窗口。
 */
async function guardStatus() {
  const r = await call(SD.guard.status(), { noLog: true, silent: true });
  return (r.ok && r.data) || { linked: false };
}

async function refreshGuardStatus() {
  const btn = $('#accGuard');
  if (!btn) return;
  const d = await guardStatus();
  if (d.linked) {
    btn.textContent = '手机令牌已导入 ✓';
    btn.title = `已绑定 ${d.accountName || d.steamId || ''}：上架后会在软件内自动确认，不用手机`;
    if ($('#accGuardDel')) $('#accGuardDel').style.display = '';
    log(`手机令牌已绑定：${d.accountName || d.steamId || ''}（上架可自动确认）`, 'g');
  } else {
    btn.textContent = '导入手机令牌';
    btn.title = '导入 SDA 导出的 .maFile；导入后挂单可在软件内直接确认，不用再掏手机';
    if ($('#accGuardDel')) $('#accGuardDel').style.display = 'none';
  }
  // 挂单页的确认入口跟着换文案：导入令牌后就是"软件内确认"
  const oc = $('#ordConfirm');
  if (oc) {
    oc.textContent = d.linked ? '软件内确认' : '手机确认';
    oc.title = d.linked
      ? '直接在软件内批准待确认挂单（已导入手机令牌）'
      : '打开 Steam 市场待确认清单（挂单需手机令牌确认）';
  }
}

// 账号管理里的「添加 Epic 账号」：登录窗口每登录一次就多存一个号
if ($('#epicAdd')) {
  $('#epicAdd').onclick = () => epicLogin();
}

if ($('#gogAdd')) {
  $('#gogAdd').onclick = () => gogAccountLogin();
}

/** 账号管理里的 GOG 登录；登录成功后刷新这一块和免费页状态条 */
async function gogAccountLogin() {
  toast('已打开 GOG 登录窗口，请在窗口里完成登录');
  const r = await call(SD.gog.login(), { noLog: true, silent: true });
  if (!r.ok) {
    if (!/已关闭/.test(r.message || '')) toast(r.message || 'GOG 登录失败', true);
    return;
  }
  await loadGogAccount();
  await loadFreeAccounts();
  toast('GOG 登录成功');
}

async function loadGogAccount() {
  const box = $('#gogAccList');
  if (!box) return;
  const r = await call(SD.gog.status(), { noLog: true, silent: true });
  const d = (r.ok && r.data) || { linked: false };
  S.gogFree.linked = !!d.linked;
  if ($('#gogAccCount')) $('#gogAccCount').textContent = d.linked ? '1 个' : '';
  if (d.linked) {
    box.innerHTML = `<div class="acard on">
      <div class="top">
        <div class="av2" style="background:linear-gradient(135deg,#D9C2F0,#7C2AA0)">G</div>
        <div style="min-width:0">
          <div class="nm">GOG</div>
          <div class="sub">gog.com</div>
        </div>
        <div class="st2 on"><span class="dot"></span>已登录</div>
      </div>
      <div class="ast">
        <div data-copy="${d.total ? `${d.total} 个游戏` : '未同步'}" data-copy-label="GOG 游戏库" title="点击复制"><div class="k">游戏库</div><div class="v">${
          d.total ? `${d.total} 个游戏` : '未同步'
        }</div></div>
        <div data-copy="可直接领取" data-copy-label="GOG 赠送领取" title="点击复制"><div class="k">赠送领取</div><div class="v">可直接领取</div></div>
      </div>
      <div class="arow">
        <button class="btn s" data-gog-relogin>重新登录</button>
        <button class="btn s" data-gog-logout style="margin-left:auto">退出登录</button>
      </div>
    </div>`;
  } else {
    box.innerHTML =
      '<div class="empty" style="grid-column:1/-1"><b>还没有登录 GOG</b>点右上「登录 GOG」，在弹出的窗口里登录；登录后可领取赠送、拉取 GOG 游戏库。</div>';
  }
  box.querySelectorAll('[data-gog-relogin]').forEach((b) => {
    b.onclick = () => gogAccountLogin();
  });
  box.querySelectorAll('[data-gog-logout]').forEach((b) => {
    b.onclick = async () => {
      await call(SD.gog.logout(), { noLog: true, silent: true });
      S.gogLib.items = [];
      await loadGogAccount();
      await loadFreeAccounts();
      toast('已退出 GOG');
    };
  });
  renderEpicBar();
}

if ($('#accGuard')) {
  $('#accGuard').onclick = () => openGuardModal();
}

/* 导入令牌弹窗：文件选择只是入口，真正落盘走同一条 link() 路径 */
function openGuardModal() {
  if (!$('#guardModal')) return;
  $('#guardText').value = '';
  setGuardMsg('');
  $('#guardModal').classList.add('on');
  setTimeout(() => { try { $('#guardText').focus(); } catch { /* ignore */ } }, 60);
}
function closeGuardModal() {
  $('#guardModal').classList.remove('on');
}
function setGuardMsg(text, kind) {
  const el = $('#guardMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'guard-msg' + (kind ? ' ' + kind : '');
}

/** 导入成功后的统一善后：刷新状态 + 立刻用密钥读一次确认列表做校验 */
async function afterGuardLinked(info) {
  closeGuardModal();
  if (info && info.mismatch) {
    toast('这个 maFile 属于另一个账号，已存到该账号名下；切换账号后生效', true);
    log(`令牌属于账号 ${info.steamId}，与当前登录账号不一致`, 'a');
    refreshGuardStatus().catch(() => {});
    return;
  }
  toast(`手机令牌已导入${info && info.accountName ? '：' + info.accountName : ''}`, false);
  log('已导入手机令牌：之后上架会在软件内自动确认，无需手机操作', 'g');
  await refreshGuardStatus();
  const chk = await call(SD.guard.check(), { noLog: true, silent: true });
  if (chk.ok && chk.data) {
    log(`令牌校验通过：当前待确认 ${chk.data.count} 项（其中市场挂单 ${chk.data.market} 项）`, 'g');
    toast(`令牌可用，当前待确认 ${chk.data.count} 项`, false);
  } else {
    const msg = chk.message || '无法校验';
    log(`令牌已保存，但校验未通过：${msg}`, 'r');
    toast(`令牌已保存，但校验失败：${msg}`, true);
  }
}

if ($('#guardModal')) {
  $('#guardCancel').onclick = closeGuardModal;
  $('#guardModal').addEventListener('click', (e) => {
    if (e.target === $('#guardModal')) closeGuardModal();
  });

  $('#guardPick').onclick = async () => {
    setGuardMsg('正在打开文件选择框…');
    const r = await call(SD.guard.import(), { noLog: true, silent: true });
    if (!r.ok) {
      setGuardMsg(r.message || '导入失败', 'err');
      return;
    }
    if (r.data === null || r.data === undefined) {
      setGuardMsg(''); // 用户取消了文件选择
      return;
    }
    afterGuardLinked(r.data);
  };

  $('#guardPaste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t || !t.trim()) {
        setGuardMsg('剪贴板里没有文字', 'err');
        return;
      }
      $('#guardText').value = t.trim();
      setGuardMsg('已粘贴，点「导入并校验」');
    } catch {
      setGuardMsg('读不到剪贴板，请手动 Ctrl+V 粘贴', 'err');
    }
  };

  $('#guardOk').onclick = async () => {
    const text = ($('#guardText').value || '').trim();
    if (!text) {
      setGuardMsg('请先选择 .maFile 文件，或把 maFile 内容粘到上面', 'err');
      return;
    }
    setGuardMsg('正在校验密钥…');
    const r = await call(SD.guard.importText(text), { noLog: true, silent: true });
    if (!r.ok) {
      setGuardMsg(r.message || '导入失败', 'err');
      return;
    }
    setGuardMsg('导入成功', 'ok');
    afterGuardLinked(r.data);
  };
}

if ($('#accGuardDel')) {
  $('#accGuardDel').onclick = async () => {
    const ok = await askConfirm({
      title: '移除已导入的手机令牌？',
      sub: '移除后上架仍需在手机 Steam 里确认',
      tone: 'warn',
      icon: '!',
      notes: ['令牌文件本身不会被动删除，只是本软件不再保存它的密钥。'],
      okText: '确认移除',
    });
    if (!ok) return;
    await call(SD.guard.unlink(), { noLog: true, silent: true });
    toast('已移除手机令牌');
    refreshGuardStatus();
  };
}

async function openMobileConfirm() {
  const st = await guardStatus();
  if (st.linked) {
    // 软件内确认：走 identity_secret 签名，等价于手机 App 上点"确认"
    toast('正在软件内确认挂单…');
    const r = await call(SD.guard.confirm({}), { noLog: true, silent: true });
    if (!r.ok) {
      toast(r.message || '软件内确认失败', true);
      log(`软件内确认失败：${r.message || '未知原因'}`, 'r');
      return;
    }
    const d = r.data || {};
    if (!d.targeted) {
      toast('当前没有待确认的挂单（确认项可能还没生成，稍后再试）', false);
      return;
    }
    if (d.confirmed > 0) {
      toast(`已在软件内确认 ${d.confirmed} 件`, false);
      log(`软件内确认成功：${d.confirmed}/${d.targeted} 件`, 'g');
      syncOrders({ quiet: true });
    } else {
      const err = (d.failed && d.failed[0] && d.failed[0].error) || '未知原因';
      toast(`确认失败：${err}`, true);
      log(`软件内确认失败：${err}`, 'r');
    }
    return;
  }
  toast('正在打开 Steam 市场待确认清单…');
  const r = await call(SD.session.openMobileConf(), { noLog: true, silent: true });
  if (!r.ok) toast(r.message || '确认窗口打开失败', true);
}
if ($('#btnMobileConf')) {
  $('#btnMobileConf').onclick = () => openMobileConfirm();
}
if ($('#ordConfirm')) {
  $('#ordConfirm').onclick = () => openMobileConfirm();
}

/* 版本更新检查 */
function updatePillText() {
  const m = $('#updateModal');
  if (!m) return;
  const ver = ($('#ver') && $('#ver').textContent) || (S.info && S.info.version) || '';
  const pill = m.querySelector('.update-head .pill');
  if (pill && ver) pill.textContent = `v${String(ver).replace(/^v/i, '')}`;
}

/** 把检查结果渲染到弹窗顶部的状态行 */
function renderUpdateResult(d) {
  const el = $('#updateCheckResult');
  if (!el) return;
  if (!d) {
    el.innerHTML = '';
    return;
  }
  if (d.hasUpdate) {
    el.innerHTML =
      `<div style="color:var(--green);font-weight:600;font-size:12.5px;margin-bottom:4px">发现新版本 v${esc(
        d.latest
      )}（当前 v${esc(d.current)}）</div>` +
      (d.notes ? `<div class="dim2" style="font-size:11.5px;margin-bottom:6px;white-space:pre-wrap">${esc(String(d.notes).slice(0, 500))}</div>` : '') +
      (d.url
        ? `<button class="btn p" id="updateGoBtn" style="height:28px">打开下载页</button>`
        : `<div class="dim2" style="font-size:11.5px">发布页没有找到安装包，可到仓库 Releases 页手动下载</div>`);
    const go = $('#updateGoBtn');
    if (go) {
      go.onclick = async () => {
        const r = await call(SD.update.open(d.url), { silent: true });
        if (!r.ok) toast(r.message || '打开下载页失败', true);
      };
    }
  } else if (d.noRelease) {
    el.innerHTML =
      `<div class="dim2" style="font-size:11.5px">当前 v${esc(d.current)} · 发布仓库还没有 Release，暂时无法联网检查新版</div>`;
  } else {
    el.innerHTML =
      `<div style="color:var(--green);font-size:12.5px">已是最新版本 v${esc(d.current)}</div>`;
  }
}

/** 真正的联网检查：默认用 GitHub Releases，填了自定义更新源则优先自定义 */
async function runUpdateCheck(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检查中…';
  const el = $('#updateCheckResult');
  if (el) el.innerHTML = '<div class="dim2" style="font-size:11.5px">正在连接更新源…</div>';
  const r = await call(SD.update.check(), { silent: true });
  btn.disabled = false;
  btn.textContent = old;
  if (!r.ok) {
    if (el) el.innerHTML = `<div style="color:var(--red);font-size:11.5px">检查失败：${esc(r.message || '网络错误')}</div>`;
    toast(r.message || '检查更新失败', true);
    return;
  }
  const d = r.data || {};
  renderUpdateResult(d);
  if (d.hasUpdate) toast(`发现新版本 v${d.latest}`);
  else if (!d.noRelease) toast('已是最新版本');
  updateRefresh();
}

function openUpdateModal() {
  const m = $('#updateModal');
  if (!m) return;
  m.classList.add('on');
  updatePillText();
  renderUpdateResult(null);
  log('已打开版本更新检查', 'b');
  const btn = $('#btnCheckAgain');
  if (btn) runUpdateCheck(btn);
}
function closeUpdateModal() {
  const m = $('#updateModal');
  if (m) m.classList.remove('on');
}
if ($('#btnUpdate')) $('#btnUpdate').onclick = openUpdateModal;
if ($('#updateModalClose')) $('#updateModalClose').onclick = closeUpdateModal;
if ($('#btnUpdateConfirm')) $('#btnUpdateConfirm').onclick = closeUpdateModal;
if ($('#updateModal')) {
  $('#updateModal').addEventListener('click', (e) => {
    if (e.target === $('#updateModal')) closeUpdateModal();
  });
}
if ($('#btnCheckAgain')) {
  $('#btnCheckAgain').onclick = function () {
    runUpdateCheck(this);
  };
}
if ($('#btnOpenLogs')) {
  $('#btnOpenLogs').onclick = async () => {
    const r = await call(SD.diag.openLogs(), { silent: true });
    if (!r.ok) toast(r.message || '打开日志目录失败', true);
  };
}
if ($('#btnDiagExport')) {
  $('#btnDiagExport').onclick = async () => {
    const btn = $('#btnDiagExport');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '导出中…';
    const uiLogs = (S.logs || []).map(
      (l) => `[${new Date(l.at).toLocaleString('zh-CN')}] ${l.text}`
    );
    const r = await call(SD.diag.exportBundle(uiLogs), { silent: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) {
      toast(r.message || '导出诊断包失败', true);
      return;
    }
    if (r.data && r.data.canceled) return;
    toast('诊断包已导出，可直接发给开发者');
    log('已导出诊断包', 'b');
  };
}

/** 设置里的名单用换行/逗号分隔，存成数组 */
function listToText(v) {
  return (Array.isArray(v) ? v : []).join('\n');
}
function textToList(v) {
  return String(v == null ? '' : v)
    .split(/[\n,，;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function fillSettingsForm() {
  const s = S.settings || {};
  syncThemeSeg(currentTheme);
  $('#setSteamPath').value = s.steamPath || '';
  if ($('#setLoginProxy')) $('#setLoginProxy').value = s.loginProxy || '';
  $('#setQuoteInt').value = s.quoteIntervalMs || 1800;
  $('#setSellInt').value = s.sellIntervalMs || 4000;
  $('#setGuard').value = s.guardMinRatio || 0.7;
  if ($('#setRiskOn')) $('#setRiskOn').checked = s.guardEnabled !== false;
  if ($('#setMaxPrice')) $('#setMaxPrice').value = Number(s.maxPriceYuan) || 0;
  if ($('#setMinCost')) $('#setMinCost').value = Number(s.minCostRatio) || 0.5;
  if ($('#setMaxReprice')) $('#setMaxReprice').value = Number(s.maxDailyReprice) || 0;
  if ($('#setMaxBatch')) $('#setMaxBatch').value = Number(s.maxBatch) || 50;
  if ($('#setRiskBlack')) $('#setRiskBlack').value = listToText(s.riskBlacklist);
  if ($('#setRiskWhite')) $('#setRiskWhite').value = listToText(s.riskWhitelist);
  if ($('#setPaused')) $('#setPaused').checked = s.automationPaused === true;
  if ($('#setWindowOn')) $('#setWindowOn').checked = s.autoWindowEnabled === true;
  if ($('#setWindowStart')) $('#setWindowStart').value = Number(s.autoWindowStart) || 8;
  if ($('#setWindowEnd')) $('#setWindowEnd').value = Number(s.autoWindowEnd) || 23;
  if ($('#setLadderOn')) $('#setLadderOn').checked = s.ladderEnabled === true;
  if ($('#setLadderDays')) $('#setLadderDays').value = Number(s.ladderDays) || 7;
  if ($('#setLadderPct')) $('#setLadderPct').value = Number(s.ladderStepPct) || 5;
  if ($('#setLadderMax')) $('#setLadderMax').value = Number(s.ladderMaxSteps) || 3;
  if ($('#setLadderRun')) $('#setLadderRun').value = Number(s.ladderMaxPerRun) || 5;
  if ($('#setPgOn')) $('#setPgOn').checked = s.priceGuardEnabled === true;
  if ($('#setPgNotifyOnly')) $('#setPgNotifyOnly').checked = s.priceGuardNotifyOnly === true;
  if ($('#setPgGap')) $('#setPgGap').value = Number(s.priceGuardMinGap) || 0.05;
  if ($('#setPgRun')) $('#setPgRun').value = Number(s.priceGuardMaxPerRun) || 5;
  if ($('#setPgDaily')) $('#setPgDaily').value = Number(s.priceGuardDailyCap) || 50;
  if ($('#setPgInterval')) $('#setPgInterval').value = Number(s.priceGuardIntervalMin) || 30;
  if ($('#setAutoCost')) $('#setAutoCost').checked = s.autoCostFromTrades !== false;
  if ($('#setAutoCostOverwrite')) $('#setAutoCostOverwrite').checked = s.autoCostOverwrite === true;
  if ($('#setQuietOn')) $('#setQuietOn').checked = s.quietHoursEnabled === true;
  if ($('#setQuietStart')) $('#setQuietStart').value = Number(s.quietStart) || 23;
  if ($('#setQuietEnd')) $('#setQuietEnd').value = Number(s.quietEnd) || 8;
  if ($('#setDailyGoal')) $('#setDailyGoal').value = Number(s.dailyGoalYuan) || 0;
  $$('#setPriceEnding .seg-btn').forEach((b) => {
    b.classList.toggle('on', (b.dataset.end || 'none') === (s.priceEnding || 'none'));
  });
  if ($('#setSessionWarn')) $('#setSessionWarn').checked = s.sessionWarnEnabled !== false;
  if ($('#setTradeWatch')) $('#setTradeWatch').checked = s.tradeWatchEnabled === true;
  if ($('#setSteamKey')) $('#setSteamKey').value = s.steamApiKey || '';
  if ($('#setTradeInt')) $('#setTradeInt').value = Number(s.tradeWatchIntervalMin) || 10;
  if ($('#setSaleWatch')) $('#setSaleWatch').checked = s.saleWatchEnabled === true;
  if ($('#setSaleInt')) $('#setSaleInt').value = Number(s.saleWatchIntervalMin) || 10;
  $$('#setStoreRegion .seg-btn').forEach((b) =>
    b.classList.toggle('on', (b.dataset.region || 'CN') === (s.storeRegion || 'CN'))
  );
  if ($('#setDropWatch')) $('#setDropWatch').checked = s.dropWatchEnabled === true;
  if ($('#setDropMin')) $('#setDropMin').value = Number(s.dropWatchMinYuan) || 0;
  if ($('#setDropInt')) $('#setDropInt').value = Number(s.dropWatchIntervalMin) || 30;
  if ($('#setDropIgnore')) $('#setDropIgnore').value = s.dropIgnoreKeywords || '';
  if ($('#setAiOn')) $('#setAiOn').checked = s.aiEnabled === true;
  if ($('#setAiBase')) $('#setAiBase').value = s.aiBaseUrl || '';
  if ($('#setAiKey')) $('#setAiKey').value = s.aiApiKey || '';
  if ($('#setAiModel')) $('#setAiModel').value = s.aiModel || 'gpt-4o-mini';
  if ($('#setExtOn')) $('#setExtOn').checked = s.extEnabled === true;
  if ($('#setUpdateUrl')) $('#setUpdateUrl').value = s.updateUrl || '';
  if ($('#setUpdateAuto')) $('#setUpdateAuto').checked = s.updateAutoEnabled !== false;
  sessionStatusRefresh();
  tradeStatusRefresh();
  saleRefresh();
  itadStatusRefresh();
  dropStatusRefresh();
  extStatusRefresh();
  notifyRefresh();
  archiveRefresh();
  updateRefresh();
  pgRefresh();
}

if ($('#setPriceEnding')) {
  $('#setPriceEnding').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    $$('#setPriceEnding .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
  });
}

$('#setChoosePath').onclick = async () => {
  const r = await call(SD.settings.chooseSteamPath());
  if (r.ok && r.data) {
    $('#setSteamPath').value = r.data;
    S.settings.steamPath = r.data;
    renderRailFooter();
    toast('Steam 路径已更新');
    scanAccounts({ quiet: true });
  }
};

/* ===== 界面缩放 =====
   用户反馈"整体太小看不清"。这里做成可调并持久化，重启后恢复。 */
if ($('#setZoom')) {
  const zr = $('#setZoom');
  const zv = $('#setZoomVal');
  const paint = () => { if (zv) zv.textContent = Math.round(Number(zr.value) * 100) + '%'; };

  zr.oninput = () => {
    paint();
    // 实时预览：改根字号，立即可见，不用等保存
    document.documentElement.style.fontSize = (15 * Number(zr.value)).toFixed(2) + 'px';
  };

  zr.onchange = async () => {
    const f = Number(zr.value);
    await call(SD.ui.setZoom(f), { noLog: true });
    toast(`界面缩放已设为 ${Math.round(f * 100)}%`);
  };

  // 打开设置时同步当前已保存的比例
  $('#btnSettings').onclick = async () => {
    try {
      const r = await call(SD.settings.get(), { silent: true, noLog: true });
      const z = (r.ok && Number(r.data && r.data.uiZoom)) || 1.08;
      zr.value = String(z);
      paint();
    } catch { /* ignore */ }
    openDrawer();
  };
}

/* ------------------------------ 通知外发设置 ------------------------------ */

let notifyState = null;
let qqPicked = null;
let qqTargets = [];

function renderQqPicks(list) {
  const box = $('#qqChannelPick');
  if (!box) return;
  const items = Array.isArray(list) ? list : [];
  const cur = $('#setQqChannelId') ? $('#setQqChannelId').value.trim() : '';
  box.innerHTML = '';
  box.style.display = items.length ? '' : 'none';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (it.id === cur ? ' on' : '');
    b.textContent = `${it.guildName ? `${it.guildName} / ` : ''}${it.name}`;
    b.onclick = () => {
      qqPicked = { guildId: it.guildId, channelId: it.id, name: it.name };
      if ($('#setQqChannelId')) $('#setQqChannelId').value = it.id;
      renderQqPicks(qqTargets);
    };
    box.appendChild(b);
  }
}

function notifyChannelFields(ch) {
  const map = {
    telegram: ['nfTgToken', 'nfTgChat'],
    wecom: ['nfWebhook'],
    dingtalk: ['nfWebhook'],
    serverchan: ['nfScKey'],
    webhook: ['nfWebhook'],
    qqbot: ['nfQqAppId', 'nfQqSecret', 'nfQqDirect', 'nfQqChannel'],
  };
  const show = new Set(map[ch] || []);
  for (const id of ['nfTgToken', 'nfTgChat', 'nfWebhook', 'nfScKey', 'nfQqAppId', 'nfQqSecret', 'nfQqDirect', 'nfQqChannel']) {
    const el = $('#' + id);
    if (el) el.style.display = show.has(id) ? '' : 'none';
  }
}

async function notifyRefresh() {
  const r = await call(SD.notify.state(), { silent: true, noLog: true });
  if (!r.ok) return;
  const d = (notifyState = r.data || {});
  $$('#setNotifyChannel .seg-btn').forEach((b) =>
    b.classList.toggle('on', b.dataset.ch === (d.channel || 'none'))
  );
  notifyChannelFields(d.channel || 'none');
  if ($('#setTgChat')) $('#setTgChat').value = d.tgChat || '';
  if ($('#setTgToken')) {
    $('#setTgToken').value = '';
    $('#setTgToken').placeholder = d.tgToken ? '已保存（留空不修改）' : '123456:ABC...';
  }
  if ($('#setWebhook')) {
    $('#setWebhook').value = '';
    $('#setWebhook').placeholder = d.webhook ? '已保存（留空不修改）' : 'https://qyapi.weixin.qq.com/...';
  }
  if ($('#setScKey')) {
    $('#setScKey').value = '';
    $('#setScKey').placeholder = d.scKey ? '已保存（留空不修改）' : 'SCT...';
  }
  if ($('#clrTgToken')) $('#clrTgToken').style.display = d.tgToken ? '' : 'none';
  if ($('#clrWebhook')) $('#clrWebhook').style.display = d.webhook ? '' : 'none';
  if ($('#clrScKey')) $('#clrScKey').style.display = d.scKey ? '' : 'none';
  if ($('#setQqAppId')) $('#setQqAppId').value = d.qqAppId || '';
  if ($('#setQqSecret')) {
    $('#setQqSecret').value = '';
    $('#setQqSecret').placeholder = d.qqSecret ? '已保存（留空不修改）' : '在 q.qq.com 机器人设置里查看';
  }
  if ($('#clrQqSecret')) $('#clrQqSecret').style.display = d.qqSecret ? '' : 'none';
  /* 私聊/群聊绑定状态 */
  const binds = d.qqBinds || {};
  const c2c = binds.c2c;
  const gw = d.qqGateway || {};
  const bindEl = $('#qqBindStatus');
  if (bindEl) {
    if (c2c) {
      const alive = c2c.alive ? '额度正常' : '额度可能已过期，给机器人发条消息刷新';
      const gwOk = gw.connected ? ' · 已连接腾讯服务器' : gw.running ? ' · 连接中…' : '';
      bindEl.innerHTML =
        `✅ 已绑定私聊推送（openid 尾号 ${esc(c2c.openidTail)} · ${new Date(c2c.lastMsgAt).toLocaleString(
          'zh-CN'
        )}${gwOk}）<br><span class="dim2">${alive}</span>`;
    } else if (gw.running) {
      bindEl.textContent = '已连上腾讯服务器，正在等你在 QQ 里给机器人发消息…（打开 QQ，搜到你的机器人，随便发一条消息即可完成绑定）';
    } else {
      bindEl.textContent = '填好上面两项后点「连接机器人」，然后打开 QQ，在消息列表搜到你的机器人，随便给它发一条消息（比如「绑定」），这里会自动显示绑定成功。';
    }
  }
  if ($('#qqUnbindC2c')) $('#qqUnbindC2c').style.display = c2c ? '' : 'none';
  if ($('#setQqChannelId')) $('#setQqChannelId').value = d.qqChannelId || '';
  if (d.qqChannelId) qqPicked = { guildId: d.qqGuildId || '', channelId: d.qqChannelId, name: d.qqChannelName || '' };
  renderQqPicks(qqTargets);
  const st = $('#notifyStatus');
  if (st) {
    const names = {
      none: '未开启',
      telegram: 'Telegram',
      wecom: '企业微信',
      dingtalk: '钉钉',
      serverchan: 'Server酱',
      webhook: 'Webhook',
      qqbot: 'QQ 机器人',
    };
    if (!d.enabled) {
      st.textContent = '未开启：只弹桌面通知';
    } else {
      const last = d.lastAt ? ` · 最近发送 ${new Date(d.lastAt).toLocaleString('zh-CN')}` : '';
      st.textContent =
        `${names[d.channel] || d.channel} 已开启${last}` + (d.lastError ? ` · 上次失败：${d.lastError}` : '');
    }
  }
}

async function notifySave(extra) {
  const p = { ...(extra || {}) };
  if ($('#setTgChat')) p.tgChat = $('#setTgChat').value.trim();
  const tg = $('#setTgToken') ? $('#setTgToken').value.trim() : '';
  const wh = $('#setWebhook') ? $('#setWebhook').value.trim() : '';
  const sc = $('#setScKey') ? $('#setScKey').value.trim() : '';
  if (tg) p.tgToken = tg;
  if (wh) p.webhook = wh;
  if (sc) p.scKey = sc;
  if ($('#setQqAppId')) p.qqAppId = $('#setQqAppId').value.trim();
  const qs = $('#setQqSecret') ? $('#setQqSecret').value.trim() : '';
  if (qs) p.qqSecret = qs;
  if ($('#setQqChannelId')) {
    const cid = $('#setQqChannelId').value.trim();
    p.qqChannelId = cid;
    if (qqPicked && qqPicked.channelId === cid) {
      p.qqGuildId = qqPicked.guildId || '';
      p.qqChannelName = qqPicked.name || '';
    } else {
      p.qqGuildId = '';
      p.qqChannelName = '';
    }
  }
  const r = await call(SD.notify.set(p), { silent: true });
  if (!r.ok) {
    toast(r.message || '保存通知设置失败', true);
    return false;
  }
  await notifyRefresh();
  return true;
}

$$('#setNotifyChannel .seg-btn').forEach((b) => {
  b.onclick = async () => {
    const ch = b.dataset.ch;
    if (await notifySave({ channel: ch })) {
      toast(ch === 'none' ? '已关闭通知外发' : '通知渠道已切换');
    }
  };
});

function bindNotifyClear(id, field, label) {
  const b = $('#' + id);
  if (!b) return;
  b.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = await call(SD.notify.set({ [field]: '' }), { silent: true });
    if (r.ok) {
      toast(`${label} 已清除`);
      notifyRefresh();
    }
  };
}
bindNotifyClear('clrTgToken', 'tgToken', 'Telegram Token');
bindNotifyClear('clrWebhook', 'webhook', 'Webhook 地址');
bindNotifyClear('clrScKey', 'scKey', 'Server酱 SendKey');
bindNotifyClear('clrQqSecret', 'qqSecret', 'QQ AppSecret');

/* 私聊绑定：连接机器人（保存凭据 + 重启实时网关）与解绑 */
if ($('#qqConnect')) {
  $('#qqConnect').onclick = async () => {
    const btn = $('#qqConnect');
    const old = btn.textContent;
    await notifySave();
    btn.disabled = true;
    btn.textContent = '连接中…';
    const r = await call(SD.notify.qqRestart(), { silent: true });
    btn.disabled = false;
    btn.textContent = old;
    const d = r.data || {};
    if (!r.ok || d.ok === false) {
      const msg = d.message || r.message || '连接失败，请检查 AppID / AppSecret 和网络';
      toast(msg, true);
      const st = $('#qqBindStatus');
      if (st) st.textContent = msg;
      notifyRefresh();
      return;
    }
    toast('已连上腾讯服务器。现在打开 QQ，给机器人发一条消息完成绑定');
    notifyRefresh();
  };
}
if ($('#qqUnbindC2c')) {
  $('#qqUnbindC2c').onclick = async () => {
    const r = await call(SD.notify.qqUnbind('c2c'), { silent: true });
    if (r.ok) toast('已解除私聊绑定');
    notifyRefresh();
  };
}

if ($('#qqFetchChannels')) {
  $('#qqFetchChannels').onclick = async () => {
    // 先把 AppID / AppSecret 存进主进程，否则拉取时还没有凭据
    await notifySave();
    const btn = $('#qqFetchChannels');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '读取中…';
    const r = await call(SD.notify.qqTargets(), { silent: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) {
      toast(r.message || '拉取频道失败', true);
      return;
    }
    qqTargets = Array.isArray(r.data) ? r.data : [];
    renderQqPicks(qqTargets);
    if (!qqTargets.length) toast('机器人还没加入任何 QQ 频道，先把机器人加到频道里', true);
    else toast(`找到 ${qqTargets.length} 个可推送的文字子频道，点一个选中`);
  };
}

/* --------------------------- 查价与挂机设置 --------------------------- */

async function itadStatusRefresh() {
  if (!SD.store.itadStatus || !$('#setItadKey')) return;
  const r = await call(SD.store.itadStatus(), { silent: true, noLog: true });
  const on = !!(r.ok && r.data && r.data.configured);
  $('#setItadKey').value = '';
  $('#setItadKey').placeholder = on ? '已保存（留空不修改）' : '没填就不显示史低';
  if ($('#clrItadKey')) $('#clrItadKey').style.display = on ? '' : 'none';
}

if ($('#clrItadKey')) {
  $('#clrItadKey').onclick = async (e) => {
    e.preventDefault();
    const r = await call(SD.store.setItadKey(''), { silent: true });
    if (r.ok) {
      toast('ITAD Key 已清除');
      itadStatusRefresh();
    }
  };
}

async function dropStatusRefresh() {
  if (!SD.dropWatch) return;
  const r = await call(SD.dropWatch.state(), { silent: true, noLog: true });
  if (!r.ok) return;
  const d = r.data || {};
  if ($('#setDropWatch')) $('#setDropWatch').checked = d.enabled === true;
  if ($('#setDropMin')) $('#setDropMin').value = Number(d.minYuan) || 0;
  if ($('#setDropInt')) $('#setDropInt').value = Number(d.intervalMin) || 30;
  const st = $('#dropStatus');
  if (!st) return;
  if (d.lastError) st.textContent = `上次失败：${d.lastError}`;
  else if (d.lastAt) st.textContent = `${d.lastResult || '已检查'} · ${new Date(d.lastAt).toLocaleString('zh-CN')}`;
  else st.textContent = d.enabled ? '已开启，等待第一次检查（约 2 分钟后）' : '尚未检查';
}

if ($('#dropCheck')) {
  $('#dropCheck').onclick = async () => {
    if (!SD.dropWatch) return;
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#dropCheck');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    const r = await call(SD.dropWatch.run(true), { silent: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) toast(r.message || '检查失败', true);
    else if (r.data && r.data.error) toast(r.data.error, true);
    else if (r.data && r.data.baseline) toast(`已建立基线（${r.data.scanned} 个游戏），之后的新掉落会提醒`);
    else toast(`检查完成${r.data && r.data.drops ? `，新掉落 ${r.data.drops} 件` : '，没有新的掉落'}`);
    dropStatusRefresh();
  };
}

/* ------------------------------ 卖出通知 ------------------------------ */

async function saleRefresh() {
  if (!SD.saleWatch) return;
  const r = await call(SD.saleWatch.state(), { silent: true, noLog: true });
  if (!r.ok) return;
  const d = r.data || {};
  if ($('#setSaleWatch')) $('#setSaleWatch').checked = d.enabled === true;
  if ($('#setSaleInt')) $('#setSaleInt').value = d.intervalMin || 10;
  const st = $('#saleStatus');
  if (!st) return;
  if (d.lastError) st.textContent = `上次失败：${d.lastError}`;
  else if (d.lastAt) {
    st.textContent = `${d.lastResult || '已检查'} · ${new Date(d.lastAt).toLocaleString('zh-CN')}`;
  } else {
    st.textContent = d.enabled ? '已开启，等待第一次检查（约 90 秒后、每轮读一次成交历史）' : '尚未检查';
  }
}

if ($('#saleCheck')) {
  $('#saleCheck').onclick = async () => {
    if (!SD.saleWatch) return;
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#saleCheck');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    const r = await call(SD.saleWatch.run(true), { silent: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) toast(r.message || '检查失败', true);
    else if (r.data && r.data.error) toast(r.data.error, true);
    else if (r.data && r.data.initialized) toast(`已记录 ${r.data.count} 条历史卖出，之后的新成交会通知`);
    else toast(`检查完成${r.data && r.data.newCount ? `，新卖出 ${r.data.newCount} 件` : '，没有新的卖出'}`);
    saleRefresh();
  };
}

if ($('#notifyTest')) {
  $('#notifyTest').onclick = async () => {
    await notifySave();
    const r = await call(SD.notify.test(), { silent: true });
    if (r.ok) toast('测试消息已发送，请检查手机或群');
    else toast(r.message || '发送失败', true);
    notifyRefresh();
  };
}

if (SD.automation && SD.automation.onChanged) {
  SD.automation.onChanged((on) => {
    if ($('#setPaused')) $('#setPaused').checked = !!on;
    if (S.settings) S.settings.automationPaused = !!on;
    toast(on ? '已暂停所有自动任务' : '自动任务已恢复');
  });
}

/* -------------------------------- 数据归档 -------------------------------- */

async function archiveRefresh() {
  const st = $('#archiveStat');
  if (!st) return;
  const r = await call(SD.archive.state(), { silent: true, noLog: true });
  if (!r.ok) {
    st.textContent = r.message || '读取归档状态失败';
    return;
  }
  const d = r.data || {};
  const mb = ((Number(d.bytes) || 0) / 1048576).toFixed(1);
  const range = d.earliest
    ? `${new Date(d.earliest).toLocaleDateString('zh-CN')} 至 ${new Date(d.latest || d.earliest).toLocaleDateString('zh-CN')}`
    : '还没有归档数据，读一次成交历史后开始记录';
  st.textContent = `成交 ${d.trades || 0} 条 · 行情 ${d.quotes || 0} 条（${d.quoteItems || 0} 种物品）· ${d.accounts || 0} 个账号 · ${mb} MB · ${range}`;
}

function archiveSid() {
  return String(S.currentSteamId || costSid() || '');
}

if ($('#archiveRefresh')) $('#archiveRefresh').onclick = () => archiveRefresh();
if ($('#archiveExport')) {
  $('#archiveExport').onclick = async () => {
    const sid = archiveSid();
    if (!sid) {
      toast('还没有可导出的账号，先登录一个账号', true);
      return;
    }
    const r = await call(SD.archive.exportCsv(sid), { silent: true });
    if (!r.ok) {
      toast(r.message || '导出失败', true);
      return;
    }
    if (r.data && r.data.empty) {
      toast('这个账号还没有归档的成交记录', true);
      return;
    }
    if (r.data && r.data.canceled) return;
    toast(`已导出 ${r.data.rows || 0} 条成交记录`);
  };
}

/* -------------------------------- 版本更新 -------------------------------- */

async function updateRefresh() {
  const st = $('#updateStatus');
  if (!st) return;
  const r = await call(SD.update.state(), { silent: true, noLog: true });
  if (!r.ok) return;
  const d = r.data || {};
  const cur = d.current || '';
  if (!d.url) {
    st.textContent = `当前 ${cur} · 默认从 GitHub Releases 检查（也可在下方填自定义更新源）`;
    return;
  }
  const last = d.last;
  if (last && last.hasUpdate) {
    st.innerHTML =
      `发现新版本 <b>${esc(last.latest)}</b>（当前 ${esc(cur)}）· ` +
      `<a href="#" id="updateOpenLink" style="color:var(--blue)">打开下载页</a>` +
      (last.notes ? `<div style="margin-top:4px">${esc(last.notes)}</div>` : '');
    return;
  }
  if (last) {
    st.textContent = `已是最新（当前 ${cur}）· 检查于 ${new Date(last.at).toLocaleString('zh-CN')}`;
    return;
  }
  st.textContent = `当前 ${cur} · 还没检查过`;
}

if ($('#updateStatus')) {
  $('#updateStatus').addEventListener('click', async (e) => {
    const a = e.target.closest('#updateOpenLink');
    if (!a) return;
    e.preventDefault();
    const r = await call(SD.update.open(), { silent: true });
    if (!r.ok) toast(r.message || '打开下载页失败', true);
  });
}

if ($('#updateCheckBtn')) {
  $('#updateCheckBtn').onclick = async () => {
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#updateCheckBtn');
    btn.disabled = true;
    btn.textContent = '检查中…';
    const r = await call(SD.update.check(), { silent: true });
    btn.disabled = false;
    btn.textContent = '立即检查更新';
    if (!r.ok) {
      toast(netText(r.message) || '检查失败', true);
    } else if (r.data && r.data.hasUpdate) {
      toast(`发现新版本 ${r.data.latest}`);
    } else if (r.data && r.data.noRelease) {
      toast('发布仓库还没有 Release，暂时无法联网检查');
    } else {
      toast('已是最新版本');
    }
    updateRefresh();
  };
}

/* ------------------------------ 自动守价设置 ------------------------------ */

async function pgRefresh() {
  const st = $('#pgStatus');
  if (!st) return;
  const r = await call(SD.priceGuard.state(), { silent: true, noLog: true });
  if (!r.ok) {
    st.textContent = '读取守价状态失败';
    return;
  }
  const d = r.data || {};
  if ($('#setPgOn')) $('#setPgOn').checked = d.enabled === true;
  if ($('#setPgNotifyOnly')) $('#setPgNotifyOnly').checked = d.notifyOnly === true;
  if ($('#setPgGap')) $('#setPgGap').value = Number(d.minGap) || 0.05;
  if ($('#setPgRun')) $('#setPgRun').value = Number(d.maxPerRun) || 5;
  if ($('#setPgDaily')) $('#setPgDaily').value = Number(d.dailyCap) || 50;
  if ($('#setPgInterval')) $('#setPgInterval').value = Number(d.intervalMin) || 30;

  if (!d.enabled) {
    st.textContent = '未开启：不会检查挂单，也不会提醒';
    return;
  }
  const last = d.lastResult || {};
  const parts = [];
  if (last.at) {
    parts.push(`上次检查 ${new Date(last.at).toLocaleString('zh-CN')}`);
    if (last.checked !== undefined) parts.push(`查了 ${last.checked} 件`);
    if (last.underpriced) parts.push(`被压价 ${last.underpriced} 件`);
    if (last.listed) parts.push(`已跟价 ${last.listed} 件`);
    if (last.reason) parts.push(last.reason);
  } else parts.push('还没检查过');
  parts.push(`今日 ${d.count || 0}/${d.dailyCap || 0} 件`);
  if (d.error) parts.push(`错误：${d.error}`);
  st.textContent = parts.join(' · ');
}

if ($('#pgRun')) {
  $('#pgRun').onclick = async () => {
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#pgRun');
    btn.disabled = true;
    btn.textContent = '检查中…';
    const r = await call(SD.priceGuard.run(true), { silent: true });
    btn.disabled = false;
    btn.textContent = '立即检查一轮';
    if (!r.ok) {
      toast(netText(r.message) || '检查失败', true);
    } else {
      const d = r.data || {};
      if (d.skipped) toast(d.reason || '本次跳过');
      else if (d.error) toast(d.error, true);
      else toast(`检查 ${d.checked || 0} 件，被压价 ${d.underpriced || 0} 件，已跟价 ${d.listed || 0} 件`);
    }
    pgRefresh();
  };
}

/* ------------------------------ 备份与恢复 ------------------------------ */

if ($('#backupExport')) {
  $('#backupExport').onclick = async () => {
    const btn = $('#backupExport');
    btn.disabled = true;
    const r = await call(SD.backup.export(), { silent: true });
    btn.disabled = false;
    const st = $('#backupStatus');
    if (!r.ok) {
      toast(r.message || '导出失败', true);
      return;
    }
    if (r.data && r.data.canceled) return;
    const d = r.data || {};
    if (st) {
      st.textContent = `已导出：成本 ${d.costRows || 0} 条 · 提醒 ${d.alerts || 0} 条 · ${Math.round((d.bytes || 0) / 1024)} KB`;
    }
    toast('备份已导出');
  };
}

if ($('#backupImport')) {
  $('#backupImport').onclick = async () => {
    const btn = $('#backupImport');
    btn.disabled = true;
    const r = await call(SD.backup.import(), { silent: true });
    btn.disabled = false;
    if (!r.ok) {
      toast(r.message || '恢复失败', true);
      return;
    }
    if (r.data && r.data.canceled) return;
    const st = $('#backupStatus');
    if (st) st.textContent = '恢复完成，软件正在重启…';
    toast('恢复完成，即将自动重启');
  };
}

/* ------------------------------ 通知中心 ------------------------------ */

let noticeCache = [];

function noticeTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderNoticeList() {
  const box = $('#noticeList');
  if (!box) return;
  if (!noticeCache.length) {
    box.innerHTML = '<div class="watch-empty">还没有消息</div>';
    return;
  }
  box.innerHTML = noticeCache
    .map(
      (n) =>
        `<div class="notice-item${n.read ? '' : ' unread'}" data-nid="${esc(n.id)}">` +
        `<div class="nt"><b>${esc(n.title)}</b><span>${esc(noticeTime(n.at))}</span></div>` +
        `<div class="nb clamp">${esc(n.body)}</div></div>`
    )
    .join('');
}

async function noticesRefresh(render) {
  const r = await call(SD.notices.list(100), { silent: true, noLog: true });
  if (!r.ok) return;
  const d = r.data || { items: [], unread: 0 };
  noticeCache = d.items || [];
  const badge = $('#ovNoticeBadge');
  if (badge) {
    badge.textContent = String(d.unread || 0);
    badge.style.display = d.unread ? '' : 'none';
  }
  const un = $('#noticeUnread');
  if (un) un.textContent = `${d.unread || 0} 条未读`;
  if (render) renderNoticeList();
}

function noticeOpen() {
  const m = $('#noticeModal');
  if (!m) return;
  m.classList.add('on');
  noticesRefresh(true);
}

function noticeClose() {
  const m = $('#noticeModal');
  if (m) m.classList.remove('on');
}

if ($('#ovNotices')) $('#ovNotices').onclick = () => noticeOpen();
if ($('#noticeClose')) $('#noticeClose').onclick = () => noticeClose();
if ($('#noticeModal')) {
  $('#noticeModal').addEventListener('click', (e) => {
    if (e.target === $('#noticeModal')) noticeClose();
  });
  $('#noticeList').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-nid]');
    if (!item) return;
    item.classList.remove('unread');
    item.querySelectorAll('.nb').forEach((n) => n.classList.remove('clamp'));
    await call(SD.notices.read(item.dataset.nid), { silent: true, noLog: true });
    noticesRefresh(false);
  });
}
if ($('#noticeReadAll')) {
  $('#noticeReadAll').onclick = async () => {
    await call(SD.notices.readAll(), { silent: true, noLog: true });
    await noticesRefresh(true);
  };
}
if ($('#noticeClear')) {
  $('#noticeClear').onclick = async () => {
    await call(SD.notices.clear(), { silent: true, noLog: true });
    await noticesRefresh(true);
  };
}

async function saveSettings(opts = {}) {
  const keepOpen = opts.keepOpen === true;
  const silent = opts.silent === true;
  const patch = {
    steamPath: $('#setSteamPath').value.trim() || null,
    loginProxy: $('#setLoginProxy') ? $('#setLoginProxy').value.trim() : '',
    quoteIntervalMs: Math.max(1200, Number($('#setQuoteInt').value) || 1800),
    sellIntervalMs: Math.max(2000, Number($('#setSellInt').value) || 4000),
    guardMinRatio: Math.min(0.95, Math.max(0.1, Number($('#setGuard').value) || 0.7)),
    guardEnabled: $('#setRiskOn') ? $('#setRiskOn').checked : true,
    maxPriceYuan: Math.max(0, Number($('#setMaxPrice') && $('#setMaxPrice').value) || 0),
    minCostRatio: Math.min(1, Math.max(0, Number($('#setMinCost') && $('#setMinCost').value) || 0)),
    maxDailyReprice: Math.max(0, Number($('#setMaxReprice') && $('#setMaxReprice').value) || 0),
    maxBatch: Math.max(1, Number($('#setMaxBatch') && $('#setMaxBatch').value) || 50),
    automationPaused: $('#setPaused') ? $('#setPaused').checked : false,
    autoWindowEnabled: $('#setWindowOn') ? $('#setWindowOn').checked : false,
    autoWindowStart: Math.min(23, Math.max(0, Number($('#setWindowStart') && $('#setWindowStart').value) || 8)),
    autoWindowEnd: Math.min(23, Math.max(0, Number($('#setWindowEnd') && $('#setWindowEnd').value) || 23)),
    riskBlacklist: textToList($('#setRiskBlack') && $('#setRiskBlack').value),
    riskWhitelist: textToList($('#setRiskWhite') && $('#setRiskWhite').value),
    ladderEnabled: $('#setLadderOn') ? $('#setLadderOn').checked : false,
    ladderDays: Math.min(90, Math.max(1, Number($('#setLadderDays') && $('#setLadderDays').value) || 7)),
    ladderStepPct: Math.min(50, Math.max(1, Number($('#setLadderPct') && $('#setLadderPct').value) || 5)),
    ladderMaxSteps: Math.min(20, Math.max(1, Number($('#setLadderMax') && $('#setLadderMax').value) || 3)),
    ladderMaxPerRun: Math.min(20, Math.max(1, Number($('#setLadderRun') && $('#setLadderRun').value) || 5)),
    priceGuardEnabled: $('#setPgOn') ? $('#setPgOn').checked : false,
    priceGuardNotifyOnly: $('#setPgNotifyOnly') ? $('#setPgNotifyOnly').checked : false,
    priceGuardMinGap: Math.min(10, Math.max(0.01, Number($('#setPgGap') && $('#setPgGap').value) || 0.05)),
    priceGuardMaxPerRun: Math.min(20, Math.max(1, Number($('#setPgRun') && $('#setPgRun').value) || 5)),
    priceGuardDailyCap: Math.max(0, Number($('#setPgDaily') && $('#setPgDaily').value) || 50),
    priceGuardIntervalMin: Math.max(5, Number($('#setPgInterval') && $('#setPgInterval').value) || 30),
    autoCostFromTrades: $('#setAutoCost') ? $('#setAutoCost').checked : true,
    autoCostOverwrite: $('#setAutoCostOverwrite') ? $('#setAutoCostOverwrite').checked : false,
    quietHoursEnabled: $('#setQuietOn') ? $('#setQuietOn').checked : false,
    quietStart: Math.min(23, Math.max(0, Number($('#setQuietStart') && $('#setQuietStart').value) || 23)),
    quietEnd: Math.min(23, Math.max(0, Number($('#setQuietEnd') && $('#setQuietEnd').value) || 8)),
    dailyGoalYuan: Math.max(0, Number($('#setDailyGoal') && $('#setDailyGoal').value) || 0),
    priceEnding: (($('#setPriceEnding .seg-btn.on') || {}).dataset || {}).end || 'none',
    updateUrl: $('#setUpdateUrl') ? $('#setUpdateUrl').value.trim() : '',
    sessionWarnEnabled: $('#setSessionWarn') ? $('#setSessionWarn').checked : true,
    tradeWatchEnabled: $('#setTradeWatch') ? $('#setTradeWatch').checked : false,
    steamApiKey: $('#setSteamKey') ? $('#setSteamKey').value.trim() : '',
    tradeWatchIntervalMin: Math.max(3, Number($('#setTradeInt') && $('#setTradeInt').value) || 10),
    saleWatchEnabled: $('#setSaleWatch') ? $('#setSaleWatch').checked : false,
    saleWatchIntervalMin: Math.max(5, Number($('#setSaleInt') && $('#setSaleInt').value) || 10),
    storeRegion: ((($('#setStoreRegion .seg-btn.on') || {}).dataset || {}).region) || 'CN',
    dropWatchEnabled: $('#setDropWatch') ? $('#setDropWatch').checked : false,
    dropWatchMinYuan: Math.max(0, Number($('#setDropMin') && $('#setDropMin').value) || 0),
    dropWatchIntervalMin: Math.max(10, Number($('#setDropInt') && $('#setDropInt').value) || 30),
    dropIgnoreKeywords: String(($('#setDropIgnore') && $('#setDropIgnore').value) || '').trim().slice(0, 200),
    aiEnabled: $('#setAiOn') ? $('#setAiOn').checked : false,
    aiBaseUrl: $('#setAiBase') ? $('#setAiBase').value.trim() || 'https://api.openai.com/v1' : 'https://api.openai.com/v1',
    aiApiKey: $('#setAiKey') ? $('#setAiKey').value.trim() : '',
    aiModel: $('#setAiModel') ? $('#setAiModel').value.trim() || 'gpt-4o-mini' : 'gpt-4o-mini',
    extEnabled: $('#setExtOn') ? $('#setExtOn').checked : false,
    updateAutoEnabled: $('#setUpdateAuto') ? $('#setUpdateAuto').checked : true,
  };
  const r = await call(SD.settings.set(patch));
  if (r.ok) {
    S.settings = r.data;
    if (!silent) {
      toast('设置已保存');
      log('已更新设置', 'b');
    }
    if (!keepOpen) closeDrawer();
    pgRefresh();
    call(SD.tradeWatch.refresh(), { silent: true, noLog: true }).catch(() => {});
    if (SD.saleWatch) call(SD.saleWatch.refresh(), { silent: true, noLog: true }).catch(() => {});
    if (SD.dropWatch) call(SD.dropWatch.refresh(), { silent: true, noLog: true }).catch(() => {});
    const itadKey = $('#setItadKey') ? $('#setItadKey').value.trim() : '';
    if (itadKey && SD.store.setItadKey) call(SD.store.setItadKey(itadKey), { silent: true }).catch(() => {});
    tradeStatusRefresh();
    saleRefresh();
    dropStatusRefresh();
    extStatusRefresh();
    loadWebPrices();
  }
  return !!(r && r.ok);
}

$('#setSave').onclick = () => saveSettings();

/* --------------------------- 登录态 / 报价 / AI --------------------------- */

async function sessionStatusRefresh() {
  const el = $('#sessionStatus');
  if (!el) return;
  const r = await call(SD.sessionWatch.state(), { silent: true, noLog: true });
  if (!r.ok || !r.data) {
    el.textContent = '登录态状态读取失败';
    return;
  }
  const d = r.data;
  const res = d.lastResult || {};
  el.textContent = res.at
    ? `${new Date(res.at).toLocaleString('zh-CN')} · ${res.message || res.state || ''}`
    : '尚未检查';
}

if ($('#sessionCheck')) {
  $('#sessionCheck').onclick = async () => {
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#sessionCheck');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    const r = await call(SD.sessionWatch.run(true), { silent: true, noLog: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) {
      toast(r.message || '检查失败', true);
      return;
    }
    const d = r.data || {};
    if (d.skipped) toast(d.reason || '没有可检查的登录态', true);
    else toast(d.message || '检查完成', d.state === 'bad');
    await sessionStatusRefresh();
  };
}

async function tradeStatusRefresh() {
  const el = $('#tradeStatus');
  if (!el) return;
  const r = await call(SD.tradeWatch.state(), { silent: true, noLog: true });
  if (!r.ok || !r.data) {
    el.textContent = '交易报价状态读取失败';
    return;
  }
  const d = r.data;
  if (!d.hasKey) {
    el.textContent = '尚未填写 Steam Web API Key';
    return;
  }
  const at = Number(d.lastAt) || 0;
  el.textContent = at
    ? `${new Date(at).toLocaleString('zh-CN')} · 待处理 ${Number(d.lastCount) || 0} 个${
        d.lastError ? ' · ' + d.lastError : ''
      }`
    : '尚未检查';
}

if ($('#tradeCheck')) {
  $('#tradeCheck').onclick = async () => {
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#tradeCheck');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    const r = await call(SD.tradeWatch.run(true), { silent: true, noLog: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) toast(r.message || '检查失败', true);
    else if (r.data && r.data.skipped) toast(r.data.reason || '未检查（记得填写 Key 并保存）', true);
    else if (r.data && r.data.error) toast(r.data.error, true);
    else toast(`当前有 ${Number((r.data || {}).count) || 0} 个待处理交易报价`);
    await tradeStatusRefresh();
  };
}

/* AI 助手（可选）：所有请求都由主进程发出，Key 不进渲染层日志 */
function aiOpenModal() {
  const m = $('#aiModal');
  if (m) m.classList.add('on');
}
function aiCloseModal() {
  const m = $('#aiModal');
  if (m) m.classList.remove('on');
}
function aiShow(text, isError) {
  const out = $('#aiOut');
  if (!out) return;
  out.textContent = text;
  out.style.color = isError ? 'var(--red)' : '';
}

async function aiDoReport() {
  aiOpenModal();
  aiShow('正在生成周报，可能需要十几秒…');
  const r = await call(SD.ai.report(14), { silent: true, noLog: true });
  if (!r.ok) {
    aiShow(r.message || '生成失败', true);
    return;
  }
  aiShow((r.data && r.data.text) || 'AI 没有返回内容', !(r.data && r.data.text));
}

async function aiDoAsk() {
  const inp = $('#aiQuestion');
  const q = inp ? inp.value.trim() : '';
  if (!q) {
    toast('先输入要问的问题', true);
    return;
  }
  aiOpenModal();
  aiShow('正在思考…');
  const r = await call(SD.ai.ask(q), { silent: true, noLog: true });
  if (!r.ok) {
    aiShow(r.message || '提问失败', true);
    return;
  }
  aiShow((r.data && r.data.text) || 'AI 没有返回内容', !(r.data && r.data.text));
}

if ($('#reportAiWeekly')) $('#reportAiWeekly').onclick = () => aiDoReport();
if ($('#reportAiAsk')) $('#reportAiAsk').onclick = () => { aiOpenModal(); const i = $('#aiQuestion'); if (i) setTimeout(() => i.focus(), 60); };
if ($('#aiWeekly')) $('#aiWeekly').onclick = () => aiDoReport();
if ($('#aiAsk')) $('#aiAsk').onclick = () => aiDoAsk();
if ($('#aiClose')) $('#aiClose').onclick = aiCloseModal;
if ($('#aiDone')) $('#aiDone').onclick = aiCloseModal;
if ($('#aiModal')) {
  $('#aiModal').addEventListener('click', (e) => {
    if (e.target === $('#aiModal')) aiCloseModal();
  });
}
if ($('#aiQuestion')) {
  $('#aiQuestion').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      aiDoAsk().catch(() => {});
    }
  });
}
if ($('#aiReportBtn')) $('#aiReportBtn').onclick = async () => {
  await saveSettings({ keepOpen: true, silent: true });
  aiDoReport();
};
if ($('#aiTest')) {
  $('#aiTest').onclick = async () => {
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#aiTest');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    const r = await call(SD.ai.test(), { silent: true, noLog: true });
    btn.disabled = false;
    btn.textContent = old;
    const el = $('#aiStatus');
    if (!r.ok) {
      if (el) el.textContent = r.message || '接口测试失败';
      toast(r.message || '接口测试失败', true);
      return;
    }
    if (el) el.textContent = `接口可用：${(r.data && r.data.model) || ''} 回复「${(r.data && r.data.text) || ''}」`;
    toast('AI 接口可用');
  };
}

/* 「获取模型」：先保存当前填的接口地址和 Key，再拉取 /models 让用户点选 */
if ($('#aiFetchModels')) {
  $('#aiFetchModels').onclick = async () => {
    await saveSettings({ keepOpen: true, silent: true });
    const btn = $('#aiFetchModels');
    const sel = $('#aiModelPick');
    const inp = $('#setAiModel');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '拉取中…';
    const r = await call(SD.ai.models(), { silent: true, noLog: true });
    btn.disabled = false;
    btn.textContent = old;
    if (!r.ok) {
      toast(r.message || '拉取模型列表失败', true);
      return;
    }
    const models = (r.data && r.data.models) || [];
    if (sel) {
      const cur = inp ? inp.value.trim() : '';
      sel.innerHTML =
        `<option value="">共 ${models.length} 个模型，点选一个填入</option>` +
        models
          .map(
            (m) =>
              `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}${
                m === cur ? '（当前）' : ''
              }</option>`
          )
          .join('');
      sel.style.display = '';
      sel.onchange = () => {
        const v = sel.value;
        if (v && inp) {
          inp.value = v;
          saveSettings({ keepOpen: true, silent: true });
          toast(`已选用模型 ${v}`);
        }
      };
    }
    toast(`拉取到 ${models.length} 个模型，在下拉框里选一个`);
  };
}

/* ------------------------------- 浏览器扩展采集 ------------------------------ */

async function loadWebPrices() {
  const r = await call(SD.ext.prices(), { silent: true, noLog: true });
  if (r.ok && r.data) S.webPrices = r.data.items || {};
}

async function extStatusRefresh() {
  const el = $('#extStatus');
  const tk = $('#extToken');
  const r = await call(SD.ext.state(), { silent: true, noLog: true });
  if (!r.ok || !r.data) {
    if (el) el.textContent = '网页采集状态读取失败';
    return;
  }
  const d = r.data;
  if (tk) tk.value = d.token || '';
  if (el) {
    el.textContent =
      `${d.enabled ? '已开启' : '未开启'} · 监听 127.0.0.1:${d.port} · 已采集 ${Number(d.count) || 0} 件` +
      `${d.lastAt ? ' · 最近 ' + new Date(d.lastAt).toLocaleString('zh-CN') : ''}` +
      `${d.lastError ? ' · ' + d.lastError : ''}`;
  }
}

if ($('#extCopy')) {
  $('#extCopy').onclick = async () => {
    const token = ($('#extToken') && $('#extToken').value) || '';
    if (!token) {
      toast('还没有可复制的令牌', true);
      return;
    }
    const r = await call(SD.clipboard.write(token), { noLog: true, silent: true });
    if (r.ok) toast('令牌已复制，粘贴到浏览器扩展里');
    else toast(r.message || '复制失败', true);
  };
}
if ($('#extOpen')) {
  $('#extOpen').onclick = async () => {
    const r = await call(SD.ext.openFolder(), { silent: true, noLog: true });
    if (!r.ok) toast(r.message || '打开扩展文件夹失败', true);
  };
}
if ($('#extClear')) {
  $('#extClear').onclick = async () => {
    const r = await call(SD.ext.clear(), { silent: true, noLog: true });
    if (!r.ok) {
      toast(r.message || '清除失败', true);
      return;
    }
    S.webPrices = {};
    toast('已清除网页采集价');
    extStatusRefresh();
  };
}

/* ------------------------------- 多窗口 / 分屏 ------------------------------ */
function openInNewWindow() {
  const page = S.page || 'overview';
  call(SD.ui.newWindow(page), { silent: true, noLog: true }).then((r) => {
    if (!r.ok) toast(r.message || '打开新窗口失败', true);
  });
}
if ($('#btnNewWindow')) $('#btnNewWindow').onclick = openInNewWindow;
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
  if (String(e.key || '').toLowerCase() !== 'n') return;
  e.preventDefault();
  openInNewWindow();
});

/* --------------------------------- 功能开关 -------------------------------- */

$$('#toggles .tg').forEach((tg) => {
  tg.addEventListener('click', async () => {
    const key = tg.dataset.set;
    const next = !tg.classList.contains('on');
    tg.classList.toggle('on', next);
    const r = await call(SD.settings.set({ [key]: next }));
    if (r.ok) {
      S.settings = r.data;
    } else {
      tg.classList.toggle('on', !next);
    }
  });
});

function renderToggles() {
  const s = S.settings || {};
  $$('#toggles .tg').forEach((tg) => {
    tg.classList.toggle('on', !!s[tg.dataset.set]);
  });
}

/* --------------------------------- 环境信息 -------------------------------- */

async function loadInfo() {
  const r = await call(SD.app.info(), { noLog: true });
  if (!r.ok) return;
  S.info = r.data;
  $('#ver').textContent = r.data.version || '';
  if ($('#btnUpdate')) $('#btnUpdate').title = `检查版本更新 (v${r.data.version || '?'})`;
  S.settings = (await call(SD.settings.get(), { noLog: true })).data || {};
  renderToggles();
  renderRailFooter();
  status('就绪', `${r.data.platform} · ${r.data.encryptionAvailable ? '系统加密可用' : '系统加密不可用'}`);

  if (!r.data.encryptionAvailable) {
    log('系统加密不可用，SSFN 凭证将无法保存', 'a');
  }
}

function renderRailFooter() {
  const p = (S.settings && S.settings.steamPath) || (S.info && S.info.steamPath);
  $('#rf').innerHTML = p
    ? `Steam 路径（点击修改）<br><b>${esc(p)}</b>`
    : 'Steam 路径<br><b>未探测到，点击手动指定</b>';
}

/* 侧边栏底部的 Steam 路径可直接点击修改，不用再去设置抽屉里找 */
if ($('#rf')) {
  $('#rf').style.cursor = 'pointer';
  $('#rf').onclick = async () => {
    const r = await call(SD.settings.chooseSteamPath(), { silent: true });
    if (!r.ok) {
      toast(r.message || '选择目录失败', true);
      return;
    }
    if (!r.data) return;
    const ok = await call(SD.settings.set({ steamPath: r.data }), { silent: true });
    if (ok.ok) {
      S.settings = ok.data;
      if ($('#setSteamPath')) $('#setSteamPath').value = r.data;
      renderRailFooter();
      toast('Steam 路径已更新');
      scanAccounts({ quiet: true });
    }
  };
}

/* ---------------------------------- 账号 ---------------------------------- */

/**
 * 后端 scanAccounts 返回的是 { steamPath, configFound, users[], autoLoginUser, warning }，
 * 字段名也和界面不同（allowAutoLogin / ssfnFiles / timestamp）。
 * 在这里统一成界面使用的形状，避免两边各写一套判断。
 */
function normalizeAccounts(raw) {
  const users = (raw && Array.isArray(raw.users) ? raw.users : []) || [];
  const list = users.map((u) => ({
    steamId: u.steamId,
    personName: u.personaName,
    personaName: u.personaName || u.accountName || '未知账号',
    accountName: u.accountName || '',
    lastLogin: Number(u.timestamp) || 0,
    mostRecent: !!u.mostRecent,
    hasSsfn: Array.isArray(u.ssfnFiles) ? u.ssfnFiles.length > 0 : false,
    ssfnTotal: Number(u.ssfnTotal) || 0,
    ssfnUncertain: !!u.ssfnUncertain,
    autoLogin: !!u.allowAutoLogin,
    rememberPassword: !!u.rememberPassword,
    online: false,
  }));
  return {
    list,
    autoLoginUser: (raw && raw.autoLoginUser) || null,
    warning: (raw && raw.warning) || null,
    configFound: !!(raw && raw.configFound),
  };
}

/** 用会话状态标出哪些账号已经拿到市场 Cookie / 当前在线 */
async function markSessions() {
  const r = await call(SD.session.state(), { silent: true, noLog: true });
  if (!r.ok || !Array.isArray(r.data)) return;
  const map = {};
  r.data.forEach((s) => { map[String(s.steamId)] = s; });
  S.accounts.forEach((a) => {
    const s = map[String(a.steamId)];
    a.hasSession = !!(s && s.hasSession);
    a.online = !!(s && s.online);
  });
}

function applyAccounts(raw) {
  const norm = normalizeAccounts(raw);
  S.accounts = norm.list;
  S.autoLoginUser = norm.autoLoginUser;
  S.accountWarning = norm.warning;
  if (!S.currentSteamId && S.accounts.length) {
    const cur = S.accounts.find((a) => a.mostRecent) || S.accounts[0];
    S.currentSteamId = cur.steamId;
  }
}

async function scanAccounts(opts = {}) {
  const r = await call(SD.accounts.list(), { silent: opts.quiet, noLog: opts.quiet });
  if (!r.ok) {
    renderAccounts();
    return;
  }
  applyAccounts(r.data);
  await markSessions();
  renderAccounts();
  renderQuickAcc();
  renderCurrentBadge();
  ensureAvatars();
  renderKpi();

  // 填充库存页的账号下拉
  const sel = $('#invAcc');
  const prev = sel.value;
  sel.innerHTML =
    S.accounts
      .map((a) => `<option value="${esc(a.steamId)}">${esc(a.personaName || a.accountName)}</option>`)
      .join('') +
    (S.accounts.length > 1 ? '<option value="__all__">全部账号（汇总）</option>' : '');
  if (prev === '__all__' && S.accounts.length > 1) sel.value = prev;
  else if (prev && S.accounts.some((a) => a.steamId === prev)) sel.value = prev;
  else if (S.currentSteamId) sel.value = S.currentSteamId;

  if (!opts.quiet) log(`扫描到 ${S.accounts.length} 个本地账号`, 'b');
  if (S.accountWarning && !S.accounts.length) log(S.accountWarning, 'a');
}

function accountOf(steamId) {
  return S.accounts.find((a) => a.steamId === steamId) || null;
}

/**
 * 把本地头像贴到账号卡、快捷切换和顶部当前账号上。
 * 没有头像的保持昵称首字（渲染时已经写好），切号时也要清掉上一个号的图。
 */
function applyAvatars() {
  const paint = (el, steamId) => {
    if (!el) return;
    const url = steamId ? S.avatars[String(steamId)] : '';
    if (url) {
      el.style.backgroundImage = `url("${url}")`;
      el.textContent = '';
      el.classList.add('hasav');
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('hasav');
    }
  };
  $$('#accBody .acard[data-sid]').forEach((card) => paint(card.querySelector('.av2'), card.dataset.sid));
  $$('#quickAcc .acc[data-switch]').forEach((b) => paint(b.querySelector('.av'), b.dataset.switch));
  paint($('#curAv'), S.currentSteamId);
}

/** 补齐还没取过的头像；Steam 客户端里有缓存文件的会返回 dataURL */
async function ensureAvatars(force) {
  const ids = (S.accounts || []).map((a) => String(a.steamId || '')).filter(Boolean);
  if (!ids.length) return;
  const need = force ? ids : ids.filter((id) => !(id in S.avatars));
  if (!need.length) {
    applyAvatars();
    return;
  }
  if (S.avatarsLoading) return;
  S.avatarsLoading = true;
  const r = await call(SD.accounts.avatars(need), { silent: true, noLog: true });
  S.avatarsLoading = false;
  if (!r.ok) return;
  Object.assign(S.avatars, r.data || {});
  applyAvatars();
}

/** 卡片空间有限：今年只显示「月-日」，更早显示「年-月」，完整时间放 tooltip */
function lastSeenText(ts) {
  if (!ts) return '无记录';
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${mm}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${mm}`;
}

function renderAccounts() {
  const box = $('#accBody');
  if ($('#accCount')) $('#accCount').textContent = S.accounts.length ? `${S.accounts.length} 个` : '';
  if (!S.accounts.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>没有找到本地账号</b>
      请确认 Steam 已经安装并至少登录过一次，或在设置里指定 Steam 安装目录。</div>`;
    $('#accSub').textContent = '未读取到账号';
    return;
  }
  $('#accSub').textContent = `共 ${S.accounts.length} 个本地账号 · 自动登录：${
    (S.accounts.find((a) => a.autoLogin) || {}).personaName || '未设置'
  }`;

  box.innerHTML = S.accounts.map((a) => {
    const on = a.steamId === S.currentSteamId;
    const last = lastSeenText(a.lastLogin);
    const lastTip = a.lastLogin
      ? new Date(a.lastLogin * 1000).toLocaleString('zh-CN')
      : 'loginusers.vdf 里没有这个账号的登录时间';
    // SSFN 是 Steam 自己管的免验证码凭证：本机没生成时写「未启用」，
    // 不要每个号都标「缺 SSFN」，那只是 Steam 版本差异，不是账号有问题。
    const ssfn = a.hasSsfn ? '已就绪' : a.ssfnUncertain ? '待确认' : '未启用';
    const ssfnTip = a.hasSsfn
      ? '本机已保存该账号的 SSFN，可免验证码切换'
      : a.ssfnUncertain
        ? `本机 ${a.ssfnTotal} 个 ssfn 归属未确认，切换时可能要求验证码`
        : '本机没有 ssfn 凭证（新版 Steam 可能不再生成），切换时按 Steam 提示验证即可';
    return `<div class="acard ${on ? 'on' : ''}" data-sid="${esc(a.steamId)}"${
      on ? '' : ' title="点击整张卡片切换到这个账号"'
    }>
      <div class="top">
        <div class="av2">${esc(initial(a.personaName))}</div>
        <div style="min-width:0">
          <div class="nm" data-copy="${esc(a.personaName || a.accountName || '')}" data-copy-label="昵称" title="点击复制昵称">${esc(a.personaName || a.accountName || '未知')}</div>
          <div class="sub" data-copy="${esc(a.accountName || '')}" data-copy-label="账号名" title="点击复制账号名">${esc(a.accountName || '')}</div>
        </div>
        <div class="st2 ${on ? 'on' : 'off'}"><span class="dot ${
          on ? '' : a.autoLogin ? 'a' : 'o'
        }"></span>${on ? '当前' : a.autoLogin ? '自动登录' : '离线'}</div>
      </div>
      <div class="ast ${a.ssfnTotal ? '' : 'two'}">
        <div class="wide" data-copy="${esc(a.steamId)}" data-copy-label="SteamID64" title="点击复制 SteamID64"><div class="k">SteamID64</div><div class="v sid">${esc(a.steamId)}</div></div>
        <div data-copy="${esc(last)}" data-copy-label="最近登录" title="${esc(lastTip)}｜点击复制"><div class="k">最近登录</div><div class="v">${last}</div></div>
        <div data-copy="${a.hasSession ? '已登录' : '未登录'}" data-copy-label="市场会话" title="点击复制"><div class="k">市场会话</div><div class="v">${a.hasSession ? '已登录' : '未登录'}</div></div>
        ${a.ssfnTotal ? `<div data-copy="${esc(ssfn)}" data-copy-label="SSFN" title="${esc(ssfnTip)}｜点击复制"><div class="k">SSFN</div><div class="v">${ssfn}</div></div>` : ''}
      </div>
      <div class="arow">
        <button class="btn ${on ? 's' : 'p'} s" data-switch="${esc(a.steamId)}" ${on || S.switching ? 'disabled' : ''}>${
          on ? '当前账号' : '切换'
        }</button>
        <button class="btn s" data-login="${esc(a.steamId)}" title="为这个账号获取市场 Cookie">登录</button>
        <span style="margin-left:auto">${a.autoLogin ? '自动登录' : '需手动登录'}</span>
      </div>
    </div>`;
  }).join('');
  applyAvatars();
}

function renderQuickAcc() {
  const box = $('#quickAcc');
  if (!S.accounts.length) {
    box.innerHTML = `<div class="empty" style="padding:16px"><b>暂无账号</b>先扫描本地 Steam 账号</div>`;
    return;
  }
  box.innerHTML = S.accounts.slice(0, 6).map((a) => {
    const on = a.steamId === S.currentSteamId;
    return `<button class="acc ${on ? 'on' : ''}" data-switch="${esc(a.steamId)}" ${S.switching ? 'disabled' : ''}>
      <div class="av">${esc(initial(a.personaName))}</div>
      <div style="min-width:0">
        <div class="nm"><span>${esc(a.personaName || a.accountName)}</span>${
          on ? '<span class="pill b" style="height:15px;font-size:9.5px">当前</span>' : ''
        }</div>
        <div class="sub">${esc(a.accountName || '')}</div>
      </div>
      <div class="st"><span class="dot ${a.autoLogin ? '' : 'o'}"></span>${a.autoLogin ? '在线' : '离线'}</div>
    </button>`;
  }).join('');
  applyAvatars();
}

function renderCurrentBadge() {
  const a = accountOf(S.currentSteamId);
  $('#curName').textContent = a ? a.personaName || a.accountName : '未选择';
  $('#curAv').textContent = a ? initial(a.personaName || a.accountName) : '—';
  $('#curDot').className = 'dot ' + (a ? (a.autoLogin ? '' : 'a') : 'o');
  applyAvatars();
}

/* --------------------------------- 账号切换 -------------------------------- */

async function doSwitch(steamId) {
  if (S.switching) return;
  const acc = accountOf(steamId);
  if (!acc) return;
  if (acc.steamId === S.currentSteamId && acc.autoLogin) {
    toast('这已经是当前账号');
    return;
  }

  S.switching = true;
  setSwitchState('切换中', '正在准备');
  renderAccounts();
  renderQuickAcc();
  log(`开始切换到 ${acc.personaName || acc.accountName}`, 'b');

  const r = await call(SD.accounts.switchTo(steamId), { noLog: true });

  S.switching = false;
  if (r.ok) {
    S.currentSteamId = steamId;
    setSwitchState('已切换', r.data && r.data.message);
    log(`已切换到 ${acc.personaName || acc.accountName}`, 'g');
    toast('账号已切换');
    await scanAccounts({ quiet: true });
    // 每个账号的令牌是分开存的，切号后要重新判断当前账号有没有导入
    refreshGuardStatus().catch(() => {});
  } else {
    setSwitchState('切换失败', '');
    log(`切换失败：${r.message}`, 'r');
  }
  renderAccounts();
  renderQuickAcc();
}

function setSwitchState(text, hint) {
  $('#switchState').textContent = text || '空闲';
  if (hint !== undefined) $('#switchHint').textContent = hint || '';
}

document.addEventListener('click', (e) => {
  const sw = e.target.closest('[data-switch]');
  if (sw) {
    doSwitch(sw.dataset.switch);
    return;
  }
  const lg = e.target.closest('[data-login]');
  if (lg) {
    openWebLogin(lg.dataset.login);
  }
});

// 整张账号卡片可点：点按钮/输入框以外的区域就切换到这个号
document.addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, label, select')) return;
  // 点文字优先复制，不触发整卡切换
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    copyText(cp.dataset.copy, cp.dataset.copyLabel);
    return;
  }
  const card = e.target.closest('.acard[data-sid]');
  if (!card || card.classList.contains('on')) return;
  doSwitch(card.dataset.sid);
});

SD.accounts.onStatus((s) => {
  if (!s) return;
  if (s.state) setSwitchState(s.state, s.message || '');
  if (s.message) log(s.message, s.state === 'error' ? 'r' : 'b');
});

/* --------------------------------- 网页登录 -------------------------------- */

async function openWebLogin(steamIdHint) {
  toast('已打开登录窗口，请在窗口内完成登录');
  log('打开登录窗口获取市场 Cookie', 'b');
  const r = await call(SD.session.login(steamIdHint), { noLog: true });
  if (r.ok && r.data && r.data.ok) {
    toast('登录成功，Cookie 已保存');
    log('网页登录成功，Cookie 已保存', 'g');
    await scanAccounts({ quiet: true });
    refreshGuardStatus().catch(() => {});
  } else if (r.ok) {
    log('登录窗口已关闭，未获取到会话', 'a');
  }
}

$('#accLogin').onclick = () => openWebLogin(S.currentSteamId);
$('#accScan').onclick = () => scanAccounts();

/**
 * 连接自检：一次把"登录态在不在 / 社区通道通不通"说清楚。
 * 之前的 401/400 排查全靠猜，现在直接看结论。
 */
async function runDiag() {
  toast('正在自检登录态与社区通道…');
  status('连接自检中…');
  const r = await call(SD.session.diag(), { noLog: true });
  if (!r.ok) {
    toast(r.error.message, true);
    log(`自检失败：${r.error.message}`, 'r');
    return;
  }
  const d = r.data || {};
  const lines = [];
  lines.push(`分区：${d.partition}`);
  lines.push(`社区 Cookie：${(d.cookies.community || []).length} 个${d.cookies.hasLoginSecure ? '（含 steamLoginSecure）' : '（缺 steamLoginSecure）'}`);
  lines.push(`商店 Cookie：${(d.cookies.store || []).length} 个`);
  lines.push(`社区通道：${d.bridgeReady ? '可用' : '不可用'}`);
  // 上架报 Session mismatch 时，原因几乎都是"表单里的 sessionid 与 Cookie 不同源"。
  // 这里只显示掩码后的结论，不输出任何凭证原值。
  if (d.session) {
    if (d.session.error) {
      lines.push(`会话一致性：读取失败（${d.session.error}）`);
    } else {
      lines.push(`表单会话与 Cookie 一致：${d.session.match ? '是' : '否'}`);
      lines.push(`页面登录账号：${d.session.pageSteamId || '未登录'}`);
    }
  }
  if (d.probe) lines.push(`探针：HTTP ${d.probe.status}${d.probe.url ? ' · ' + String(d.probe.url).replace('https://steamcommunity.com', '') : ''}`);
  lines.push(`判定：${d.loggedIn ? '已登录，可以拉数据' : '未登录或会话失效'}`);
  if (d.steamId) lines.push(`SteamID64：${d.steamId}`);
  if (d.error) lines.push(`错误：${d.error}`);

  log('—— 连接自检结果 ——', 'b');
  for (const ln of lines) log(ln, d.loggedIn ? 'g' : 'a');
  toast(d.loggedIn ? '自检通过：登录态有效' : '自检未通过：请重新网页登录', !d.loggedIn);
}

$('#accDiag').onclick = () => runDiag();
$('#ovScan').onclick = () => scanAccounts();

/* --------------------------------- 库存拉取 -------------------------------- */

/* 市场 appid 解析：社区物品（卡牌/背景/表情）在市场上挂在"源游戏"下，
   而不是 753。market_hash_name 形如 "221040-Zombie Dog"，前段就是真实 appid。
   用错 appid 查价会一律 success:false —— 这是"市场最低全是 —"的根因。 */
function marketAppIdOf(appId, hashName) {
  const b = Number(appId);
  // ★ 社区物品（卡牌/背景/表情/宝珠）在市场上的 appid 永远是 753，
  //   哪怕 hash_name 前缀写着源游戏 appid（如 "1406990-Maple Cinnamon"）。
  //   用源 appid 去查会返回 success:true 但没有价格 —— 这是"价格全空"的根因。
  if (b === 753) return 753;
  const m = /^(\d+)-/.exec(String(hashName || ''));
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number.isFinite(b) && b > 0 ? b : 753;
}

async function loadInventory(appIdOverride) {
  const steamId = $('#invAcc').value || S.currentSteamId;
  if (!steamId) {
    toast('请先选择一个账号', true);
    return;
  }
  const custom = Number($('#invAppCustom') && $('#invAppCustom').value);
  const appId = Number(appIdOverride || custom || $('#invApp').value || 730);
  if (steamId === '__all__') {
    await loadInventoryAll(appId);
    return;
  }
  S.invAll = false;

  status('正在拉取库存…');
  $('#invSub').textContent = '拉取中…';
  // 成本按账号存，切号后必须换一份，否则会把上一个号的盈亏标到新号上
  await loadCosts(steamId);

  // contextId 传 null，让后端按注册表决定（Steam 本体 753 必须是 6，不是 2）
  const r = await call(SD.inventory.fetch(steamId, appId, null), { noLog: true });
  if (!r.ok) {
    const rawMsg = r.message || (r.error && r.error.message) || '未知错误';
    /**
     * 该游戏没有社区市场（Steam 返回 k_EResultNoMatch）。
     * 这类 app 留在下拉里毫无意义，后端已把它记入 noMarketApps，
     * 这里立刻重建下拉并把它去掉，同时给出人话解释。
     */
    if (/k_EResultNoMatch|没有社区市场库存/.test(rawMsg)) {
      $('#invSub').textContent = '该游戏不支持社区市场';
      $('#invBody').innerHTML = `<div class="empty"><b>这个游戏没有社区市场</b>
        <div style="margin-top:6px;color:var(--muted);font-size:11.5px">
          已自动从「游戏」下拉里移除，不会再出现在列表中。<br>
          请改选其它游戏，或选择「Steam 本体」查看卡牌/背景/表情。
        </div></div>`;
      status('该游戏不支持社区市场，已从列表移除');
      toast('该游戏不支持社区市场，已从游戏列表移除', true);
      ensureInvAppOptions(true).then(() => {
        const sel = $('#invApp');
        if (sel) sel.value = '753';
      });
      return;
    }

    $('#invSub').textContent = '拉取失败';
    const msg = esc(rawMsg);
    $('#invBody').innerHTML = `<div class="empty"><b>拉取失败</b>
      <div style="margin-top:6px;white-space:pre-wrap;text-align:left;max-width:720px;color:var(--muted);font-size:11px">${msg}</div>
      <div style="margin-top:8px"><button class="btn s" id="invErrDiag">连接自检</button></div></div>`;
    const d = $('#invErrDiag');
    if (d) d.onclick = () => { location.hash = ''; goto('accounts'); runDiag(); };
    status('拉取失败');
    return;
  }

  const data = r.data || {};
  const groups = buildGroups(data);

  S.invRows = groups.map((g) => ({
    ...g,
    // 行情与定价字段由前端填充（后端不查价）
    lowestPrice: 0,
    medianPrice: 0,
    volume: 0,
    priceYuan: 0,
    noData: false,
    quoteError: '',
  }));
  S.invExpanded = new Set();
  S.selected = new Set();
  S.invAppId = appId;
  try { localStorage.setItem('sd_last_inv_app', String(appId)); } catch { /* ignore */ }
  S.invMeta = {
    appId,
    appName: data.appName || '',
    totalAssets: Number(data.totalAssets) || 0,
    sellableAssets: Number(data.sellableAssets) || 0,
  };
  // 换了账号/游戏就重置筛选条件，否则会"拉到了却看不见"
  S.invView.q = '';
  S.invView.filter = 'all';
  S.invView.cat = 'all';
  S.invView.limit = INV_PAGE;
  const se = $('#invSearch');
  if (se) se.value = '';
  syncInvFilterTabs();

  const pieces = S.invRows.reduce((s, x) => s + x.qty, 0);
  $('#invSub').textContent =
    `${S.invRows.length} 种 / ${pieces} 件 · ${data.appName || 'appid ' + appId}` +
    `${data.usedAttempt > 1 ? `（第 ${data.usedAttempt} 组参数成功）` : ''}`;
  renderInventory();
  status(`库存 ${pieces} 件（${S.invRows.length} 种）`);
  log(`拉取到 ${pieces} 件物品，聚合为 ${S.invRows.length} 种（appid ${appId}）`, 'b');

  // 记一个估值快照，概览页趋势图用
  const est = S.invRows.reduce((s, x) => s + (Number(x.priceYuan) || 0), 0);
  pushTrend(est);
  renderTrend();
  renderRecent();

  /**
   * 拉完库存自动读取 Steam 官方实时价格。
   * 用户的核心诉求是"打开库存就能看到价格"，而不是再点一次「查询行情」。
   * 关闭方式：设置里 autoQuote = false。
   */
  if ((S.settings || {}).autoQuote !== false) {
    const quotable = S.invRows.filter((x) => x.marketHashName && x.marketableQty > 0).length;
    if (quotable > 0) {
      log(`已拉取库存，开始自动读取 ${quotable} 种物品的 Steam 官方实时行情…`, 'b');
      // 让首屏先渲染出来，再去查价，避免界面卡住
      setTimeout(() => { quoteAll({ auto: true }); }, 350);
    }
  }
}

/**
 * 全部账号汇总视图。
 *
 * 每个账号单独用自己保存的会话去读库存（后端 inventory.fetchInventory 支持按 steamId 取 Cookie），
 * 前端把同一件 market_hash_name 合并成一行，记录每个号各有多少件。
 * 这是只读视图：汇总行不能直接上架（不同账号的资产不能混在一起卖），
 * 要看行情、比数量、决定从哪个号卖，用它最方便。
 */
async function loadInventoryAll(appId) {
  const accs = (S.accounts || []).filter((a) => a.steamId);
  if (!accs.length) {
    toast('没有可汇总的账号', true);
    return;
  }
  S.invAll = true;
  status('正在汇总全部账号的库存…');
  $('#invSub').textContent = `汇总中…（0/${accs.length}）`;
  $('#invBody').innerHTML =
    '<div class="empty"><b>正在汇总全部账号…</b>每个账号单独读取库存，账号多的需要等一会儿。</div>';

  const queue = accs.slice();
  const results = [];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      let r = null;
      try {
        r = await call(SD.inventory.fetch(a.steamId, appId, null), { noLog: true, silent: true });
      } catch {
        r = null;
      }
      results.push({
        acc: a,
        ok: !!(r && r.ok && r.data),
        data: r && r.ok ? r.data : null,
        message: r && !r.ok ? r.message || '读取失败' : '',
      });
      done += 1;
      $('#invSub').textContent = `汇总中…（${done}/${accs.length}）`;
    }
  };
  // 同时读 3 个号：再高容易撞社区接口限流
  await Promise.all(Array.from({ length: Math.min(3, accs.length) }, () => worker()));

  const map = new Map();
  const errs = [];
  let okAccounts = 0;
  for (const it of results) {
    const who = it.acc.personaName || it.acc.accountName || String(it.acc.steamId).slice(-6);
    if (!it.ok) {
      errs.push(`${who}：${it.message || '读取失败'}`);
      continue;
    }
    okAccounts += 1;
    for (const g of buildGroups(it.data)) {
      const key = g.marketHashName || g.key;
      let rec = map.get(key);
      if (!rec) {
        rec = {
          key,
          marketHashName: g.marketHashName,
          name: g.name,
          type: g.type,
          iconUrl: g.iconUrl,
          appId: g.appId,
          sourceAppId: g.sourceAppId,
          descriptions: g.descriptions || [],
          qty: 0,
          sellableQty: 0,
          marketableQty: 0,
          tradableQty: 0,
          assets: [],
          byAccount: [],
          readonly: true,
          // 行情字段由前端查价填充
          lowestPrice: 0,
          medianPrice: 0,
          volume: 0,
          priceYuan: 0,
          noData: false,
          quoteError: '',
        };
        map.set(key, rec);
      }
      rec.qty += g.qty;
      rec.sellableQty += g.sellableQty;
      rec.marketableQty += g.marketableQty;
      rec.tradableQty += g.tradableQty;
      rec.assets.push(
        ...(g.assets || []).map((a) => ({ ...a, steamId: it.acc.steamId, account: who }))
      );
      rec.byAccount.push({
        steamId: it.acc.steamId,
        name: who,
        qty: g.qty,
        sellableQty: g.sellableQty,
      });
    }
  }

  S.invRows = [...map.values()].sort((a, b) => b.qty - a.qty);
  S.invExpanded = new Set();
  S.selected = new Set();
  S.invAppId = appId;
  S.invMeta = { appId, appName: '', totalAssets: 0, sellableAssets: 0, multi: true };
  S.invView.q = '';
  S.invView.filter = 'all';
  S.invView.cat = 'all';
  S.invView.limit = INV_PAGE;
  const se = $('#invSearch');
  if (se) se.value = '';
  syncInvFilterTabs();

  const pieces = S.invRows.reduce((s, x) => s + x.qty, 0);
  $('#invSub').textContent = `汇总 ${okAccounts} 个账号 · ${S.invRows.length} 种 / ${pieces} 件`;
  renderInventory();
  status(`汇总库存 ${pieces} 件（${S.invRows.length} 种，${okAccounts} 个账号）`);
  log(`汇总 ${okAccounts} 个账号的库存：${pieces} 件 / ${S.invRows.length} 种`, 'b');
  if (errs.length) {
    log(`部分账号读取失败：${errs.join('；')}`, 'a');
    toast(`${errs.length} 个账号读取失败，详情看日志`, true);
  }

  // 汇总视图同样自动查价：价格是公开接口，与账号无关
  if ((S.settings || {}).autoQuote !== false) {
    const quotable = S.invRows.filter((x) => x.marketHashName).length;
    if (quotable > 0) {
      log(`开始读取 ${quotable} 种物品的 Steam 官方实时行情…`, 'b');
      setTimeout(() => { quoteAll({ auto: true }); }, 350);
    }
  }
}

/**
 * 把后端载荷整理成"组"数组。
 *
 * 后端 inventory.fetchInventory 已按 market_hash_name 聚合（groups），
 * 这里只做兼容兜底：万一拿到的是旧版载荷（只有逐件 items），
 * 就地聚一次，而不是退化成"一行一件"。
 */
function buildGroups(data) {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (groups.length) {
    return groups.map((g) => ({
      ...g,
      key: g.key || g.marketHashName || `${g.sourceAppId}:${g.name}`,
      assets: Array.isArray(g.assets) ? g.assets : [],
      sellableQty: Number(g.sellableQty) || 0,
      marketableQty: Number(g.marketableQty) || 0,
      tradableQty: Number(g.tradableQty) || 0,
      qty: Number(g.qty) || 0,
      sourceAppId: Number(g.sourceAppId) || Number(g.appId) || 0,
    }));
  }

  // ---- 兜底路径：逐件载荷就地聚合 ----
  const items = data.items || data.assets || [];
  const map = new Map();
  items.forEach((it, i) => {
    const hold = it.tradeHoldText;
    const holdText = typeof hold === 'string' ? hold : (hold && hold.text) || '';
    const assetId = it.assetId || it.assetid || String(i);
    const hash = it.marketHashName || '';
    const appId = Number(it.appId) || 0;
    const key = hash || `${appId}:${assetId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        marketHashName: hash,
        name: hash || it.name || '未知物品',
        type: it.type || '',
        iconUrl: it.iconUrl || null,
        appId: marketAppIdOf(appId, hash),
        sourceAppId: appId,
        descriptions: [],
        qty: 0,
        sellableQty: 0,
        marketableQty: 0,
        tradableQty: 0,
        assets: [],
      };
      map.set(key, g);
    }
    const marketable = it.marketable !== false;
    const tradable = it.tradable !== false;
    g.qty += 1;
    if (marketable) g.marketableQty += 1;
    if (tradable) g.tradableQty += 1;
    // 上架只看 marketable；tradable=false 只是不能玩家间交易
    if (marketable) g.sellableQty += 1;
    g.assets.push({
      assetId,
      contextId: String(it.contextId || data.contextId || '2'),
      marketable,
      tradable,
      tradeHoldText: holdText,
    });
    if (!g.tradeHoldText && holdText) g.tradeHoldText = holdText;
  });
  for (const g of map.values()) {
    g.marketable = g.marketableQty === g.qty;
    g.tradable = g.tradableQty === g.qty;
  }
  return [...map.values()];
}

$('#invReload').onclick = () => loadInventory();
// 换账号/选「全部账号（汇总）」都应该立刻重新拉，否则界面还显示上一个号的东西
$('#invAcc').onchange = () => loadInventory();
$('#invApp').onchange = () => {
  if ($('#invAppCustom')) $('#invAppCustom').value = '';
  loadInventory();
};
/**
 * 自定义 AppID：识别游戏名 + 探测是否开通市场 + 永久保存。
 * 注册表不可能收录所有开了市场的游戏，这里让用户自己补，补完就能拉库存查价。
 */
async function addCustomApp() {
  const input = $('#invAppCustom');
  const btn = $('#invAppAdd');
  const raw = Number(input && input.value);
  if (!Number.isFinite(raw) || raw <= 0) {
    toast('请输入纯数字 AppID', true);
    return;
  }

  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '探测中…';

  const r = await call(SD.library.resolveApp(raw), { noLog: true });

  btn.disabled = false;
  btn.textContent = old;

  if (!r.ok) {
    toast(r.message || 'AppID 解析失败', true);
    log(`添加 AppID ${raw} 失败：${r.message || ''}`, 'r');
    return;
  }

  const d = r.data || {};
  const okMarket = !!d.tradeable;
  toast(`${d.name || ('App ' + d.appId)}${okMarket ? ` · 市场可交易（${d.probeCount} 件在售）` : ' · 未探测到市场'}`);
  log(`添加 AppID ${d.appId} → ${d.name}｜${d.marketNote || ''}`, okMarket ? 'g' : 'a');

  await ensureInvAppOptions(true);
  const sel = $('#invApp');
  if (sel) sel.value = String(d.appId);
  S.invAppId = Number(d.appId);
  if (input) input.value = '';

  // 加完直接拉这个游戏的库存，省一次点击
  // （这里曾经写的是 S.invAccId —— 该字段从未被赋值，条件恒为 false，
  //   所以"加完自动拉取"一直是死代码，点了添加必须再手动点一次重新拉取）
  if ($('#invAcc').value || S.currentSteamId) await loadInventory(Number(d.appId));
}

if ($('#invAppAdd')) {
  $('#invAppAdd').onclick = addCustomApp;
  if ($('#invAppCustom')) {
    $('#invAppCustom').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCustomApp(); }
    });
  }
}

/**
 * 探测库存：逐个问 Steam "这个账号在哪个游戏里有物品"。
 * 这就是"所有支持交易市场的游戏都能拉"的落地——不靠硬编码列表，直接问。
 */
async function probeInventory() {
  const steamId = $('#invAcc').value || S.currentSteamId;
  if (!steamId) {
    toast('请先选择账号', true);
    return;
  }
  if (steamId === '__all__') {
    toast('探测库存请先在账号下拉里选单个账号', true);
    return;
  }
  const btn = $('#invProbe');
  btn.disabled = true;
  btn.textContent = '探测中…';
  status('正在探测各游戏库存…');

  // 优先探测：注册表全集 + 库里已有游戏
  let candidateIds = [];
  try {
    const reg = await call(SD.library.registry(), { silent: true, noLog: true });
    if (reg.ok && Array.isArray(reg.data)) candidateIds = reg.data.map((x) => x.appId);
  } catch { /* ignore */ }
  if (S.lib && S.lib.length) {
    for (const g of S.lib) if (!candidateIds.includes(Number(g.appId))) candidateIds.push(Number(g.appId));
  }

  log(`开始探测 ${candidateIds.length} 个 AppID 的库存…`, 'b');
  const r = await call(SD.inventory.discover(steamId, candidateIds, { concurrency: 3 }), { noLog: true });
  btn.disabled = false;
  btn.textContent = '探测库存';

  if (!r.ok) {
    status('探测失败');
    toast(r.message || '探测失败', true);
    log(`探测失败：${r.message}`, 'r');
    return;
  }

  const found = (r.data && r.data.found) || [];
  if (!found.length) {
    status('未探测到物品');
    toast('这个账号在任何已支持的游戏里都没有物品', true);
    log('探测完成：未发现任何有物品的游戏。若确认有物品，请检查会话是否有效（连接自检）。', 'a');
    return;
  }

  // 把探测到的游戏写进下拉框，并自动选中数量最多的那个
  S.probeApps = found;
  renderInvAppOptions(found);
  const top = found[0];
  if ($('#invAppCustom')) $('#invAppCustom').value = '';
  $('#invApp').value = String(top.appId);
  toast(`发现 ${found.length} 个有物品的游戏，已选中 ${top.name}`);
  log(`探测完成：` + found.map((f) => `${f.name}(${f.appId}) ${f.count}件`).join('、'), 'g');
  await loadInventory(top.appId);
}

/** 用探测结果重建游戏下拉：有物品的排最前 */
function renderInvAppOptions(found) {
  const sel = $('#invApp');
  if (!sel) return;
  const prev = sel.value;
  const withItems = found || S.probeApps || [];
  const ids = new Set(withItems.map((f) => Number(f.appId)));
  const opts = [];

  for (const f of withItems) {
    opts.push(`<option value="${f.appId}">${esc(f.name)} (${f.appId}) · ${f.count} 件</option>`);
  }
  // 库里有但探测无物品的，放到后面，仍然可点（可能只是暂时为空）
  for (const g of (S.lib || [])) {
    const id = Number(g.appId);
    if (ids.has(id)) continue;
    if (!g.tradeable) continue;
    opts.push(`<option value="${id}">${esc(g.name || 'App ' + id)} (${id})</option>`);
  }
  // 兜底：注册表常用几个，保证下拉不空
  if (!opts.length) {
    opts.push('<option value="753">Steam 本体（卡牌/背景/表情） (753)</option>');
    opts.push('<option value="730">Counter-Strike 2 (730)</option>');
    opts.push('<option value="570">Dota 2 (570)</option>');
    opts.push('<option value="440">Team Fortress 2 (440)</option>');
  }
  sel.innerHTML = opts.join('');
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
}

if ($('#invProbe')) $('#invProbe').onclick = () => probeInventory();

/* --------------------------------- 行情查价 -------------------------------- */

async function quoteAll(opts = {}) {
  // 组级的 appId 就是"市场 appid"（后端按 hash_name 前缀解析过），
  // 用它查价才查得到社区物品 —— 用库存来源 appid 会一律 success:false
  const rows = S.invRows.filter((r) => r.marketHashName && r.marketableQty > 0);
  if (!rows.length) {
    if (!opts.auto) toast('没有可查价的物品', true);
    return;
  }
  // 去重键 = 市场 appid + hash_name 成对，避免不同游戏同名物品串价
  const seen = new Set();
  const pairs = [];
  for (const r of rows) {
    const app = r.appId || marketAppIdOf(r.sourceAppId, r.marketHashName);
    const key = `${app}:${r.marketHashName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ appId: app, hashName: r.marketHashName });
  }

  toast(
    opts.auto
      ? `已自动开始读取 Steam 官方行情（${pairs.length} 种）…`
      : `开始查询 ${pairs.length} 个行情，注意接口限流`
  );
  status('查询行情中…');
  $('#invQuote').disabled = true;

  // 后端接受 { appId, hashName } 数组，逐件用各自的市场 appid 查
  const r = await call(SD.market.quote(Number($('#invApp').value) || 730, pairs), { noLog: true });
  $('#invQuote').disabled = false;

  if (!r.ok) {
    status('查价失败');
    toast(r.message || '查价失败', true);
    log(`查价失败：${r.message || ''}`, 'r');
    return;
  }

  const results = (r.data && r.data.results) || [];
  const map = {};
  const byHash = {};
  results.forEach((q) => {
    if (!q || !q.marketHashName) return;
    map[`${q.appId}:${q.marketHashName}`] = q;
    // 兜底索引：hash_name 唯一就能对上，避免后端少回 appId 时整列变 —
    if (!byHash[q.marketHashName]) byHash[q.marketHashName] = q;
  });

  let hit = 0;
  let noData = 0;
  let failed = 0;
  let firstErr = '';

  S.invRows.forEach((row) => {
    const app = row.appId || marketAppIdOf(row.sourceAppId, row.marketHashName);
    const q = map[`${app}:${row.marketHashName}`] || byHash[row.marketHashName];
    if (!q) return;
    row.lowestPrice = q.lowest || 0;
    row.medianPrice = q.median || 0;
    row.volume = q.volume || 0;
    // 最高求购价：想立刻卖出时能成交的价格（不是最低求购单，那个只会更低）
    row.buyPrice = Number(q.buy) > 0 ? Number(q.buy) : 0;
    row.buyCount = Number(q.buyCount) || 0;
    row.buyOk = q.buyCurrency === 23; // 只有人民币的报价才能直接当 ¥ 显示
    row.noData = q.state === 'no-data';
    row.quoteError = q.state === 'error' ? q.message || '查价失败' : '';

    if (row.lowestPrice > 0 || row.medianPrice > 0) hit += 1;
    else if (q.state === 'error') { failed += 1; if (!firstErr) firstErr = q.message || ''; }
    else noData += 1;
  });

  autoFillPrices(S.invRows, false);
  renderInventory();
  renderKpi();

  // 行情到位后重新记一次估值快照 —— 拉取时价格全是 0，
  // 不在查价后补录，概览趋势图会永远是一条贴着 0 的线。
  const est = S.invRows.reduce(
    (s, r) => s + (r.priceYuan > 0 ? r.priceYuan : r.lowestPrice || 0) * (r.qty || 0),
    0
  );
  if (est > 0) {
    pushTrend(est);
    renderTrend();
  }

  // 分母只用"真正参与了查价的可售物品"：
  // 用全量会显示成 22/210，看着像查价大面积失败，其实是另外 188 件不可上架
  const total = pairs.length;
  const skipped = S.invRows.length - total;
  if (hit > 0) {
    toast(
      `行情更新完成：${hit}/${total} 种有价${noData ? `，${noData} 种无挂单` : ''}${
        failed ? `，${failed} 种查价失败` : ''
      }${skipped ? `（另 ${skipped} 件不可上架，无行情）` : ''}`
    );
  } else if (failed > 0) {
    toast(`查价失败：${firstErr || '接口无响应'}`, true);
  } else if (noData > 0) {
    toast(`${noData} 种物品在市场上没有挂单，取不到价格`, true);
  }
  status(`已更新 ${hit}/${total} 种有价${skipped ? ` · ${skipped} 件不可上架` : ''}`);
  if (failed) log(`查价失败 ${failed} 种，首个原因：${firstErr}`, 'r');
  log(`查价完成：${hit} 种有价 / ${noData} 种无挂单 / ${failed} 种失败`, hit ? 'b' : 'a');
}

SD.market.onProgress((p) => {
  if (!p) return;
  $('#invSub').textContent = p.message || '';
  status(p.message || '查价中');
});

$('#invQuote').onclick = () => quoteAll();

/* ------------------- 物品详情：Steam 官方实时行情（图表） ------------------- */

const IDT = { row: null, data: null, range: 7, alertDir: 'below' };

/** 物品详情里「价格提醒」区域：列出这件物品已有的提醒 */
function renderIdtAlerts(row) {
  const box = $('#idtAlertList');
  if (!box || !row) return;
  const appId = row.appId || marketAppIdOf(row.sourceAppId, row.marketHashName);
  const items = (S.priceAlerts || []).filter(
    (a) => a.marketHashName === row.marketHashName && Number(a.appId) === Number(appId)
  );
  if (!items.length) {
    box.innerHTML = '<div style="font-size:11.5px;color:var(--dim)">这件物品还没有设置提醒</div>';
    return;
  }
  box.innerHTML = items
    .map(
      (a) => `<div class="idt-alert-item">
      <span>${a.dir === 'above' ? '涨到' : '跌到'} <b>${money(a.price)}</b> 时提醒</span>
      <span>当前 ${a.lastPrice > 0 ? money(a.lastPrice) : '—'}</span>
      <span class="sp"></span>
      <button class="idt-alert-del" data-alert-del="${esc(a.id)}" title="删除这条提醒">删除</button>
    </div>`
    )
    .join('');
}

async function loadPriceAlerts() {
  const r = await call(SD.alerts.list(), { silent: true, noLog: true });
  if (r.ok) S.priceAlerts = r.data || [];
}

function openItemDetail(row) {
  IDT.row = row;
  IDT.data = null;
  IDT.usedPts = [];
  IDT.range = 7;
  IDT.alertDir = 'below';
  const ap = $('#idtAlertPrice');
  if (ap) ap.value = '';
  $$('#idtAlertDir .tab').forEach((b) => b.classList.toggle('on', b.dataset.adir === 'below'));
  if ($('#idtAlertHint')) $('#idtAlertHint').textContent = '跌到目标价以下时通知你';
  renderIdtAlerts(row);
  renderCostCard(row);

  $('#idtName').innerHTML = `${categoryBadgeHtml(row)} ${esc(row.name)}`;
  $('#idtMeta').textContent = row.readonly
    ? `${row.type || '社区物品'} · ${(row.byAccount || []).length} 个账号共 ${row.qty} 件（汇总视图，不能直接上架）`
    : `${row.type || '社区物品'} · 库存 ${row.qty} 件 · ${row.sellableQty} 件可上架`;
  const sellCard = $('#idtSellCard');
  if (sellCard) sellCard.style.display = row.readonly ? 'none' : '';
  // 汇总视图拿不到单件挂价，比价没有意义，一起隐藏
  const buffCard = $('#idtBuffCard');
  if (buffCard) buffCard.style.display = row.readonly ? 'none' : '';
  $('#idtIcon').innerHTML = row.iconUrl
    ? `<img src="${esc(row.iconUrl)}" alt="" />`
    : esc(initial(row.name));
  $('#idtPrice').textContent = row.lowestPrice > 0 ? money(row.lowestPrice) : '—';
  $('#idtPriceSub').textContent = row.volume
    ? `当前最低在售 · ${row.volume} 人在售`
    : '当前最低在售';

  const input = $('#idtSellPrice');
  if (row.priceYuan > 0) input.value = row.priceYuan.toFixed(2);
  else if (row.lowestPrice > 0) {
    input.value = Math.max(0.03, Math.round((row.lowestPrice - 0.01) * 100) / 100).toFixed(2);
  } else input.value = '';

  $('#idtLowest').textContent = row.lowestPrice > 0 ? `最低在售 ${money(row.lowestPrice)}` : '暂无在售';
  const webRec = (S.webPrices || {})[row.marketHashName];
  if ($('#idtWebPrice')) {
    $('#idtWebPrice').textContent = webRec ? `网页采集 ${money(webRec.price)}` : '网页采集 —';
    $('#idtWebPrice').title = webRec
      ? `采集于 ${new Date(webRec.at).toLocaleString('zh-CN')}`
      : '浏览器扩展采集的 Steam 市场价';
  }
  $('#idtStats').innerHTML = '';
  $('#idtChartWrap').innerHTML = '<div class="idt-loading">正在读取 Steam 官方实时行情…</div>';
  $$('#idtRanges .tab').forEach((b) => b.classList.toggle('on', b.dataset.range === '7'));

  // BUFF 手动比价：回填上次记下的价格与该物品用的费率
  const buffRec = ((S.settings && S.settings.buffPrices) || {})[row.marketHashName];
  if ($('#idtBuffPrice')) $('#idtBuffPrice').value = buffRec && buffRec.price > 0 ? String(buffRec.price) : '';
  if ($('#idtBuffFee')) $('#idtBuffFee').value = String(buffFeePct());
  updateIdtNet();

  // 物品级自动改价策略：只对当前物品生效
  const policy = ((S.settings && S.settings.itemPolicies) || {})[row.marketHashName] || {};
  const polCard = $('#idtPolicyCard');
  if (polCard) polCard.style.display = row.readonly ? 'none' : '';
  if ($('#idtPolicyAuto')) $('#idtPolicyAuto').checked = policy.auto !== false;
  if ($('#idtPolicyMin')) $('#idtPolicyMin').value = Number(policy.minPrice) > 0 ? String(policy.minPrice) : '';
  if ($('#idtPolicyHint')) {
    $('#idtPolicyHint').textContent =
      policy.auto === false
        ? '这件物品已关闭自动改价'
        : Number(policy.minPrice) > 0
        ? `自动改价不低于 ${money(Number(policy.minPrice))}`
        : '留空表示不限制';
  }

  $('#itemDetail').classList.add('on');
  loadItemDetail();
}

function closeItemDetail() {
  $('#itemDetail').classList.remove('on');
  IDT.row = null;
  IDT.data = null;
}

function updateIdtNet() {
  const v = Number($('#idtSellPrice').value) || 0;
  $('#idtNet').textContent = v > 0 ? `预计到手 ${money(netOf(v))}（手续费 ${money(v - netOf(v))}）` : '预计到手 —';
  updateBuffCompare();
}

/* ------------------------------ BUFF 手动比价 ------------------------------
   BUFF 没有公开接口，也不允许第三方自动抓价。这里让用户手填 BUFF 在售价，
   软件只做两边到手的算术对比，并把填过的价格记在本地，下次打开还在。 */
function buffFeePct() {
  const v = Number(S.settings && S.settings.buffFeePct);
  return Number.isFinite(v) ? Math.min(20, Math.max(0, v)) : 2.5;
}

function updateBuffCompare() {
  const res = $('#idtBuffResult');
  if (!res) return;
  const row = IDT.row;
  const buffPrice = Number($('#idtBuffPrice') && $('#idtBuffPrice').value) || 0;
  const feePct = Math.min(20, Math.max(0, Number($('#idtBuffFee') && $('#idtBuffFee').value) || 0));
  const steamPrice = Number($('#idtSellPrice') && $('#idtSellPrice').value) || 0;
  if (!row || !buffPrice) {
    res.innerHTML = '';
    if ($('#idtBuffHint')) $('#idtBuffHint').textContent = '填价格后显示两边到手差额';
    return;
  }
  const steamNet = netOf(steamPrice);
  const buffNet = Math.round(buffPrice * (1 - feePct / 100) * 100) / 100;
  const diff = Math.round((steamNet - buffNet) * 100) / 100;
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
  const color = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--amber)' : 'var(--text)';
  const tip =
    diff > 0
      ? `按同样挂价，Steam 到手多 <b>${money(diff)}</b>，优先挂 Steam。`
      : diff < 0
        ? `BUFF 到手多 <b>${money(-diff)}</b>；BUFF 还要考虑提现与交易冷却，价格以你看到的为准。`
        : '两边到手基本一样，选成交更快的一边。';
  res.innerHTML =
    `<div class="buff-grid">` +
    `<div class="buff-cell"><div class="bl">Steam 到手（挂 ${steamPrice > 0 ? money(steamPrice) : '未填价'}）</div>` +
    `<div class="bv">${money(steamNet)}</div><div class="bs">已扣 Steam 5% + 发行商 10%（各自最低 ¥0.07）</div></div>` +
    `<div class="buff-cell"><div class="bl">BUFF 到手（${money(buffPrice)} · 费率 ${feePct}%）</div>` +
    `<div class="bv">${money(buffNet)}</div><div class="bs">按你填的费率估算</div></div>` +
    `<div class="buff-cell"><div class="bl">差额</div>` +
    `<div class="bv" style="color:${color}">${sign}${money(Math.abs(diff))}</div>` +
    `<div class="bs">${diff > 0 ? 'Steam 更划算' : diff < 0 ? 'BUFF 更划算' : '基本持平'}</div></div>` +
    `</div><div class="buff-tip">${tip}</div>`;
  if ($('#idtBuffHint')) $('#idtBuffHint').textContent = `当前按 BUFF 手续费 ${feePct}% 估算`;
}

function buffSave() {
  const row = IDT.row;
  if (!row || !row.marketHashName) return;
  const price = Math.max(0, Number($('#idtBuffPrice').value) || 0);
  const fee = Math.min(20, Math.max(0, Number($('#idtBuffFee').value) || 0));
  const map = { ...((S.settings && S.settings.buffPrices) || {}) };
  if (price > 0) map[row.marketHashName] = { price, at: Date.now() };
  else delete map[row.marketHashName];
  // 只留最近 300 条，防止 settings.json 无限变大
  const keys = Object.keys(map);
  if (keys.length > 300) {
    keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    keys.slice(0, keys.length - 300).forEach((k) => delete map[k]);
  }
  call(SD.settings.set({ buffFeePct: fee, buffPrices: map })).then((r) => {
    if (r.ok) {
      S.settings = r.data;
      toast(price > 0 ? 'BUFF 价格已记住' : '已清除这个物品的 BUFF 价格');
    } else toast(r.message || '保存失败', true);
  });
}

async function loadItemDetail() {
  const row = IDT.row;
  if (!row) return;
  const app = row.appId || marketAppIdOf(row.sourceAppId, row.marketHashName);

  $('#idtChartWrap').innerHTML = '<div class="idt-loading">正在读取 Steam 官方实时行情…</div>';
  $('#idtStats').innerHTML = '';
  $('#idtLive').textContent = '正在连接 Steam 市场…';

  /**
   * 当前价与历史行情分开请求：
   *   - 当前价是公开接口，通常 0.3 秒内返回，先渲染出来，用户不必干等；
   *   - 历史行情需要登录态（要走隐藏的社区窗口），冷启动可能十几秒。
   * 两者并发发出，谁先回来先画谁。
   */
  const quoteP = call(SD.market.quoteOne(app, row.marketHashName), { noLog: true, silent: true });
  const histP = call(SD.market.history(app, row.marketHashName), { noLog: true, silent: true });

  const qr = await quoteP;
  let q = null;
  if (qr.ok && qr.data && (qr.data.lowest || qr.data.median)) {
    q = qr.data;
    row.lowestPrice = q.lowest || row.lowestPrice;
    row.medianPrice = q.median || row.medianPrice;
    row.volume = q.volume || row.volume;
    row.noData = false;
    $('#idtPrice').textContent = money(row.lowestPrice);
    $('#idtPriceSub').textContent = row.volume
      ? `当前最低在售 · ${row.volume} 人在售`
      : '当前最低在售';
    $('#idtLowest').textContent = `最低在售 ${money(row.lowestPrice)}`;
    const input = $('#idtSellPrice');
    if (!input.value && row.lowestPrice > 0) {
      input.value = Math.max(0.03, Math.round((row.lowestPrice - 0.01) * 100) / 100).toFixed(2);
      updateIdtNet();
    }
    // 成本卡片用的是最新行情，价格回来之后要重算一次盈亏
    renderCostCard(row);
  }
  const hr = await histP;
  const h = hr.ok ? hr.data : null;
  const historyError = hr.ok ? null : hr.message || '历史行情读取失败';

  IDT.data = { quote: q, history: h, historyError };
  $('#idtLive').textContent = h ? '实时 Steam 官方市场数据' : '当前价实时 · 历史数据不可用';
  if (h && h.points && h.points.length) {
    // renderIdtChart 内部会用同一批点刷新统计卡片
    renderIdtChart(h, IDT.range);
  } else {
    IDT.usedPts = [];
    $('#idtChartWrap').innerHTML = `<div class="idt-loading">暂无历史成交数据<br>
      <span style="font-size:11.5px;max-width:520px">${esc(
        historyError || '该物品在 Steam 市场没有成交记录，或当前登录会话无法读取历史行情。'
      )}</span></div>`;
    renderIdtStats(h, q);
  }
  renderInventory();
}

/**
 * 详情页统计卡片。
 * 注意：区间均价 / 最高最低 / 成交量必须按"当前选中的区间"算。
 * 之前直接用后端返回的全量 h.avg/h.max/h.min，会出现
 * 图上只有 0.32–0.46、卡片却写"区间最高 ¥0.53 / 最低 ¥0.13"的自相矛盾。
 */
function renderIdtStats(h, q) {
  const box = $('#idtStats');
  if (!box) return;
  const items = [];
  if (q && q.lowest) items.push(['当前最低在售', money(q.lowest)]);
  if (q && q.median) items.push(['当前中位价', money(q.median)]);
  if (q && q.volume) items.push(['当前在售数量', `${q.volume} 件`]);

  // 优先用图表实际绘制的那批点（IDT.usedPts），没有则退回全量
  const pts = (IDT.usedPts && IDT.usedPts.length ? IDT.usedPts : h && h.points) || [];
  const prices = pts.map((p) => Number(p.price) || 0).filter((v) => v > 0);
  if (prices.length) {
    const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
    items.push(['最新成交中位价', money(prices[prices.length - 1])]);
    items.push(['区间均价', money(avg)]);
    items.push(['区间最高 / 最低', `${money(Math.max(...prices))} / ${money(Math.min(...prices))}`]);
    const vol = pts.reduce((s, p) => s + (Number(p.volume) || 0), 0);
    const days = IDT.range || 30;
    items.push([`近 ${days} 日成交量`, `${vol} 件`]);
  }

  box.innerHTML = items
    .map(([k, v]) => `<div class="idt-stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join('');
}

/** 绘制价格折线 + 成交量柱状图（纯 SVG，不引第三方库） */
/**
 * 单调三次插值（Fritsch–Carlson）。
 *
 * 为什么不用 Catmull-Rom：它会"过冲"——两个数据点之间冲出区间上限，
 * 画出来像一坨鼓包，配合放大后的坐标轴就很脏。
 * 单调插值保证曲线不会越过相邻点的取值范围，转折处自然收敛，视觉上更精细。
 */
function monotonePath(xs, ys) {
  const n = xs.length;
  if (!n) return '';
  if (n === 1) return `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;

  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    m[i] = dx[i] ? (ys[i + 1] - ys[i]) / dx[i] : 0;
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      t[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }

  let d = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const x1 = xs[i] + dx[i] / 3;
    const y1 = ys[i] + (t[i] * dx[i]) / 3;
    const x2 = xs[i + 1] - dx[i] / 3;
    const y2 = ys[i + 1] - (t[i + 1] * dx[i]) / 3;
    d += ` C${x1.toFixed(1)} ${y1.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)} ${xs[i + 1].toFixed(
      1
    )} ${ys[i + 1].toFixed(1)}`;
  }
  return d;
}

/**
 * 稀疏数据点的「波浪」曲线：Catmull-Rom → 三次贝塞尔。
 * monotonePath 是给几十个密集点防毛刺用的，转折偏"圆弧"；
 * 7 天这种只有几个点的区间，用它就会显得一边死平、一边突然拱起。
 * 这里用低张力的 Catmull-Rom：经过每个真实数据点，转折自然，
 * 上升/下降段带一点曲线感，平段仍保持平直（不伪造波动）。
 */
function wavePath(xs, ys, tension = 0.18) {
  const n = xs.length;
  if (!n) return '';
  if (n === 1) return `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  const at = (i) => ({
    x: xs[Math.max(0, Math.min(n - 1, i))],
    y: ys[Math.max(0, Math.min(n - 1, i))],
  });
  let d = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(
      1
    )} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Steam 官方成交价图（价格折线 + 成交量柱）。
 *
 * ★ 这里踩过一个坑：viewBox 固定 660×240 再用 preserveAspectRatio="none" ★
 * 容器实际宽度约 1200px，横向被强行拉 1.8 倍，坐标轴数字跟着变宽变形，
 * 看起来"数字很粗糙"。现在按容器的真实像素宽度算 viewBox，1:1 渲染，
 * 文字不再被拉伸。
 */
function renderIdtChart(history, days) {
  const all = history.points || [];
  if (!all.length) {
    IDT.usedPts = [];
    return;
  }

  const end = all[all.length - 1].t;
  const from = end - days * 86400000;
  let pts = all.filter((p) => p.t >= from);
  let usedFallback = false;
  // 有价无市的老物品：近 N 天可能一笔成交都没有。
  // 这时退到"最后一次成交前 90 天"，再退到最后一小段，避免整张图空白。
  if (pts.length < 2) {
    pts = all.filter((p) => p.t >= end - 90 * 86400000);
    usedFallback = true;
  }
  if (pts.length < 2) {
    pts = all.slice(-Math.max(2, Math.min(all.length, 14)));
    usedFallback = true;
  }
  if (!pts.length) {
    IDT.usedPts = [];
    return;
  }
  // 统计卡片和图表共用同一批点，避免"图上一个区间、卡片另一个区间"
  IDT.usedPts = pts;

  const fmtD = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };
  const sub = $('#idtChartSub');
  if (sub) {
    sub.textContent = usedFallback
      ? `该区间成交稀少，已显示最近有成交的记录：${fmtD(pts[0].t)} – ${fmtD(pts[pts.length - 1].t)}`
      : `Steam 官方市场成交中位价 · ${fmtD(pts[0].t)} – ${fmtD(pts[pts.length - 1].t)}`;
  }

  /* ------------------------------ 画布与边距 ------------------------------ */
  // 用容器真实宽度，保证 SVG 按 1:1 呈现（文字不被拉伸）
  const wrap = $('#idtChartWrap');
  const wrapW = wrap && wrap.clientWidth ? wrap.clientWidth : 760;
  const W = Math.max(420, Math.round(wrapW));
  const H = 262;
  const L = 64;
  const R = 56;
  const T = 16;
  const B = 34;
  const plotW = W - L - R;
  const plotH = H - T - B;

  // 上下两块：上面价格（占 66%），下面成交量（独立条带，不再和折线打架）
  const gap = 20;
  const priceH = Math.round(plotH * 0.66);
  const volTop = T + priceH + gap;
  const volH = Math.max(28, T + plotH - volTop);

  /**
   * 让曲线变顺的两步：
   *  1) 分桶降采样：一年 300+ 个日点铺在几百像素上每点不到 2px，必然长成毛刺。
   *     按等宽分桶取均价、成交量求和，点数压到 200 以内。
   *  2) 单调三次插值：段与段之间没有折角，也不会像 Catmull-Rom 那样冲出区间。
   * 成交量柱用同一批点，柱子和曲线才对得上位置。
   */
  function bucketize(list) {
    const target = Math.max(24, Math.min(220, Math.round(plotW / 3)));
    if (list.length <= target) return list.slice();
    const out = [];
    const step = (list.length - 1) / (target - 1);
    for (let i = 0; i < target; i++) {
      const a = Math.floor(i * step);
      const b = Math.max(a + 1, Math.floor((i + 1) * step));
      const seg = list.slice(a, b);
      if (!seg.length) continue;
      out.push({
        t: seg[Math.floor(seg.length / 2)].t,
        price: seg.reduce((s, p) => s + p.price, 0) / seg.length,
        volume: seg.reduce((s, p) => s + p.volume, 0),
      });
    }
    return out;
  }

  const draw = bucketize(pts);
  const prices = draw.map((p) => p.price);

  let pMin = Math.min(...prices);
  let pMax = Math.max(...prices);
  if (pMax - pMin < 0.02) {
    pMin = Math.max(0, pMin - 0.05);
    pMax = pMax + 0.05;
  }
  const padY = (pMax - pMin) * 0.14;
  pMin = Math.max(0, pMin - padY);
  pMax = pMax + padY;

  const volMax = Math.max(1, ...draw.map((p) => p.volume));

  // x 轴按真实时间铺开，而不是按点序号：成交有断档时不会把空档压扁
  const t0 = draw[0].t;
  const t1 = draw[draw.length - 1].t;
  const xAt = (t) => L + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
  const yP = (v) => T + (1 - (v - pMin) / (pMax - pMin)) * priceH;
  // 成交量用平方根刻度：单日峰值（比如 44 件）会把平时的 1~3 件压成看不见的小点，
  // 开方之后小柱子仍然看得见，峰值也还认得出，比线性刻度好读得多。
  const yV = (v) => volTop + volH - Math.sqrt(Math.max(0, v) / volMax) * volH;

  const xs = draw.map((p) => xAt(p.t));
  const ys = draw.map((p) => yP(p.price));
  // 点少（7 天/30 天这种）用低张力波浪曲线，转折自然不生硬；
  // 点密（一年以上）仍用单调插值，防止锯齿和过冲
  const linePath =
    draw.length <= 16
      ? wavePath(xs, ys, draw.length <= 6 ? 0.14 : 0.18)
      : monotonePath(xs, ys);
  const baseY = T + priceH;
  const areaPath = `${linePath} L${xs[xs.length - 1].toFixed(1)} ${baseY.toFixed(1)} L${xs[0].toFixed(
    1
  )} ${baseY.toFixed(1)} Z`;

  /* -------------------------------- 网格线与刻度 ------------------------------- */
  const gridCount = 4;
  const grid = [];
  for (let i = 0; i < gridCount; i++) {
    const f = i / (gridCount - 1);
    const y = T + priceH * f;
    const label = (pMax - (pMax - pMin) * f).toFixed(2);
    grid.push(
      `<line x1="${L}" y1="${y.toFixed(1)}" x2="${L + plotW}" y2="${y.toFixed(1)}"
        stroke="var(--line)" stroke-width="1" stroke-dasharray="${
          i === 0 || i === gridCount - 1 ? '0' : '2 4'
        }" opacity="${i === 0 || i === gridCount - 1 ? 0.9 : 0.55}"/>` +
        `<text x="${L - 10}" y="${(y + 3.4).toFixed(1)}" text-anchor="end" font-size="10.5"
          fill="var(--dim)" font-family="system-ui">¥${label}</text>`
    );
  }

  // 成交量刻度：只标 0 和峰值，避免右侧数字堆叠
  const volAxis =
    `<line x1="${L}" y1="${(volTop + volH).toFixed(1)}" x2="${L + plotW}" y2="${(
      volTop + volH
    ).toFixed(1)}" stroke="var(--line)" stroke-width="1" opacity="0.8"/>` +
    `<text x="${L + plotW + 10}" y="${(volTop + volH + 3.4).toFixed(1)}" font-size="10"
      fill="var(--dim)" font-family="system-ui">0</text>` +
    `<text x="${L + plotW + 10}" y="${(volTop + 7).toFixed(1)}" font-size="10"
      fill="var(--dim)" font-family="system-ui">${volMax}</text>`;

  /* --------------------------------- 成交量柱 -------------------------------- */
  const barW = Math.min(14, Math.max(1.5, (plotW / draw.length) * 0.5));
  const bars = draw
    .map((p, i) => {
      const y = yV(p.volume);
      const h = volTop + volH - y;
      if (h <= 0.4) return '';
      return `<rect x="${(xs[i] - barW / 2).toFixed(1)}" y="${y.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, barW / 2).toFixed(1)}"
        fill="rgba(120,168,214,.45)"><title>${fmtD(p.t)} · 成交 ${p.volume} 件</title></rect>`;
    })
    .join('');

  /* --------------------------------- x 轴标签 -------------------------------- */
  const spanDays = (t1 - t0) / 86400000;
  /**
   * 刻度按"时间"等分，而不是按点序号等分。
   * 分桶是按数组位置切的，最后几桶在时间上可能挤在一起，
   * 按序号取刻度会让末尾两个日期标签重叠成一团（实际出现过 2026/11/9 叠字）。
   */
  const maxTicks = Math.max(2, Math.min(5, Math.floor(plotW / 150) + 1));
  const idxs = [];
  for (let i = 0; i < maxTicks; i++) {
    const targetT = t0 + (t1 - t0) * (i / (maxTicks - 1));
    let best = 0;
    let bestDiff = Infinity;
    for (let j = 0; j < draw.length; j++) {
      const diff = Math.abs(draw[j].t - targetT);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = j;
      }
    }
    idxs.push(best);
  }
  const uniq = [...new Set(idxs)].sort((a, b) => a - b);
  const xLabels = uniq
    .map((i) => {
      const d = new Date(draw[i].t);
      const label =
        spanDays > 200
          ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
          : `${d.getMonth() + 1}/${d.getDate()}`;
      const anchor = i === 0 ? 'start' : i === draw.length - 1 ? 'end' : 'middle';
      return `<text x="${xs[i].toFixed(1)}" y="${H - 10}" text-anchor="${anchor}" font-size="10.5"
        fill="var(--dim)" font-family="system-ui">${label}</text>`;
    })
    .join('');

  /* ---------------------------------- 末点标记 -------------------------------- */
  const lastX = xs[xs.length - 1];
  const lastY = ys[ys.length - 1];
  const lastDot =
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="6" fill="#C7D94A" opacity=".18"/>` +
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.8" fill="#C7D94A"/>`;

  // 数据点少时给每个点一个标记，方便对照日期
  const dots =
    draw.length <= 24
      ? draw
          .map(
            (p, i) =>
              `<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2" fill="#0E1418"
                 stroke="#C7D94A" stroke-width="1.4"><title>${fmtD(p.t)} · ¥${p.price.toFixed(
                2
              )} · 成交 ${p.volume} 件</title></circle>`
          )
          .join('')
      : '';

  const uid = `idtg${Date.now()}`;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
      preserveAspectRatio="xMidYMid meet" font-family="system-ui">
    <defs>
      <linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#C7D94A" stop-opacity=".22"/>
        <stop offset="1" stop-color="#C7D94A" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid.join('')}
    ${volAxis}
    ${bars}
    <path d="${areaPath}" fill="url(#${uid})"/>
    <path d="${linePath}" fill="none" stroke="#C7D94A" stroke-width="6"
      stroke-linecap="round" stroke-linejoin="round" opacity=".10"/>
    <path d="${linePath}" fill="none" stroke="#C7D94A" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${lastDot}
    ${xLabels}
  </svg>`;

  // 切换区间时同步刷新统计卡片（图表和数字必须描述同一个区间）
  if (IDT.data) renderIdtStats(IDT.data.history, IDT.data.quote);
}

$('#invBody').addEventListener('click', (e) => {
  const d = e.target.closest('[data-detail]');
  if (!d) return;
  const row = S.invRows.find((r) => r.key === d.dataset.detail);
  if (row) openItemDetail(row);
});

if ($('#idtBack')) $('#idtBack').onclick = () => closeItemDetail();
if ($('#idtRanges')) {
  $('#idtRanges').addEventListener('click', (e) => {
    const t = e.target.closest('[data-range]');
    if (!t) return;
    IDT.range = Number(t.dataset.range) || 7;
    $$('#idtRanges .tab').forEach((b) => b.classList.toggle('on', b === t));
    if (IDT.data && IDT.data.history) renderIdtChart(IDT.data.history, IDT.range);
  });
}
if ($('#idtReload')) $('#idtReload').onclick = () => loadItemDetail();

/* ---------------------------- 物品详情：价格提醒 ---------------------------- */
if ($('#idtAlertDir')) {
  $('#idtAlertDir').addEventListener('click', (e) => {
    const t = e.target.closest('[data-adir]');
    if (!t) return;
    IDT.alertDir = t.dataset.adir === 'above' ? 'above' : 'below';
    $$('#idtAlertDir .tab').forEach((b) => b.classList.toggle('on', b === t));
    const hint = $('#idtAlertHint');
    if (hint) {
      hint.textContent =
        IDT.alertDir === 'above' ? '涨到目标价以上时通知你' : '跌到目标价以下时通知你';
    }
  });
}
if ($('#idtAlertSave')) {
  $('#idtAlertSave').onclick = async () => {
    const row = IDT.row;
    if (!row) return;
    const price = Number($('#idtAlertPrice').value);
    if (!(price > 0)) {
      toast('先填一个目标价', true);
      return;
    }
    const appId = row.appId || marketAppIdOf(row.sourceAppId, row.marketHashName);
    const r = await call(
      SD.alerts.save({
        appId,
        marketHashName: row.marketHashName,
        name: row.name,
        dir: IDT.alertDir,
        price,
      }),
      { silent: true }
    );
    if (!r.ok) {
      toast(r.message || '设置失败', true);
      return;
    }
    S.priceAlerts = (r.data && r.data.alerts) || [];
    renderIdtAlerts(row);
    const txt = `${IDT.alertDir === 'above' ? '涨到' : '跌到'} ${money(price)}`;
    toast(`已设置提醒：${txt} 时通知你`);
    log(`价格提醒：${row.name} ${IDT.alertDir === 'above' ? '≥' : '≤'} ${money(price)}`, 'b');
    const input = $('#idtAlertPrice');
    if (input) input.value = '';
  };
}
if ($('#idtAlertList')) {
  $('#idtAlertList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-alert-del]');
    if (!b) return;
    const r = await call(SD.alerts.remove(b.dataset.alertDel), { silent: true });
    if (r.ok) {
      S.priceAlerts = r.data || [];
      renderIdtAlerts(IDT.row);
      toast('提醒已删除');
    }
  });
}

/* --------------------------- 物品详情：成本与盈亏 --------------------------- */

/** 载入某个账号的成本记录（切换账号/汇总时不能混用） */
async function loadCosts(steamId) {
  const sid = String(steamId || '');
  if (!sid) {
    S.costs = {};
    S.costAcc = '';
    return;
  }
  if (S.costAcc === sid) return;
  const r = await call(SD.costs.list(sid), { silent: true, noLog: true });
  S.costs = r.ok ? r.data || {} : {};
  S.costAcc = sid;
}

function costOf(row) {
  if (!row || row.readonly || !row.marketHashName) return 0;
  const rec = (S.costs || {})[row.marketHashName];
  return rec ? Number(rec.cost) || 0 : 0;
}

/** 详情里的成本卡片：输入、盈亏、清除 */
function renderCostCard(row) {
  const card = $('#idtCostCard');
  if (!card) return;
  if (!row || row.readonly || !row.marketHashName) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  const cost = costOf(row);
  const qty = Number(row.qty) || 0;
  const low = Number(row.lowestPrice) || 0;
  const input = $('#idtCostPrice');
  if (input && document.activeElement !== input) input.value = cost > 0 ? cost.toFixed(2) : '';
  const hint = $('#idtCostHint');
  const rec = (S.costs || {})[row.marketHashName] || null;
  if (hint) {
    hint.textContent = cost > 0
      ? `已记录成本 ${money(cost)}/件${
          rec && Number(rec.buys) > 1 ? ` · ${rec.buys} 次买入的均价` : ''
        }`
      : '这件物品还没有记录成本';
  }

  const sum = $('#idtCostSummary');
  if (!sum) return;
  if (!(cost > 0)) {
    sum.innerHTML = '<div style="font-size:11.5px;color:var(--dim)">记录后这里会显示成本合计、当前市值与盈亏</div>';
    return;
  }
  const total = cost * qty;
  if (!(low > 0)) {
    sum.innerHTML = `<div class="idt-alert-item"><span>持有 ${qty} 件 · 成本合计 ${money(total)}</span><span>当前没有行情，暂时算不出盈亏</span></div>`;
    return;
  }
  const value = low * qty;
  const diff = value - total;
  const pct = total > 0 ? (diff / total) * 100 : 0;
  const cls = diff >= 0 ? 'g' : 'r';
  sum.innerHTML = `<div class="idt-alert-item">
    <span>持有 <b>${qty}</b> 件 · 成本合计 <b>${money(total)}</b></span>
    <span>当前市值 <b>${money(value)}</b></span>
    <span class="sp"></span>
    <span class="wp ${cls}" style="font-weight:600">${diff >= 0 ? '浮盈 +' : '浮亏 -'}${money(Math.abs(diff))}（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）</span>
  </div>`;
}

if ($('#idtCostSave')) {
  $('#idtCostSave').onclick = async () => {
    const row = IDT.row;
    if (!row) return;
    const price = Number($('#idtCostPrice').value);
    if (!(price > 0)) {
      toast('先填每件的成本价', true);
      return;
    }
    const sid = S.costAcc || S.currentSteamId;
    const r = await call(SD.costs.set(sid, row.marketHashName, price), { silent: true });
    if (!r.ok) {
      toast(r.message || '保存失败', true);
      return;
    }
    S.costs = (r.data && r.data.costs) || {};
    renderCostCard(row);
    renderInventory();
    toast(`已记录成本 ${money(price)}/件`);
    log(`记录成本：${row.name} ${money(price)}/件`, 'b');
  };
}
if ($('#idtPolicySave')) {
  $('#idtPolicySave').onclick = async () => {
    const row = IDT.row;
    if (!row || !row.marketHashName) return;
    const auto = $('#idtPolicyAuto') ? $('#idtPolicyAuto').checked : true;
    const minPrice = Math.max(0, Number($('#idtPolicyMin') && $('#idtPolicyMin').value) || 0);
    const map = { ...((S.settings && S.settings.itemPolicies) || {}) };
    if (auto !== false && !(minPrice > 0)) delete map[row.marketHashName];
    else map[row.marketHashName] = { auto: auto !== false, minPrice };
    const r = await call(SD.settings.set({ itemPolicies: map }), { silent: true });
    if (!r.ok) {
      toast(r.message || '保存失败', true);
      return;
    }
    S.settings = r.data;
    if ($('#idtPolicyHint')) {
      $('#idtPolicyHint').textContent =
        auto === false
          ? '这件物品已关闭自动改价'
          : minPrice > 0
          ? `自动改价不低于 ${money(minPrice)}`
          : '留空表示不限制';
    }
    toast(auto === false ? '已关闭这件物品的自动改价' : minPrice > 0 ? `自动改价不低于 ${money(minPrice)}` : '已清除物品策略');
    log(`物品策略：${row.name} ${auto === false ? '关闭自动改价' : minPrice > 0 ? '最低自动价 ' + money(minPrice) : '默认'}`, 'b');
  };
}
if ($('#idtCostClear')) {
  $('#idtCostClear').onclick = async () => {
    const row = IDT.row;
    if (!row) return;
    const sid = S.costAcc || S.currentSteamId;
    const r = await call(SD.costs.remove(sid, row.marketHashName), { silent: true });
    if (!r.ok) {
      toast(r.message || '清除失败', true);
      return;
    }
    S.costs = (r.data && r.data.costs) || {};
    const input = $('#idtCostPrice');
    if (input) input.value = '';
    renderCostCard(row);
    renderInventory();
    toast('成本记录已清除');
  };
}

/* ----------------------------- 成本管理弹窗 ----------------------------- */

/** 成本管理当前操作的账号：库存页选中的账号优先 */
function costSid() {
  const picked = $('#invAcc') ? String($('#invAcc').value || '') : '';
  // 汇总模式没有"一个账号"可以记成本，回落到当前登录号
  if (picked && picked !== '__all__') return picked;
  return String(S.currentSteamId || '');
}

function costLog(text, tone) {
  const box = $('#costLog');
  if (!box) return;
  const line = document.createElement('div');
  line.className = tone || '';
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

async function costRefreshMeta() {
  const sid = costSid();
  const meta = $('#costMeta');
  const pill = $('#costPill');
  if (!sid) {
    if (meta) meta.textContent = '先在库存页选择一个账号';
    if (pill) pill.textContent = '';
    return;
  }
  const r = await call(SD.costs.list(sid), { silent: true, noLog: true });
  const costs = r.ok ? r.data || {} : {};
  S.costs = costs;
  S.costAcc = sid;
  const n = Object.keys(costs).length;
  if (pill) pill.textContent = n ? `${n} 种` : '未记录';
  if (meta) {
    const acc = (S.accounts || []).find((a) => String(a.steamId) === String(sid));
    const name = acc ? acc.personaName || acc.accountName || sid : sid;
    meta.textContent = `当前账号：${name} · 已记录 ${n} 种物品的每件成本`;
  }
}

function costApplyResult(sid, costs) {
  if (!costs) return;
  S.costs = costs;
  S.costAcc = sid;
  if ($('#invAcc') && String($('#invAcc').value) === String(sid)) renderInventory();
  const ov = $('.pg[data-p="overview"]');
  if (ov && ov.classList.contains('on')) renderCostOverview(true);
}

async function costFillFromHistory() {
  const sid = costSid();
  if (!sid) {
    toast('先选一个账号', true);
    return;
  }
  const btn = $('#costFill');
  const overwrite = !!($('#costOverwrite') && $('#costOverwrite').checked);
  if (btn) btn.disabled = true;
  costLog('正在读取 Steam 买入记录…');
  const r = await call(SD.market.myHistory(false), { silent: true });
  if (btn) btn.disabled = false;
  if (!r.ok) {
    costLog(netText(r.message) || '读取买入记录失败', 'bad');
    return;
  }
  const d = r.data || {};
  if (d.steamId && String(d.steamId) !== String(sid)) {
    costLog(
      `成交历史属于当前网页登录的账号（尾号 ${String(d.steamId).slice(-6)}），和所选账号不是同一个。` +
        '请先在账号管理里给这个号做一次网页登录，再回来回填。',
      'bad'
    );
    return;
  }
  const buys = (d.items || []).filter(
    (x) => x.kind === 'buy' && x.marketHashName && Number(x.priceCents) > 0
  );
  if (!buys.length) {
    costLog('这个账号没有找到买入记录，没法自动回填。可以手动填或导入 CSV。', 'bad');
    return;
  }
  // 历史里可能混着不同钱包币种，只取最近一笔买入的币种，避免把 ₪ 当 ¥
  const currency = Number(buys[0].currency) || 0;
  const use = buys.filter((x) => (Number(x.currency) || 0) === currency);
  const agg = new Map();
  for (const b of use) {
    const cur = agg.get(b.marketHashName) || { sum: 0, n: 0, last: 0 };
    cur.sum += Number(b.priceCents) || 0;
    cur.n += 1;
    cur.last = Math.max(cur.last, (Number(b.time) || 0) * 1000);
    agg.set(b.marketHashName, cur);
  }
  const map = {};
  for (const [hash, v] of agg) {
    map[hash] = {
      cost: Math.round(v.sum / v.n) / 100,
      buys: v.n,
      lastBuyAt: v.last || Date.now(),
    };
  }

  costLog(`找到 ${use.length} 条买入记录，共 ${agg.size} 种物品，正在写入…`);
  const w = await call(SD.costs.bulkSet(sid, map, overwrite), { silent: true });
  if (!w.ok) {
    costLog(w.message || '写入失败', 'bad');
    return;
  }
  const res = w.data || {};
  costApplyResult(sid, res.costs);
  await costRefreshMeta();
  const sym = MH_CUR_SYM[currency] || '';
  costLog(
    `完成：新增 ${res.added || 0} 种，覆盖 ${res.updated || 0} 种${
      res.skipped ? `，跳过已有的 ${res.skipped} 种` : ''
    }（按 ${sym || '当前'} 币种记录）`,
    'ok'
  );
  if (buys.length > use.length) costLog(`另有 ${buys.length - use.length} 条其它币种的买入记录未参与计算`);
  log(`成本回填：新增 ${res.added || 0} 种，覆盖 ${res.updated || 0} 种`, 'g');
}

async function costImport() {
  const sid = costSid();
  if (!sid) {
    toast('先选一个账号', true);
    return;
  }
  const overwrite = !!($('#costOverwrite') && $('#costOverwrite').checked);
  const r = await call(SD.costs.importCsv(sid, overwrite), { silent: true });
  if (!r.ok) {
    costLog(r.message || '导入失败', 'bad');
    return;
  }
  if (r.data && r.data.canceled) return;
  const d = r.data || {};
  costApplyResult(sid, d.costs);
  await costRefreshMeta();
  costLog(
    `已导入 ${d.rows || 0} 行（${d.file || 'CSV'}）：新增 ${d.added || 0} 种，覆盖 ${d.updated || 0} 种${
      d.skipped ? `，跳过已有 ${d.skipped} 种` : ''
    }`,
    'ok'
  );
}

async function costExport() {
  const sid = costSid();
  if (!sid) {
    toast('先选一个账号', true);
    return;
  }
  const r = await call(SD.costs.exportCsv(sid), { silent: true });
  if (!r.ok) {
    costLog(r.message || '导出失败', 'bad');
    return;
  }
  if (r.data && r.data.canceled) return;
  costLog(`已导出 ${r.data.rows || 0} 种物品的成本`, 'ok');
  toast('成本 CSV 已保存');
}

async function costClearAll() {
  const sid = costSid();
  if (!sid) return;
  const n = Object.keys(S.costs || {}).length;
  if (!n) {
    toast('这个账号还没有成本记录');
    return;
  }
  const ok = await askConfirm({
    title: '清空这个账号的成本记录？',
    sub: `将删除 ${n} 种物品的成本价，盈亏标签和持仓总览会一起清空。`,
    tone: 'danger',
    okText: '清空',
    notes: ['只影响当前账号，其它账号的成本记录不受影响。'],
  });
  if (!ok) return;
  const r = await call(SD.costs.clear(sid), { silent: true });
  if (!r.ok) {
    costLog(r.message || '清空失败', 'bad');
    return;
  }
  costApplyResult(sid, {});
  await costRefreshMeta();
  costLog(`已清空 ${r.data && r.data.removed ? r.data.removed : n} 种物品的成本`, 'ok');
}

function costOpen() {
  const m = $('#costModal');
  if (!m) return;
  const box = $('#costLog');
  if (box) box.innerHTML = '';
  m.classList.add('on');
  costRefreshMeta();
}

function costClose() {
  const m = $('#costModal');
  if (m) m.classList.remove('on');
}

if ($('#invCostBtn')) $('#invCostBtn').onclick = () => costOpen();
if ($('#costClose')) $('#costClose').onclick = () => costClose();
if ($('#costClose2')) $('#costClose2').onclick = () => costClose();
if ($('#costFill')) $('#costFill').onclick = () => costFillFromHistory();
if ($('#costImport')) $('#costImport').onclick = () => costImport();
if ($('#costExport')) $('#costExport').onclick = () => costExport();
if ($('#costClear')) $('#costClear').onclick = () => costClearAll();
if ($('#costModal')) {
  $('#costModal').addEventListener('click', (e) => {
    if (e.target === $('#costModal')) costClose();
  });
}

/* --------------------------- 概览页：持仓盈亏 --------------------------- */

let costOvBusy = false;
let costOvAt = 0;
let costOvSid = '';

/** 今日待办：把散在各页的异常和提醒汇总成一张清单 */
async function renderTodo() {
  const box = $('#ovTodoList');
  if (!box) return;
  const [autoR, healthR, ladderR, restockR, guardR] = await Promise.all([
    call(SD.automation.get(), { silent: true, noLog: true }),
    call(SD.health.state(), { silent: true, noLog: true }),
    call(SD.ladder.state(), { silent: true, noLog: true }),
    call(SD.restock.state(), { silent: true, noLog: true }),
    call(SD.priceGuard.state(), { silent: true, noLog: true }),
  ]);
  const auto = (autoR.ok && autoR.data) || {};
  const health = (healthR.ok && healthR.data) || {};
  const ladder = (ladderR.ok && ladderR.data) || {};
  const restock = (restockR.ok && restockR.data) || {};
  const guard = (guardR.ok && guardR.data) || {};
  const items = [];

  if (auto.paused) items.push({ tone: 'warn', text: '自动化已暂停（维护模式），手动操作完成后记得恢复' });

  if (health.lastAt && Number(health.restricted) > 0) {
    items.push({ tone: 'bad', text: `${health.restricted} 个账号被限制使用社区市场，挂单会全部失败` });
  }
  if (health.lastAt && Number(health.total) > 0 && Number(health.ok) < Number(health.total)) {
    const miss = Number(health.total) - Number(health.ok);
    items.push({
      tone: 'bad',
      text: `${miss} 个账号网页会话不可用（${health.ok}/${health.total} 可用）`,
    });
  }
  if (!health.lastAt) items.push({ tone: 'dim', text: '还没做过账号体检，建议先跑一次' });

  const nowSec = Math.floor(Date.now() / 1000);
  const ages = Object.values((S.listings && S.listings.map) || {})
    .filter((e) => e && Number(e.createdAt))
    .map((e) => Math.max(0, (nowSec - Number(e.createdAt)) / 86400));
  const stale30 = ages.filter((a) => a >= 30).length;
  if (stale30) {
    items.push({ tone: 'warn', text: `${stale30} 件挂单超过 30 天没卖掉，可考虑阶梯降价或手动调价` });
  } else if (!S.listings) {
    items.push({ tone: 'dim', text: '挂单还没同步，暂时无法判断滞销' });
  }

  // 没开启的自动化不报错：残留的上次失败结果只会变成吓人的红条
  if (ladder.enabled && ladder.lastResult && ladder.lastResult.error) {
    items.push({ tone: 'bad', text: `阶梯降价：${ladder.lastResult.error}` });
  }
  if (restock.enabled && restock.lastResult && restock.lastResult.error) {
    items.push({ tone: 'bad', text: `自动补货：${restock.lastResult.error}` });
  }
  if (!ladder.enabled) {
    items.push({ tone: 'dim', text: '阶梯降价未开启，滞销物品不会自动降价' });
  }
  if (guard.enabled && guard.lastResult && guard.lastResult.error) {
    items.push({ tone: 'bad', text: `自动守价：${guard.lastResult.error}` });
  } else if (guard.enabled && guard.lastResult && Number(guard.lastResult.underpriced) > 0) {
    const n = Number(guard.lastResult.underpriced);
    const done = Number(guard.lastResult.listed) || 0;
    items.push({
      tone: done ? 'dim' : 'warn',
      text: done ? `自动守价已跟价 ${done} 件（共 ${n} 件被压价）` : `${n} 件挂单被压价，还没处理（自动守价未改价）`,
    });
  } else if (!guard.enabled) {
    items.push({ tone: 'dim', text: '自动守价未开启，被压价时不会提醒也不会跟价' });
  }

  // 每日到手目标：读本地归档，不联网
  const goal = Number(S.settings && S.settings.dailyGoalYuan) || 0;
  if (goal > 0 && S.currentSteamId) {
    const tR = await call(SD.archive.today(S.currentSteamId), { silent: true, noLog: true });
    const rec = (tR.ok && tR.data && Number(tR.data.received)) || 0;
    const pct = Math.round((rec / goal) * 100);
    items.push({
      tone: pct >= 100 ? 'dim' : 'warn',
      text: `今日到手 ${money(rec)} / 目标 ${money(goal)}（${pct}%）`,
    });
  }

  if (!items.length) {
    box.innerHTML = '<div class="watch-empty">今天没有需要处理的事</div>';
    return;
  }
  box.innerHTML = items
    .map((x) => `<div class="todo-item ${x.tone}"><i></i><span>${esc(x.text)}</span></div>`)
    .join('');
}

if ($('#ovTodoRefresh')) $('#ovTodoRefresh').onclick = () => renderTodo();

/* ------------------------------ 后台任务面板 ------------------------------ */

function shortTime(at) {
  const t = Number(at) || 0;
  if (!t) return '未运行';
  const d = new Date(t);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function taskText(kind, d) {
  const r = (d && d.lastResult) || {};
  if (r.error) return r.error;
  if (kind === 'restock') {
    if (r.listed) return `补货 ${r.listed} 件（新成交 ${r.sales || 0}）`;
    if (r.reason) return r.reason;
    if (r.sales === 0) return '没有新成交';
    if (r.baseline) return '刚建立基线，等待新成交';
    return '等待卖出';
  }
  if (kind === 'ladder') {
    if (r.listed) return `降价 ${r.listed} 件（评估 ${r.checked || 0} 件）`;
    if (r.reason) return r.reason;
    if (r.checked !== undefined) return `评估 ${r.checked} 件，没有到期的`;
    return '等待检查';
  }
  if (kind === 'guard') {
    const tail = d.notifyOnly ? '（只通知）' : '';
    if (r.listed) return `跟价 ${r.listed} 件${tail}`;
    if (r.underpriced) return `${r.underpriced} 件被压价${tail}`;
    if (r.reason) return r.reason;
    if (r.checked !== undefined) return `检查 ${r.checked} 件，价格都正常`;
    return '等待检查';
  }
  return '';
}

async function renderTasks() {
  const box = $('#ovTasksList');
  if (!box) return;
  const [restockR, ladderR, guardR] = await Promise.all([
    call(SD.restock.state(), { silent: true, noLog: true }),
    call(SD.ladder.state(), { silent: true, noLog: true }),
    call(SD.priceGuard.state(), { silent: true, noLog: true }),
  ]);
  const restock = (restockR.ok && restockR.data) || {};
  const ladder = (ladderR.ok && ladderR.data) || {};
  const guard = (guardR.ok && guardR.data) || {};
  const rows = [
    ['自动补货', !!restock.enabled, taskText('restock', restock), restock.lastAt],
    ['阶梯降价', !!ladder.enabled, taskText('ladder', ladder), ladder.lastAt],
    ['自动守价', !!guard.enabled, taskText('guard', guard), guard.lastAt],
  ];
  box.innerHTML = rows
    .map(([name, on, text, at]) => {
      const err = on && /error|失败|超时|受限/i.test(String(text || ''));
      return (
        `<div class="task-row"><i class="td ${err ? 'err' : on ? 'on' : ''}"></i>` +
        `<span class="tn">${esc(name)}</span><span class="ts" title="${esc(text)}">${
          on ? esc(text || '等待检查') : '未开启'
        }</span><span class="tm">${on ? esc(shortTime(at)) : ''}</span></div>`
      );
    })
    .join('');
}

if ($('#ovTasksRefresh')) $('#ovTasksRefresh').onclick = () => renderTasks();

async function renderCostOverview(force) {
  const card = $('#ovCostCard');
  if (!card) return;
  const sid = String(S.currentSteamId || '');
  const pill = $('#ovCostPill');
  const foot = $('#ovCostFoot');
  const sub = $('#ovCostSub');
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('g', cls === 'g');
    el.classList.toggle('r', cls === 'r');
  };

  if (!sid) {
    if (pill) pill.textContent = '—';
    if (foot) foot.textContent = '还没有当前登录的 Steam 账号';
    return;
  }
  if (costOvBusy) return;
  // 3 分钟内复用上次结果：这个计算会读库存 + 查价，不必每次切页都重来
  if (!force && costOvSid === sid && Date.now() - costOvAt < 3 * 60 * 1000) return;

  costOvBusy = true;
  if (pill) pill.textContent = '计算中';
  if (foot) foot.textContent = '正在读取库存数量并查询有成本记录物品的行情…';
  const r = await call(SD.costs.overview(sid), { silent: true, noLog: true });
  costOvBusy = false;
  if (!r.ok) {
    if (pill) pill.textContent = '失败';
    if (foot) foot.textContent = r.message || '计算失败';
    return;
  }
  const d = r.data || {};
  costOvSid = sid;
  costOvAt = Date.now();

  if (d.empty) {
    set('#ovCostTotal', money(0));
    set('#ovCostValue', money(0));
    set('#ovCostProfit', money(0));
    set('#ovCostBelow', '0 种');
    if (pill) pill.textContent = '未记录';
    if (foot) foot.textContent = '还没有记录成本：到「饰品仓库 → 成本管理」从买入记录回填，或导入 CSV。';
    return;
  }

  set('#ovCostTotal', money(d.cost));
  const hasQuote = (d.quoted || 0) > 0;
  const profit = Number(d.profit) || 0;
  const pct = d.cost > 0 ? (profit / d.cost) * 100 : 0;
  if (hasQuote) {
    set('#ovCostValue', money(d.value));
    set('#ovCostProfit', `${profit >= 0 ? '+' : '-'}${money(Math.abs(profit))}`, profit >= 0 ? 'g' : 'r');
  } else {
    // 一件都没查到行情时，市值 0 会显示成"亏了 100%"，容易吓人
    set('#ovCostValue', '—');
    set('#ovCostProfit', '—');
  }
  set('#ovCostBelow', `${d.below || 0} 种`, d.below ? 'r' : '');
  if (pill) pill.textContent = `${d.held || 0} 种在库`;

  const parts = [`持有 ${d.held || 0} 种 / ${d.units || 0} 件`, `已记录成本 ${d.tracked || 0} 种`];
  if (d.unknown) parts.push(`${d.unknown} 种没有行情，未计入市值`);
  if (d.busy) parts.push('有查价任务在跑，结果可能不全');
  if (hasQuote) parts.push(`盈亏率 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
  else parts.push('暂时查不到行情，无法计算市值');
  if (foot) foot.textContent = parts.join(' · ');
  if (sub) {
    sub.textContent =
      d.source === 'snapshot'
        ? '数量来自库存监控快照 · 行情实时查询'
        : '数量实时读取 · 行情实时查询';
  }
}

if ($('#ovCostRun')) $('#ovCostRun').onclick = () => renderCostOverview(true);

// 图表按容器真实宽度绘制，窗口尺寸变了要重画，否则会留白或被拉伸
let idtResizeTimer = null;
window.addEventListener('resize', () => {
  if (!IDT.data || !IDT.data.history) return;
  clearTimeout(idtResizeTimer);
  idtResizeTimer = setTimeout(() => {
    const box = $('#itemDetail');
    if (box && box.classList.contains('on')) renderIdtChart(IDT.data.history, IDT.range);
  }, 180);
});
if ($('#idtSellPrice')) {
  $('#idtSellPrice').addEventListener('input', updateIdtNet);
  $('#idtSellPrice').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#idtSellBtn').click(); }
  });
}
if ($('#idtBuffPrice')) {
  $('#idtBuffPrice').addEventListener('input', updateBuffCompare);
  $('#idtBuffPrice').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buffSave(); }
  });
}
if ($('#idtBuffFee')) $('#idtBuffFee').addEventListener('input', updateBuffCompare);
if ($('#idtBuffSave')) $('#idtBuffSave').onclick = () => buffSave();
if ($('#idtSellBtn')) {
  $('#idtSellBtn').onclick = async () => {
    const row = IDT.row;
    if (!row) return;
    const v = Number($('#idtSellPrice').value) || 0;
    if (!(v > 0)) { toast('请先填写挂单价格', true); return; }
    row.priceYuan = v;
    await executeSell([row], { single: false });
    if (row.qty <= 0) closeItemDetail();
    else { renderInventory(); updateSelSummary(); }
  };
}

/**
 * 按策略填价。
 * @param {Array} targets 要填的组（不再隐式作用于 S.invRows 全集）
 * @param {boolean} force true = 覆盖已有价格；false = 只填还空着的
 * @returns {number} 实际填了几种
 *
 * 老版本把目标集合写在调用点、填充集合写死成 S.invRows，
 * 于是"只对勾选的填充"在 force 路径上会连未勾选的一起覆盖。
 */
/**
 * 自动定价尾数：往下取到 .99 / .98 / 整数，避免一眼看出是脚本。
 * 只对 1 元以上生效，低价物品（几分钱到几毛）保持原样。
 */
function applyPriceEnding(price) {
  const mode = (S.settings && S.settings.priceEnding) || 'none';
  const p = Number(price) || 0;
  const whole = Math.floor(p);
  if (mode === 'none' || whole < 1) return Math.round(p * 100) / 100;
  let out = p;
  if (mode === 'int') out = whole;
  else if (mode === '99') out = whole - 0.01;
  else if (mode === '98') out = whole - 0.02;
  return Math.max(0.03, Math.round(out * 100) / 100);
}

function autoFillPrices(targets, force) {
  const strat = $('#invStrat').value || 'low-1';
  if (strat === 'manual') return 0;

  let n = 0;
  for (const r of targets || []) {
    if (!force && r.priceYuan > 0) continue;
    const low = r.lowestPrice;
    const med = r.medianPrice;
    let p = 0;
    if (strat === 'low-1' && low > 0) p = Math.max(0.03, Math.round((low - 0.01) * 100) / 100);
    else if (strat === 'low-0' && low > 0) p = Math.max(0.03, Math.round(low * 100) / 100);
    else if (strat === 'low-97' && low > 0) p = Math.max(0.03, Math.round(low * 0.97 * 100) / 100);
    else if (strat === 'low-95' && low > 0) p = Math.max(0.03, Math.round(low * 0.95 * 100) / 100);
    else if (strat === 'med-0' && med > 0) p = Math.max(0.03, Math.round(med * 100) / 100);
    else if (strat === 'med-102' && med > 0) p = Math.max(0.03, Math.round(med * 1.02 * 100) / 100);
    else if (strat === 'med-105' && med > 0) p = Math.max(0.03, Math.round(med * 1.05 * 100) / 100);
    if (p > 0) {
      r.priceYuan = applyPriceEnding(p);
      n += 1;
    }
  }
  return n;
}

$('#invApply').onclick = () => {
  if (($('#invStrat').value || 'low-1') === 'manual') {
    toast('手动模式不会自动填价');
    return;
  }
  // 有勾选就只作用于勾选的组；没有勾选才作用于全部
  const targets = S.selected.size ? pickedRows() : S.invRows;
  const n = autoFillPrices(targets, true);
  renderInventory();
  toast(n ? `已按策略填充 ${n} 种物品` : '这些物品没有行情，填不了价（可手动填）');
};

/* Steam 卡牌与掉落物一键清仓 */
if ($('#invQuickCards')) {
  $('#invQuickCards').onclick = async () => {
    if (S.invAll) {
      toast('汇总视图不能批量上架，请先在账号下拉里选单个账号', true);
      return;
    }
    const appSel = $('#invApp');
    if (appSel && appSel.value !== '753') {
      appSel.value = '753';
      toast('正在切换至 Steam 社区物品 (753) 并拉取库存…');
      await loadInventory(753);
    } else if (!S.invRows.length) {
      await loadInventory(753);
    }

    // 用统一的品类识别：卡牌 / 背景 / 表情 / 宝珠
    const quickCats = new Set(['card', 'bg', 'emoji', 'gem']);
    const cardRows = S.invRows.filter(
      (r) => r.sellableQty > 0 && quickCats.has(r.__cat || (r.__cat = detectCategory(r)))
    );

    if (!cardRows.length) {
      toast('当前库存中没有发现可出售的集换式卡牌或掉落物', true);
      return;
    }

    toast(`已筛选出 ${cardRows.length} 种可售卡牌/掉落物，正在查询最新行情…`);
    await quoteAll();

    $('#invStrat').value = 'low-1';
    autoFillPrices(cardRows, true);

    S.selected.clear();
    for (const r of cardRows) {
      if (r.priceYuan > 0) S.selected.add(r.key);
    }

    renderInventory();
    updateSelSummary();

    const totalCards = cardRows.reduce((s, r) => s + r.sellableQty, 0);
    const estGross = cardRows.reduce((s, r) => s + (r.priceYuan || 0) * r.sellableQty, 0);
    toast(`已选出 ${totalCards} 张卡牌/掉落物，总估值 ¥${estGross.toFixed(2)}，点击【批量上架】即可一键清仓！`);
  };
}

/* --------------------------------- 仓库渲染 -------------------------------- */

/* 图标单元：真实图片铺满，加载失败退回字母块。
   图标走本地 sdimg:// 代理，主进程负责多域名回退，渲染层不用关心 CDN。 */
function iconHtml(iconUrl, name, cls) {
  const letter = esc(initial(name));
  if (!iconUrl) return `<div class="${cls}">${letter}</div>`;
  return `<span class="${cls}" style="position:relative;overflow:hidden;padding:0">
      <img src="${esc(iconUrl)}" alt="" loading="lazy" decoding="async"
           style="width:100%;height:100%;object-fit:contain"
           onload="this.parentElement.classList.add('hasimg')" onerror="this.remove()" />
      <b class="cvfb">${letter}</b>
    </span>`;
}

function filterLabel(f) {
  return { all: '全部', sellable: '可上架', blocked: '不可上架', priced: '已定价', unpriced: '未定价' }[f] || f;
}

/**
 * 物品品类识别：卡牌 / 背景 / 表情 / 宝珠 / 武器箱 / 皮肤 / 其它。
 * 依据 Steam 返回的 type 与 name 关键字，中英文都覆盖。
 * 注意 name 里已经带了 "游戏名 - :表情:" 这类真实名称，所以关键字只做包含判断。
 */
const CATEGORY_META = {
  card: { label: '卡牌', icon: '卡', cls: 'badge-card' },
  bg: { label: '背景', icon: '背', cls: 'badge-bg' },
  emoji: { label: '表情', icon: '表', cls: 'badge-emoji' },
  gem: { label: '宝珠', icon: '珠', cls: 'badge-gem' },
  box: { label: '箱子', icon: '箱', cls: 'badge-box' },
  skin: { label: '皮肤', icon: '肤', cls: 'badge-skin' },
  other: { label: '道具', icon: '物', cls: 'badge-other' },
};

function detectCategory(r) {
  const type = String((r && r.type) || '').toLowerCase();
  const name = String((r && r.name) || '').toLowerCase();
  const hash = String((r && r.marketHashName) || '').toLowerCase();
  const hay = `${type} ${name} ${hash}`;

  // 顺序很重要：背景/表情的名称里也可能带 "card"，所以先判具体品类
  if (/背景|profile background|background/.test(hay)) return 'bg';
  if (/表情|emoticon|:emoji|^:.*:$/.test(hay)) return 'emoji';
  if (/宝珠|gem|sack of gems/.test(hay)) return 'gem';
  if (/卡牌|trading card|^card$|foil card|集换式/.test(hay)) return 'card';
  if (/武器箱|weapon case|case$|箱子|container|capsule|胶囊|收藏品/.test(hay)) return 'box';
  if (/皮肤|skin|stattrak|纪念品|souvenir|刀|knife|gloves|手套/.test(hay)) return 'skin';
  return 'other';
}

/** 品类徽章 HTML（真正显示在物品名前面） */
function categoryBadgeHtml(r) {
  const key = r.__cat || (r.__cat = detectCategory(r));
  const m = CATEGORY_META[key] || CATEGORY_META.other;
  return `<span class="item-badge ${m.cls}" title="品类：${m.label}">${m.icon} ${m.label}</span>`;
}

/** 当前视图要显示的组：先筛选，再排序。返回新数组，不动 S.invRows 的顺序。 */
function viewRows() {
  const v = S.invView;
  const q = v.q.trim().toLowerCase();

  const list = S.invRows.filter((r) => {
    if (q) {
      const hay = `${r.name || ''} ${r.type || ''} ${r.marketHashName || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (v.cat && v.cat !== 'all') {
      if ((r.__cat || (r.__cat = detectCategory(r))) !== v.cat) return false;
    }
    if (v.filter === 'sellable') return r.sellableQty > 0;
    if (v.filter === 'blocked') return r.sellableQty === 0;
    if (v.filter === 'priced') return r.priceYuan > 0;
    if (v.filter === 'unpriced') return r.priceYuan <= 0 && r.sellableQty > 0;
    return true;
  });

  // "市值/单价"优先用已填的挂单价，没填就用市场最低价 —— 否则刚拉完库存排序全是 0
  const unit = (r) => (r.priceYuan > 0 ? r.priceYuan : r.lowestPrice || 0);
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');

  list.sort((a, b) => {
    if (v.sort === 'value') return unit(b) * b.qty - unit(a) * a.qty || byName(a, b);
    if (v.sort === 'price') return unit(b) - unit(a) || byName(a, b);
    if (v.sort === 'name') return byName(a, b);
    return b.qty - a.qty || byName(a, b);
  });
  return list;
}

function updateInvCount(shown, total) {
  const el = $('#invCount');
  if (!el) return;
  const all = S.invRows.length;
  // 没数据时不显示这个计数标签，避免空页面上挂一个像按钮的「—」
  if (!all) { el.textContent = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  const pieces = S.invRows.reduce((s, r) => s + r.qty, 0);
  el.textContent = total === all
    ? `${all} 种 · ${pieces} 件`
    : `${shown} / ${total} 种 · 共 ${all} 种 ${pieces} 件`;
}

function renderInventory() {
  const box = $('#invBody');
  if (!S.invRows.length) {
    box.innerHTML = `<div class="empty"><b>还没有库存数据</b>
      选择一个账号与游戏，点右上角「重新拉取」。<br>首次拉取需要该账号已保存市场 Cookie。</div>`;
    updateSelSummary();
    updateInvCount(0, 0);
    return;
  }

  const list = viewRows();

  if (!list.length) {
    box.innerHTML = `<div class="empty"><b>没有符合条件的物品</b>
      当前筛选「${esc(filterLabel(S.invView.filter))}」${
        S.invView.q ? ` · 搜索「${esc(S.invView.q)}」` : ''
      }<br>共 ${S.invRows.length} 种物品，换个条件试试。
      <div style="margin-top:9px"><button class="btn s" id="invClearFilter">清除筛选</button></div></div>`;
    const c = $('#invClearFilter');
    if (c) {
      c.onclick = () => {
        S.invView.q = '';
        S.invView.filter = 'all';
        S.invView.limit = INV_PAGE;
        if ($('#invSearch')) $('#invSearch').value = '';
        syncInvFilterTabs();
        renderInventory();
      };
    }
    updateSelSummary();
    updateInvCount(0, 0);
    return;
  }

  const shown = list.slice(0, S.invView.limit);
  box.innerHTML =
    shown.map(groupRowHtml).join('') +
    (list.length > shown.length
      ? `<div class="more"><button class="btn s" id="invMore">显示更多（还有 ${list.length - shown.length} 种）</button></div>`
      : '');

  const more = $('#invMore');
  if (more) more.onclick = () => { S.invView.limit += INV_PAGE; renderInventory(); };

  updateSelSummary();
  updateInvCount(shown.length, list.length);
}

function groupRowHtml(r) {
  const sellable = r.sellableQty > 0;
  const checked = S.selected.has(r.key);
  const expanded = S.invExpanded.has(r.key);
  const net = netOf(r.priceYuan);
  const lowTxt = r.lowestPrice > 0 ? money(r.lowestPrice) : r.noData ? '无行情' : '—';
  // 求购价 = 最高求购单（想马上卖掉时的成交价）；没读过是 —，读过但没有求购单是"无求购"
  const buyTxt = !r.buyOk ? '—' : r.buyPrice > 0 ? money(r.buyPrice) : '无求购';
  const subtotal = r.priceYuan > 0 ? r.priceYuan * r.sellableQty : 0;

  // 有成本记录时在名字后面标一个盈亏小标签
  // （汇总视图不标：同一个物品在不同号上的买入价可能不一样）
  const unitCost = costOf(r);
  let costTag = '';
  if (unitCost > 0) {
    if (r.lowestPrice > 0) {
      const diff = r.lowestPrice - unitCost;
      costTag = `<span class="costtag ${diff >= 0 ? 'g' : 'r'}" title="成本 ${money(unitCost)}/件 · 当前最低 ${money(r.lowestPrice)}">${
        diff >= 0 ? '盈' : '亏'
      } ${money(Math.abs(diff))}</span>`;
    } else {
      costTag = `<span class="costtag n" title="成本 ${money(unitCost)}/件">成本 ${money(unitCost)}</span>`;
    }
  }

  let stCls = 'wait';
  let stTxt = '待定价';
  if (r.readonly) {
    stCls = 'wait';
    stTxt = '汇总视图';
  } else if (!sellable) {
    stCls = 'block';
    stTxt = '不可出售';
  } else if (r.priceYuan > 0) {
    stCls = 'ok';
    stTxt = '可上架';
  }

  // 组内状态不一致时（200 件里混着几件还在冷却）必须说出来，
  // 否则用户会以为 200 件都能一把挂上去
  const partial = sellable && r.sellableQty < r.qty;
  const bits = [];
  if (r.type) bits.push(esc(r.type));
  if (r.readonly) {
    bits.push(`<b>${r.qty} 件 · ${(r.byAccount || []).length} 个账号</b>`);
    const per = (r.byAccount || [])
      .slice(0, 4)
      .map((a) => `${esc(a.name)} ${a.qty}`)
      .join(' · ');
    if (per) bits.push(per + ((r.byAccount || []).length > 4 ? ' …' : ''));
  } else if (partial) bits.push(`<b>${r.sellableQty}/${r.qty} 件可上架</b>`);
  else if (!sellable) bits.push(esc(r.tradeHoldText || '不可在市场出售'));
  else if (r.qty > 1) bits.push(`<b>${r.qty} 件可上架</b>`);
  // 交易冷却 ≠ 不能上架：Steam 社区市场只要求可上架（marketable）
  if (sellable && r.tradableQty < r.qty) {
    bits.push(esc(r.tradeHoldText || '交易冷却中，仍可上架市场'));
  }
  if (r.quoteError) bits.push('<b>查价失败</b>');

  return `<div class="tr bd${expanded ? ' exp' : ''}" data-row="${esc(r.key)}"
      style="grid-template-columns:34px minmax(0,1fr) 52px 105px 115px 92px 95px 105px 85px 80px">
    <span><input type="checkbox" data-pick="${esc(r.key)}" ${checked ? 'checked' : ''} ${
      sellable && !r.readonly ? '' : 'disabled'
    } title="${r.readonly ? '汇总视图不能直接勾选上架，请先在账号下拉里选单个账号' : ''}" /></span>
    <div class="it">
      ${r.qty > 1
        ? `<button class="exp${expanded ? ' on' : ''}" data-exp="${esc(r.key)}" title="展开查看单件"><i></i></button>`
        : '<span class="exp none"></span>'}
      ${iconHtml(r.iconUrl, r.name, 'cv')}
      <div style="min-width:0;cursor:pointer" data-detail="${esc(r.key)}" title="查看该物品的 Steam 官方实时行情与历史成交">
        <div class="nm">${categoryBadgeHtml(r)} ${esc(r.name)}${costTag}</div>
        <div class="sub">${bits.join(' · ')}</div>
      </div>
    </div>
    <div class="qt">×${r.qty}</div>
    <div class="pr"><b>${lowTxt}</b><span>${r.volume ? r.volume + ' 在售' : ''}</span></div>
    <div class="inp"><span>¥</span><input type="number" step="0.01" min="0" value="${
      r.priceYuan > 0 ? r.priceYuan.toFixed(2) : ''
    }" placeholder="填价" data-price="${esc(r.key)}" ${sellable && !r.readonly ? '' : 'disabled'} /></div>
    <div class="pr buy${buyTxt === '—' ? ' e' : ''}" title="${
      r.buyOk
        ? r.buyPrice > 0
          ? `最高求购价 ${money(r.buyPrice)}：现在挂这个价，可以立刻卖给求购单（共 ${r.buyCount} 个求购）`
          : '目前没有求购订单，只能等买家下单'
        : '求购价还没读取（点「查询行情」）'
    }"><b>${buyTxt}</b><span>${r.buyOk && r.buyCount ? `${r.buyCount} 求购` : ''}</span></div>
    <div class="net ${net > 0 ? '' : 'e'}">${net > 0 ? money(net) : '—'}</div>
    <div class="sub2 ${subtotal > 0 ? '' : 'e'}">${
      subtotal > 0 ? `${money(subtotal)}<em>×${r.sellableQty}</em>` : '—'
    }</div>
    <div class="st ${stCls}" title="${esc(!sellable ? r.tradeHoldText || stTxt : '')}"><i></i>${stTxt}</div>
    <div style="text-align:right">
      <button class="btn act-sell" data-sellone="${esc(r.key)}" ${
        sellable && !r.readonly ? '' : 'disabled'
      }
        title="${
          r.readonly
            ? '汇总视图不能直接上架，请先在账号下拉里选单个账号'
            : sellable
              ? `立即上架这一种物品（${r.sellableQty} 件）`
              : esc(r.tradeHoldText || '当前不可上架')
        }">立即上架</button>
    </div>
  </div>${expanded ? assetDetailHtml(r) : ''}`;
}

/** 展开后的单件明细：同名的两件 tradable 可能不同，所以逐件列出来 */
function assetDetailHtml(r) {
  const rows = r.assets.slice(0, ASSET_PAGE);
  const rest = r.assets.length - rows.length;
  const desc = (r.descriptions || []).filter(Boolean).slice(0, 4);

  return `<div class="axp">
    ${desc.length ? `<div class="axdesc">${desc.map((d) => esc(d)).join('<br>')}</div>` : ''}
    <div class="axgrid">
      ${rows
        .map((a) => {
          // 单件也是只看 marketable；交易冷却只是不能玩家间交易
          const ok = a.marketable !== false;
          const why = !ok ? '不可出售' : a.tradeHoldText || '';
          return `<span class="axc ${ok ? 'ok' : 'no'}" title="${esc(why || '可上架')}">#${esc(a.assetId)}<em>${
            ok ? '可上架' : esc(why)
          }</em></span>`;
        })
        .join('')}
    </div>
    ${rest > 0 ? `<div class="axmore">还有 ${rest} 件未列出</div>` : ''}
  </div>`;
}

/** 价格输入：边打边算到手与小计 */
$('#invBody').addEventListener('input', (e) => {
  const inp = e.target.closest('[data-price]');
  if (!inp) return;
  const key = inp.dataset.price;
  const row = S.invRows.find((r) => r.key === key);
  if (!row) return;
  row.priceYuan = Number(inp.value) || 0;

  const tr = inp.closest('.tr');
  const net = netOf(row.priceYuan);
  const netEl = tr.querySelector('.net');
  if (netEl) {
    netEl.textContent = net > 0 ? money(net) : '—';
    netEl.className = 'net' + (net > 0 ? '' : ' e');
  }
  const subEl = tr.querySelector('.sub2');
  if (subEl) {
    const sub = row.priceYuan > 0 ? row.priceYuan * row.sellableQty : 0;
    subEl.innerHTML = sub > 0 ? `${money(sub)}<em>×${row.sellableQty}</em>` : '—';
    subEl.className = 'sub2' + (sub > 0 ? '' : ' e');
  }
  const stEl = tr.querySelector('.st');
  if (stEl && row.sellableQty > 0) {
    const ready = row.priceYuan > 0;
    stEl.className = 'st ' + (ready ? 'ok' : 'wait');
    stEl.innerHTML = `<i></i>${ready ? '可上架' : '待定价'}`;
  }
  updateSelSummary();
});

/* 勾选 / 展开：事件委托 —— 列表会整块重渲染，逐个绑定会失效 */
$('#invBody').addEventListener('change', (e) => {
  const box = e.target.closest('[data-pick]');
  if (!box) return;
  const key = box.dataset.pick;
  if (box.checked) S.selected.add(key);
  else S.selected.delete(key);
  updateSelSummary();
});

$('#invBody').addEventListener('click', (e) => {
  // 单行「立即上架」：不勾选也能直接把这一种物品挂上去
  const one = e.target.closest('[data-sellone]');
  if (one) {
    const key = one.dataset.sellone;
    const row = S.invRows.find((r) => r.key === key);
    if (!row) return;
    if (!(row.sellableQty > 0)) {
      toast('这件物品当前不可上架（可能在交易冷却中）', true);
      return;
    }
    executeSell([row], { single: true });
    return;
  }

  const ex = e.target.closest('[data-exp]');
  if (!ex) return;
  const key = ex.dataset.exp;
  if (S.invExpanded.has(key)) S.invExpanded.delete(key);
  else S.invExpanded.add(key);
  renderInventory();
});

$('#invAll').addEventListener('change', (e) => {
  const on = e.target.checked;
  S.selected = new Set();
  // 全选只作用于**当前筛出来的**组，不是全部：
  // 否则"筛选冷却中 → 全选 → 上架"会把看不见的行也一起选上
  if (on) viewRows().forEach((r) => { if (r.sellableQty > 0) S.selected.add(r.key); });
  renderInventory();
});

/* ------------------------------ 过滤条事件 ------------------------------ */

$('#invSearch').addEventListener('input', (e) => {
  S.invView.q = e.target.value;
  S.invView.limit = INV_PAGE;
  renderInventory();
});

$('#invFilter').addEventListener('click', (e) => {
  const t = e.target.closest('[data-f]');
  if (!t) return;
  S.invView.filter = t.dataset.f;
  S.invView.limit = INV_PAGE;
  syncInvFilterTabs();
  renderInventory();
});

if ($('#invCatFilter')) {
  $('#invCatFilter').addEventListener('click', (e) => {
    const t = e.target.closest('[data-cat]');
    if (!t) return;
    S.invView.cat = t.dataset.cat;
    S.invView.limit = INV_PAGE;
    syncInvFilterTabs();
    renderInventory();
    const n = viewRows().length;
    if (t.dataset.cat !== 'all') status(`品类「${t.textContent.trim()}」筛出 ${n} 种物品`);
  });
}

function syncInvFilterTabs() {
  $$('#invFilter .tab').forEach((b) => b.classList.toggle('on', b.dataset.f === S.invView.filter));
  $$('#invCatFilter .tab').forEach((b) =>
    b.classList.toggle('on', (b.dataset.cat || 'all') === (S.invView.cat || 'all'))
  );
}

$('#invSort').addEventListener('change', (e) => {
  S.invView.sort = e.target.value;
  renderInventory();
});

function pickedRows() {
  if (!S.selected.size) return [];
  return S.invRows.filter((r) => S.selected.has(r.key));
}

/**
 * 把选中的组展开成逐件上架参数。
 * 只看 marketable：交易冷却（tradable=false）只影响玩家间交易，不影响社区市场出售。
 */
function buildSellItems(rows) {
  const items = [];
  for (const r of rows) {
    for (const a of r.assets || []) {
      if (a.marketable === false) continue;
      items.push({
        assetId: a.assetId,
        // 上架接口要的是"物品所属游戏"的 appid，不是市场 appid
        appId: r.sourceAppId || r.appId,
        contextId: a.contextId || r.contextId || '2',
        marketHashName: r.marketHashName,
        name: r.name,
        priceYuan: r.priceYuan,
        lowestPrice: r.lowestPrice,
        medianPrice: r.medianPrice,
        marketable: true,
        tradable: a.tradable !== false,
      });
    }
  }
  return items;
}

/** 汇总按**件数**算，不按组数 —— 用户真正关心的是有多少件会上架 */
function updateSelSummary() {
  const rows = pickedRows();
  let pieces = 0;
  let gross = 0;
  let net = 0;
  for (const r of rows) {
    const n = r.sellableQty;
    if (!n) continue;
    pieces += n;
    gross += r.priceYuan * n;
    net += netOf(r.priceYuan) * n;
  }
  $('#selCount').textContent = pieces ? `${pieces} 件` : `${rows.length} 种`;
  $('#selGross').textContent = money(gross);
  $('#selNet').textContent = money(net);
  if ($('#selCash')) {
    const cash = net * 0.73;
    $('#selCash').textContent = money(cash);
  }

  const btn = $('#sellStart');
  // 汇总视图里不同账号的资产不能混着卖，批量上架直接禁用
  const ready = !S.invAll && pieces > 0 && rows.some((r) => r.priceYuan > 0);
  btn.disabled = !ready || S.selling;
  btn.textContent = S.invAll
    ? '汇总视图不能上架'
    : S.selling
      ? '上架中…'
      : `批量上架${pieces ? ` (${pieces})` : ''}`;
}

/* --------------------------------- 上架执行 -------------------------------- */

/**
 * 真正执行上架。批量上架与单行「立即上架」共用同一套逻辑，
 * 保证两次执行的确认文案、进度、回写行为完全一致。
 * @param {Array} rows 物品组
 * @param {Object} opts { single:true 表示单行上架 }
 */
async function executeSell(rows, opts = {}) {
  if (S.selling) {
    toast('已有上架任务在进行中，请等它完成', true);
    return;
  }

  // 单行上架时，价格没填就按当前最低价自动补一个，避免用户卡在"先填价"
  if (opts.single && rows.length === 1) {
    const row = rows[0];
    if (!(row.priceYuan > 0)) {
      const base = row.lowestPrice > 0 ? row.lowestPrice : row.medianPrice;
      if (base > 0) {
        row.priceYuan = Math.max(0.03, Math.round((base - 0.01) * 100) / 100);
        log(`单件上架：自动按最低价填写 ${money(row.priceYuan)}（${row.name}）`, 'b');
      }
    }
    if (!(row.priceYuan > 0)) {
      toast('这件物品还没有行情价格，请先在「挂单价」里手动填写', true);
      const inp = document.querySelector(`[data-price="${CSS.escape(row.key)}"]`);
      if (inp) { inp.focus(); inp.select && inp.select(); }
      return;
    }
  }

  const valid = rows.filter((r) => r.priceYuan > 0);
  if (!valid.length) {
    toast('请先勾选物品并填写价格', true);
    return;
  }

  // 组 → 逐件展开：一个组可能含多件，只跳过市场不收货的。
  const items = buildSellItems(valid);
  if (!items.length) {
    toast('这些物品不能在 Steam 市场出售', true);
    return;
  }

  const gross = items.reduce((s, x) => s + x.priceYuan, 0);
  const net = items.reduce((s, x) => s + netOf(x.priceYuan), 0);
  const gap = Number((S.settings || {}).sellIntervalMs) || 4000;
  const secs = Math.ceil((items.length * gap) / 1000);

  // 二次确认：把钱数和耗时都说清楚，防止误操作
  const ok = await askConfirm({
    title: `上架 ${items.length} 件物品到 Steam 市场`,
    sub: `来自 ${valid.length} 种饰品，将按当前行情逐件挂单`,
    icon: '↥',
    rows: [
      { k: '物品数量', v: `${items.length} 件` },
      { k: '挂单总额（买家实付）', v: money(gross) },
      { k: '预计到手', v: money(net), cls: 'green' },
      { k: 'Steam 手续费', v: money(Math.max(0, gross - net)), cls: 'amber' },
      { k: '预计耗时', v: `约 ${secs} 秒` },
    ],
    notes: [
      'Steam 收 5% + 发行商 10%，两边各自最低 ¥0.07；低价物品基本按最低档扣，实际到手以结算为准。',
      '上架是逐件发请求，中途停止不会撤回已经挂上的物品。',
      '改价需要先下架再重新上架；开启手机令牌的账号还需在确认页点“确认”。',
    ],
    okText: '确认上架',
  });
  if (!ok) return;

  S.selling = true;
  updateSelSummary();
  $('#sellProg').style.display = 'block';
  log(`开始上架 ${items.length} 件（${valid.length} 种）`, 'b');

  const r = await call(
    SD.sell.run({ items, steamId: S.costAcc || S.currentSteamId || '' }),
    { noLog: true }
  );

  S.selling = false;
  $('#sellProg').style.display = 'none';
  updateSelSummary();

  if (!r.ok) {
    $('#sellState').textContent = '上架失败';
    status('上架失败');
    return;
  }

  const d = r.data || {};
  const okN = d.ok || 0;
  const failN = d.fail || 0;
  const confirmN = d.pendingConfirm || 0;
  const autoN = d.autoConfirmed || 0;
  const stillN = Math.max(0, confirmN - autoN);

  if (d.blocked && d.blocked.length) {
    d.blocked.forEach((b) => log(`拦截：${b.name} — ${b.blocking}`, 'a'));
    if (!okN) toast(`${d.blocked.length} 件被价格保护/风控拦截，原因见左侧日志`, true);
  }

  /**
   * 失败原因必须逐条说出来。
   * 之前只提示"成功 0，失败 1"，用户完全不知道是价格、冷却、还是 Steam 拒绝，
   * 只能来问"为什么失败"。
   */
  const failedList = (d.executed || []).filter((x) => x.status === 'failed');
  const firstErr = failedList.length ? failedList[0].error || '未知原因' : '';
  failedList.slice(0, 8).forEach((x) => log(`上架失败：${x.name} — ${x.error || '未知原因'}`, 'r'));

  $('#sellState').textContent =
    autoN > 0 && stillN === 0
      ? `成功 ${okN}，已自动确认 ${autoN}`
      : stillN > 0
      ? `成功 ${okN}，待确认 ${stillN}`
      : `成功 ${okN}，失败 ${failN}`;

  if (autoN > 0) {
    log(`已在软件内自动确认 ${autoN} 件挂单，无需手机操作`, 'g');
  }
  if (stillN > 0) {
    // success=true 只是"请求被受理"，挂单还停在待确认状态，不点确认永远不会真正上架
    const tip = d.confirmError ? `（${d.confirmError}）` : '';
    toast(`${stillN} 件已提交，请在打开的窗口里点确认（或用手机 Steam 确认）${tip}`, false);
    log(`有 ${stillN} 件等待 Steam 令牌确认${tip}`, 'a');
    setTimeout(() => openMobileConfirm(), 600);
  } else if (failN > 0) {
    toast(`上架失败：${firstErr}`, true);
  } else if (autoN > 0) {
    toast(`上架完成：${okN} 件已上架并自动确认`, false);
  } else {
    toast(`上架完成：成功 ${okN} 件`, false);
  }
  log(
    `上架完成：成功 ${okN}，失败 ${failN}${confirmN ? `，待确认 ${confirmN}` : ''}${autoN ? `，自动确认 ${autoN}` : ''}`,
    failN ? 'a' : 'g'
  );
  status(`上架完成，成功 ${okN}${stillN ? `，待确认 ${stillN}` : autoN ? `，已确认 ${autoN}` : ''}`);

  // 已上架的件从组里摘掉；整组摘空的就整行移除，不留 ×0 的幽灵行
  const doneIds = new Set((d.executed || []).filter((x) => x.status === 'listed').map((x) => x.assetId));
  if (doneIds.size) {
    for (const g of S.invRows) {
      if (!g.assets.some((a) => doneIds.has(a.assetId))) continue;
      g.assets = g.assets.filter((a) => !doneIds.has(a.assetId));
      g.qty = g.assets.length;
      g.marketableQty = g.assets.filter((a) => a.marketable).length;
      g.tradableQty = g.assets.filter((a) => a.tradable).length;
      g.sellableQty = g.assets.filter((a) => a.marketable !== false).length;
      g.marketable = g.marketableQty === g.qty;
      g.tradable = g.tradableQty === g.qty;
    }
    S.invRows = S.invRows.filter((g) => g.qty > 0);
    S.selected = new Set();
    S.invExpanded = new Set([...S.invExpanded].filter((k) => S.invRows.some((g) => g.key === k)));
    renderInventory();
    renderKpi();
  }
  S.listings = null;
  if (okN > 0) syncOrders({ quiet: true });
}

$('#sellStart').onclick = () => executeSell(pickedRows());

SD.sell.onProgress((p) => {
  if (!p) return;
  const fill = $('#sellProg i');
  if (fill && p.total) fill.style.width = Math.min(100, ((p.done || 0) / p.total) * 100) + '%';
  if (p.message) {
    $('#sellState').textContent = p.message;
    status(p.message);
    // 批量改价是从挂单页发起的，进度也显示在挂单页标题下
    const ordPage = $('.pg[data-p="orders"]');
    if (ordPage && ordPage.classList.contains('on') && $('#ordSub')) $('#ordSub').textContent = p.message;
  }
  if (p.current && p.state === 'running') {
    log(`上架中：${p.current.name} ${money(p.current.priceYuan)}`, 'b');
  }
  if (p.state === 'aborted' && p.message) log(p.message, 'r');
});

/* --------------------------------- 市场挂单 -------------------------------- */

async function syncOrders(opts = {}) {
  const steamId = S.currentSteamId || $('#invAcc').value;
  if (!steamId) {
    if (!opts.quiet) toast('请先选择账号', true);
    return;
  }
  $('#ordSub').textContent = '同步中…';
  // 传 null：查全部游戏的挂单。
  // 老版本写死 730，导致 753 的卡牌背景和其它游戏的饰品在这里看不到、下不掉。
  const r = await call(SD.sell.listings(steamId, null), { silent: opts.quiet, noLog: opts.quiet });
  if (!r.ok) {
    $('#ordSub').textContent = '同步失败';
    $('#ordBody').innerHTML = `<div class="empty"><b>无法同步挂单</b>${esc(r.message)}<br>需要该账号已保存市场 Cookie。</div>`;
    return;
  }
  S.listings = r.data;
  S.ordLimit = 200;
  const count = (r.data && r.data.count) || 0;
  const apps = (r.data && r.data.apps) || {};
  const gameCount = Object.keys(apps).length;
  // 挂单老化：7 天以上算滞销，最久多少天一眼看到
  const nowSec = Math.floor(Date.now() / 1000);
  const ages = Object.values((r.data && r.data.map) || {})
    .filter((e) => e && Number(e.createdAt))
    .map((e) => Math.max(0, (nowSec - Number(e.createdAt)) / 86400));
  const staleCount = ages.filter((a) => a >= 7).length;
  const oldestDays = ages.length ? Math.floor(Math.max(...ages)) : 0;
  const aging = ages.length ? ` · 滞销 ${staleCount} 件` + (oldestDays ? ` · 最久 ${oldestDays} 天` : '') : '';
  $('#ordSub').textContent =
    (gameCount > 1 ? `${count} 条挂单 · 来自 ${gameCount} 个游戏` : `${count} 条挂单`) + aging;
  $('#ordFoot').textContent = `最后同步 ${new Date().toLocaleTimeString('zh-CN')}`;
  $('#navOrders').textContent = count;
  renderOrders();
  renderOverviewOrders();
  renderKpi();
  status(`挂单 ${count} 条`);
  resolveOrderAppNames();
}

/**
 * appid → 游戏名：游戏库 → 商店中文名缓存 → 内置注册表 → 空（调用方退化成 App ID）
 * 753 不是游戏，是 Steam 社区物品（卡牌 / 背景 / 表情），直接给中文名。
 */
function appNameOf(appId) {
  const id = Number(appId);
  if (!id) return '';
  if (id === 753) return 'Steam 社区物品';
  const g = (S.lib || []).find((x) => Number(x.appId) === id);
  if (g && g.name && !/^App\s*\d+$/i.test(g.name)) return g.name;
  if (S.zhNames && S.zhNames[String(id)]) return S.zhNames[String(id)];
  const meta = APP_META[String(id)];
  if (meta && meta.name) return meta.name;
  return '';
}

/** 挂单里出现的游戏如果还没名字，问一次商店接口再重绘 */
async function resolveOrderAppNames() {
  if (!S.listings || !S.listings.map) return;
  const ids = [...new Set(Object.values(S.listings.map).map((i) => Number(i.appId) || 753))]
    .filter((id) => id !== 753 && !appNameOf(id));
  if (!ids.length) return;
  const r = await call(SD.library.names(ids), { noLog: true, silent: true });
  const map = (r && r.ok && r.data) || null;
  if (!map || !Object.keys(map).length) return;
  S.zhNames = Object.assign(S.zhNames || {}, map);
  renderOrders();
}

function renderOrders() {
  refreshUndoBtn();
  const box = $('#ordBody');
  const map = (S.listings && S.listings.map) || {};
  // 后端 setListingMap 会写入 _at 时间戳，必须过滤，否则会多出一行假数据
  const entries = Object.entries(map).filter(
    ([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && v.listingId
  );
  // 选择状态跟着最新挂单走：已卖掉 / 已下架的行不能一直留在选择里
  const liveIds = new Set(
    entries
      .filter(([, v]) => v.state == null || v.state === '' || Number(v.state) === 1)
      .map(([k]) => k)
  );
  for (const id of [...S.ordSel]) if (!liveIds.has(id)) S.ordSel.delete(id);

  const ageDays = (info) =>
    info && info.createdAt
      ? Math.max(0, Math.floor((Date.now() / 1000 - Number(info.createdAt)) / 86400))
      : 0;
  const stale = entries.filter(([, v]) => ageDays(v) >= 7);

  // 账龄四档：件数 + 挂单总售价，直接看钱压在哪一档
  const aging = [0, 0, 0, 0];
  const agingValue = [0, 0, 0, 0];
  for (const [, v] of entries) {
    const age = ageDays(v);
    const idx = age <= 7 ? 0 : age <= 30 ? 1 : age <= 90 ? 2 : 3;
    aging[idx]++;
    agingValue[idx] += Number(v.price) || 0;
  }
  const agingBox = $('#ordAging');
  if (agingBox) {
    agingBox.style.display = entries.length ? 'grid' : 'none';
    for (let i = 0; i < 4; i++) {
      const c = $(`#ab${i}`);
      const v = $(`#ab${i}v`);
      if (c) c.textContent = `${aging[i]} 件`;
      if (v) v.textContent = money(agingValue[i]);
    }
    // 90 天以上那一档只有真的有货才标红，0 件时不该抢视线
    const last = $('#ab3') && $('#ab3').closest('.ab');
    if (last) last.classList.toggle('warn', aging[3] > 0);
  }

  const staleBtn = $('#ordStale');
  if (staleBtn) {
    staleBtn.textContent = `只看滞销${stale.length ? ` (${stale.length})` : ''}`;
    staleBtn.classList.toggle('on', !!S.ordStaleOnly);
  }
  const visible = S.ordStaleOnly ? stale : entries;
  if (S.listings && entries.length) {
    const sub = $('#ordSub');
    if (sub) {
      sub.textContent = stale.length
        ? `${entries.length} 条挂单 · ${stale.length} 件挂了 7 天以上还没卖出`
        : `${entries.length} 条挂单 · 没有超过 7 天的滞销品`;
    }
  }

  if (!visible.length) {
    box.innerHTML = S.ordStaleOnly
      ? `<div class="empty"><b>没有滞销挂单</b>所有挂单都在 7 天内，可以关掉「只看滞销」看全部。</div>`
      : `<div class="empty"><b>暂无挂单</b>上架成功后这里会显示，可在此下架。</div>`;
    updateOrdersSummary(S.ordStaleOnly ? [] : entries);
    updateOrderBatch();
    return;
  }
  updateOrdersSummary(visible);
  // 后端 listinginfo.status 是数字（1=在售），直接显示会让用户看到一个"1"
  const stateText = (s) => {
    if (s === null || s === undefined || s === '') return '在售';
    if (typeof s === 'number' || /^\d+$/.test(String(s))) {
      return { 1: '在售', 2: '已锁定', 3: '已售出', 4: '待确认' }[Number(s)] || `状态 ${s}`;
    }
    return String(s);
  };

  // 按游戏分组显示：跨游戏混排时，光看 assetid 根本认不出是什么东西
  // 一次只渲染 S.ordLimit 行，上千条挂单全量渲染会明显卡顿
  const shown = visible.slice(0, S.ordLimit);
  const byApp = new Map();
  for (const [assetId, info] of shown) {
    const app = Number(info.appId) || 753;
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app).push([assetId, info]);
  }
  const groups = [...byApp.entries()].sort((a, b) => b[1].length - a[1].length);

  box.innerHTML = groups
    .map(([app, list]) => {
      const name = appNameOf(app) || `App ${app}`;
      const head = `<div class="ogroup"><span>${esc(name)}</span>
        <em>appid ${app} · ${list.length} 条</em></div>`;
      const rows = list
        .map(([assetId, info]) => {
          const st = stateText(info.state);
          let cls = st === '在售' ? 'ok' : st === '已售出' ? 'wait' : 'err';
          const title = info.name || info.marketHashName || `assetid ${assetId}`;
          const isUnder = Boolean(info.__underpriced);
          if (isUnder) cls = 'err';
          const net = netOfListing(info);
          const age = ageDays(info);
          const ageTag = age >= 7 ? ` · <b style="color:var(--red)">挂了 ${age} 天</b>` : '';
          const onSale = info.state == null || info.state === '' || Number(info.state) === 1;
          const checked = S.ordSel.has(assetId) ? ' checked' : '';
          return `<div class="tr bd${checked ? ' sel' : ''}" data-asset="${esc(assetId)}" style="grid-template-columns:28px minmax(0,1fr) 110px 110px 100px 84px">
        <div class="ord-cb">${
          onSale ? `<input type="checkbox" data-osel="${esc(assetId)}"${checked} />` : ''
        }</div>
        <div class="it">
          ${iconHtml(info.icon, title, 'cv')}
          <div style="min-width:0">
            <div class="nm">${esc(title)}</div>
            <div class="sub">assetid ${esc(assetId)} · listing ${esc(info.listingId)}${
              isUnder ? ` · <b style="color:var(--red)">市场底价 ${money(info.__latestLowest)}</b>` : ''
            }${ageTag}</div>
          </div>
        </div>
        <div class="pr"><b>${info.price ? money(info.price) : '—'}</b><span>${
          info.createdAt ? new Date(info.createdAt * 1000).toLocaleDateString('zh-CN') : ''
        }</span></div>
        <div class="pr" title="按 Steam 实际手续费（5% + 10%，各自最低 ¥0.07）计算，实际到账金额"><b style="color:var(--green)">${
          net > 0 ? money(net) : '—'
        }</b><span>净到手</span></div>
        <div class="st ${cls}" style="justify-self:center"><i></i>${isUnder ? '已被压单' : esc(st)}</div>
        <div style="text-align:right"><button class="btn s" data-remove="${esc(info.listingId)}">下架</button></div>
      </div>`;
        })
        .join('');
      return head + rows;
    })
    .join('');
  if (visible.length > shown.length) {
    box.innerHTML +=
      `<div style="padding:10px 16px;text-align:center">` +
      `<button class="btn s" id="ordMore">显示更多（已显示 ${shown.length}/${visible.length}）</button></div>`;
  }
  updateOrderBatch();
}

/**
 * 挂单汇总看板：在售件数 / 挂单总售价 / 预计到手净额 / Steam 手续费。
 * 用户要的是"我现在卖着哪些、卖多少钱、最后能到手多少"，
 * 这里直接把后两个数字摊开显示，不必自己按计算器。
 */
function updateOrdersSummary(entries) {
  let gross = 0;
  let net = 0;
  let count = 0;

  for (const [, info] of entries || []) {
    const p = Number(info.price) || 0;
    if (!(p > 0)) continue;
    // 已售出 / 已锁定的不进入"在售收入"统计
    const st = Number(info.state);
    if (Number.isFinite(st) && st !== 1) continue;
    count += 1;
    gross += p;
    net += netOfListing(info);
  }

  const set = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  set('#ordTotalCount', `${count} 件`);
  set('#ordTotalGross', money(gross));
  set('#ordTotalNet', money(net));
  set('#ordTotalFee', money(Math.max(0, gross - net)));
}

/* --------------------------- 挂单多选 / 批量操作 --------------------------- */

let batchBusy = false;

/** 批量操作前先问一次风控：单次件数 / 每日改价次数 */
async function riskCheckBatch(n, kind) {
  const r = await call(SD.risk.status(), { silent: true, noLog: true });
  if (!r.ok) return true;
  const d = r.data || {};
  if (d.enabled && n > (d.maxBatch || 50)) {
    toast(`单次最多 ${d.maxBatch} 件（风控限制），请分批操作`, true);
    return false;
  }
  if (kind === 'reprice' && d.enabled && d.maxDailyReprice > 0 && d.repricedToday >= d.maxDailyReprice) {
    toast(`今天的改价次数已达上限 ${d.maxDailyReprice} 次，明天再试或到设置里调整`, true);
    return false;
  }
  return true;
}

function orderSid() {
  return String(S.currentSteamId || ($('#invAcc') && $('#invAcc').value) || '');
}

/** 当前挂单里还能操作（在售）的行 */
function orderOnSaleEntries() {
  const map = (S.listings && S.listings.map) || {};
  return Object.entries(map).filter(
    ([k, v]) =>
      !k.startsWith('_') &&
      v &&
      typeof v === 'object' &&
      v.listingId &&
      (v.state == null || v.state === '' || Number(v.state) === 1)
  );
}

/** 当前筛选条件下真正显示、且还能操作的行（全选只选这些） */
function orderVisibleEntries() {
  const all = orderOnSaleEntries();
  if (!S.ordStaleOnly) return all;
  return all.filter(([, v]) => {
    const age = v.createdAt
      ? Math.floor((Date.now() / 1000 - Number(v.createdAt)) / 86400)
      : 0;
    return age >= 7;
  });
}

function orderSelectedRows() {
  const map = (S.listings && S.listings.map) || {};
  const out = [];
  for (const assetId of S.ordSel) {
    const info = map[assetId];
    if (info && info.listingId) out.push({ assetId, info });
  }
  return out;
}

function updateOrderBatch() {
  const bar = $('#ordBatch');
  if (!bar) return;
  const rows = orderSelectedRows();
  bar.style.display = rows.length ? '' : 'none';
  const cnt = $('#ordBatchCount');
  if (cnt) cnt.textContent = `已选 ${rows.length} 件`;
  const sum = $('#ordBatchSum');
  if (sum) {
    const gross = rows.reduce((s, r) => s + (Number(r.info.price) || 0), 0);
    const net = rows.reduce((s, r) => s + netOfListing(r.info), 0);
    sum.textContent = rows.length ? `挂单合计 ${money(gross)} · 预计到手 ${money(net)}` : '';
  }
  const all = $('#ordSelAll');
  if (all) {
    const total = orderVisibleEntries().length;
    all.checked = total > 0 && rows.length === total;
    all.indeterminate = rows.length > 0 && rows.length < total;
  }
}

if ($('#ordSelAll')) {
  $('#ordSelAll').onchange = () => {
    const on = $('#ordSelAll').checked;
    S.ordSel.clear();
    if (on) for (const [id] of orderVisibleEntries()) S.ordSel.add(id);
    renderOrders();
  };
}
if ($('#ordBody')) {
  $('#ordBody').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-osel]');
    if (!cb) return;
    if (cb.checked) S.ordSel.add(cb.dataset.osel);
    else S.ordSel.delete(cb.dataset.osel);
    const row = cb.closest('.tr');
    if (row) row.classList.toggle('sel', cb.checked);
    updateOrderBatch();
  });
  $('#ordBody').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'ordMore') {
      S.ordLimit += 200;
      renderOrders();
    }
  });
}
if ($('#ordBatchClear')) {
  $('#ordBatchClear').onclick = () => {
    S.ordSel.clear();
    renderOrders();
  };
}

if ($('#ordBatchRemove')) {
  $('#ordBatchRemove').onclick = async () => {
    if (batchBusy) return;
    const rows = orderSelectedRows();
    if (!rows.length) return;
    const sid = orderSid();
    if (!sid) {
      toast('请先选择账号', true);
      return;
    }
    const gross = rows.reduce((s, r) => s + (Number(r.info.price) || 0), 0);
    const ok = await askConfirm({
      title: `批量下架 ${rows.length} 件挂单`,
      sub: '下架后物品立即回到饰品仓库，不会丢失',
      tone: 'warn',
      icon: '↓',
      rows: [
        { k: '下架数量', v: `${rows.length} 件` },
        { k: '挂单合计', v: money(gross) },
      ],
      notes: [
        '每件之间间隔约 1 秒，避免触发 Steam 限流。',
        '下架后可以重新上架，或用「批量改价」一次改好。',
        '30 分钟内可以用「撤销上次批量」按原价重新上架。',
      ],
      okText: '确认下架',
      confirmText: rows.length >= 20 || gross >= 500 ? String(rows.length) : '',
      confirmLabel:
        rows.length >= 20 || gross >= 500
          ? `这次涉及 ${rows.length} 件 / ${money(gross)}，输入件数 ${rows.length} 以确认`
          : '',
    });
    if (!ok) return;
    if (!(await riskCheckBatch(rows.length, 'remove'))) return;

    batchBusy = true;
    const btn = $('#ordBatchRemove');
    if (btn) btn.disabled = true;
    let done = 0;
    let fail = 0;
    for (let i = 0; i < rows.length; i++) {
      const { assetId, info } = rows[i];
      status(`批量下架 ${i + 1}/${rows.length}：${info.name || info.marketHashName || ''}`);
      const r = await call(SD.sell.remove(sid, info.listingId), { silent: true, noLog: true });
      if (r.ok) {
        done++;
        S.ordSel.delete(assetId);
      } else {
        fail++;
      }
      if (i < rows.length - 1) await new Promise((res) => setTimeout(res, 1100));
    }
    batchBusy = false;
    if (btn) btn.disabled = false;
    if (done > 0) {
      saveUndo({
        at: Date.now(),
        sid,
        kind: 'remove',
        items: rows.map((r) => ({
          assetId: r.assetId,
          appId: Number(r.info.appId) || 753,
          contextId: r.info.contextId,
          marketHashName: r.info.marketHashName || r.info.name,
          name: r.info.name || '',
          priceYuan: Number(r.info.price) || 0,
        })),
      });
    }
    toast(`已下架 ${done} 件${fail ? `，${fail} 件失败` : ''}`, fail > 0);
    log(`批量下架：成功 ${done} 件${fail ? `，失败 ${fail} 件` : ''}`, fail ? 'a' : 'g');
    status('就绪');
    await syncOrders({ quiet: true });
  };
}

/**
 * 批量改价：逐件下架 → 按各自的目标价重新上架（Steam 没有直接改价接口）。
 * entries = [{ assetId, info, priceYuan }]
 */
async function relistEntries(entries) {
  const sid = orderSid();
  const rows = (entries || []).filter((e) => e && e.info && Number(e.priceYuan) >= 0.03);
  if (!sid || !rows.length) return { removed: 0, failed: 0, relisted: 0 };
  const items = [];
  let removed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const { assetId, info, priceYuan } = rows[i];
    status(`改价：下架 ${i + 1}/${rows.length}…`);
    const r = await call(SD.sell.remove(sid, info.listingId), { silent: true, noLog: true });
    if (r.ok) {
      removed++;
      items.push({
        assetId,
        appId: Number(info.appId) || 753,
        contextId: info.contextId || (Number(info.appId) === 753 ? '6' : '2'),
        marketHashName: info.marketHashName || info.name,
        name: info.name || info.marketHashName || '',
        priceYuan,
      });
    } else {
      failed++;
    }
    if (i < rows.length - 1) await new Promise((res) => setTimeout(res, 1100));
  }
  if (!items.length) return { removed, failed, relisted: 0 };

  // Steam 下架后要过一会儿物品才回到库存，立刻重上架容易报"找不到物品"
  await new Promise((res) => setTimeout(res, 1500));
  status(`正在重新上架 ${items.length} 件…`);
  const r = await call(
    SD.sell.run({ items, strategy: 'manual', guardMinRatio: 0, steamId: sid, source: 'reprice' }),
    { noLog: true }
  );
  if (!r.ok) {
    return { removed, failed, relisted: 0, error: r.message || '重新上架失败' };
  }
  const d = r.data || {};
  const relisted = Number(d.ok) || 0;
  return {
    removed,
    failed,
    relisted,
    blocked: (d.blocked || []).length,
    failedRelist: Number(d.fail) || 0,
    pendingConfirm: Number(d.pendingConfirm) || 0,
    autoConfirmed: Number(d.autoConfirmed) || 0,
    confirmError: d.confirmError || '',
    error: '',
  };
}

/* ------------------------- 批量试运行 / 撤销上次批量 ------------------------- */

const UNDO_KEY = 'sd_undo_batch';

function saveUndo(u) {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify(u));
  } catch { /* ignore */ }
  refreshUndoBtn();
}

/** 页头的「撤销上次批量」只在 30 分钟内、且有记录时出现 */
function refreshUndoBtn() {
  const b = $('#ordUndo');
  if (!b) return;
  const u = loadUndo();
  const live =
    u && Array.isArray(u.items) && u.items.length > 0 && Date.now() - Number(u.at || 0) < 30 * 60 * 1000;
  b.style.display = live ? '' : 'none';
  if (live) b.textContent = `撤销上次批量（${u.items.length} 件）`;
}

function loadUndo() {
  try {
    return JSON.parse(localStorage.getItem(UNDO_KEY) || 'null');
  } catch {
    return null;
  }
}

function clearUndo() {
  try {
    localStorage.removeItem(UNDO_KEY);
  } catch { /* ignore */ }
  refreshUndoBtn();
}

function orderBatchItems(rows, price) {
  const items = [];
  for (const r of rows) {
    items.push({
      assetId: r.assetId,
      appId: Number(r.info.appId) || 753,
      contextId: r.info.contextId || (Number(r.info.appId) === 753 ? '6' : '2'),
      marketHashName: r.info.marketHashName || r.info.name,
      name: r.info.name || r.info.marketHashName || '',
      priceYuan: Number(price) || 0,
      lowestPrice: 0,
      marketable: true,
      tradable: true,
    });
  }
  return items;
}

if ($('#ordBatchDry')) {
  $('#ordBatchDry').onclick = async () => {
    if (batchBusy) return;
    const rows = orderSelectedRows();
    if (!rows.length) {
      toast('先勾选要操作的挂单', true);
      return;
    }
    const price = Number(($('#ordBatchPrice') && $('#ordBatchPrice').value || '').replace(/[^\d.]/g, ''));
    if (!(price >= 0.03)) {
      toast('先填批量改价的新价格（至少 0.03 元）', true);
      return;
    }
    const sid = orderSid();
    if (!sid) {
      toast('请先选择账号', true);
      return;
    }
    status('正在生成计划…');
    const r = await call(
      SD.sell.plan({ items: orderBatchItems(rows, price), strategy: 'manual', guardMinRatio: 0, steamId: sid }),
      { silent: true, noLog: true }
    );
    status('就绪');
    if (!r.ok) {
      toast(netText(r.message) || '生成计划失败', true);
      return;
    }
    const d = r.data || {};
    const sum = d.summary || {};
    const blocked = (d.blocked || []).filter((x) => x.blocking);
    await askConfirm({
      title: '试运行结果（没有执行任何操作）',
      sub: `把 ${rows.length} 件挂单改到 ${money(price)} 的预检查`,
      tone: blocked.length ? 'warn' : 'info',
      icon: '✓',
      rows: [
        { k: '可执行', v: `${sum.executable || 0} 件`, cls: 'green' },
        { k: '被拦截', v: `${sum.blocked || 0} 件`, cls: blocked.length ? 'r' : '' },
        { k: '预计挂单合计', v: money(sum.totalGross || 0) },
        { k: '预计到手', v: money(sum.totalNet || 0), cls: 'green' },
        { k: '预计耗时', v: `约 ${sum.estimatedSeconds || 0} 秒` },
      ],
      notes: blocked.slice(0, 6).map((x) => `${x.name || x.marketHashName}：${x.blocking}`),
      okText: '知道了',
    });
  };
}

if ($('#ordUndo')) {
  $('#ordUndo').onclick = async () => {
    if (batchBusy) return;
    const u = loadUndo();
    if (!u || !Array.isArray(u.items) || !u.items.length) {
      toast('没有可撤销的批量操作', true);
      return;
    }
    if (Date.now() - Number(u.at || 0) > 30 * 60 * 1000) {
      clearUndo();
      toast('上次批量操作已超过 30 分钟，不能再撤销', true);
      return;
    }
    const sid = orderSid();
    if (!sid || sid !== u.sid) {
      toast('请先切回执行那次操作的账号', true);
      return;
    }
    const label = u.kind === 'remove' ? '下架' : '改价';
    const ok = await askConfirm({
      title: `撤销上次批量${label}（${u.items.length} 件）`,
      sub: '按操作前的挂单价恢复；已经卖掉的物品会跳过',
      tone: 'warn',
      icon: '↺',
      rows: [
        { k: '操作时间', v: new Date(Number(u.at)).toLocaleString('zh-CN') },
        { k: '涉及件数', v: `${u.items.length} 件` },
      ],
      notes: [
        u.kind === 'remove' ? '会把当时下架的物品按原价重新上架。' : '会把当前挂单下架，再按操作前的价格重新上架。',
        '中途失败不会丢物品，失败的那件会留在库存里。',
      ],
      okText: '确认撤销',
      confirmText: u.items.length >= 20 ? String(u.items.length) : '',
      confirmLabel: u.items.length >= 20 ? `输入件数 ${u.items.length} 以确认` : '',
    });
    if (!ok) return;

    batchBusy = true;
    let text = '';
    // 撤销前必须以当前挂单为准：已经卖掉、或者当时根本没操作成功的，不能重复上架
    const lr = await call(SD.sell.listings(sid, null), { silent: true, noLog: true });
    if (!lr.ok) {
      batchBusy = false;
      toast('读取当前挂单失败，无法确认哪些已下架；稍后再试', true);
      return;
    }
    const map = (lr.data && lr.data.map) || {};
    if (u.kind === 'remove') {
      const todo = u.items.filter((it) => !map[it.assetId] && Number(it.priceYuan) >= 0.03);
      if (!todo.length) {
        text = '这些物品仍在挂单里，无需恢复';
      } else {
        const items = todo.map((it) => ({
          assetId: it.assetId,
          appId: Number(it.appId) || 753,
          contextId: it.contextId || (Number(it.appId) === 753 ? '6' : '2'),
          marketHashName: it.marketHashName,
          name: it.name || it.marketHashName,
          priceYuan: Number(it.priceYuan),
          lowestPrice: 0,
          marketable: true,
          tradable: true,
        }));
        const r = await call(
          SD.sell.run({ items, strategy: 'manual', guardMinRatio: 0, steamId: sid, source: 'reprice' }),
          { noLog: true }
        );
        text = r.ok
          ? `已重新上架 ${(r.data && r.data.ok) || 0} 件`
          : r.message || '重新上架失败';
      }
    } else {
      const entries = u.items
        .filter((it) => {
          const cur = map[it.assetId];
          if (!cur || !(Number(it.priceYuan) >= 0.03)) return false;
          // 价格已经是操作前的价格（例如当时没改成功），跳过，避免多挂一件
          return Math.abs((Number(cur.price) || 0) - Number(it.priceYuan)) > 0.004;
        })
        .map((it) => ({ assetId: it.assetId, info: map[it.assetId], priceYuan: Number(it.priceYuan) }));
      if (!entries.length) {
        text = '当前挂单价已是操作前的价格，无需撤销';
      } else {
        const res = await relistEntries(entries);
        text = res.error
          ? res.error
          : `已恢复 ${res.relisted} 件${res.failedRelist ? `，${res.failedRelist} 件失败` : ''}`;
      }
    }
    batchBusy = false;
    clearUndo();
    toast(text, /失败|无法/.test(text));
    log(`撤销上次批量${label}：${text}`, /失败|无法/.test(text) ? 'r' : 'g');
    S.ordSel.clear();
    await syncOrders({ quiet: true });
  };
}

if ($('#ordBatchReprice')) {
  $('#ordBatchReprice').onclick = async () => {
    if (batchBusy) return;
    const rows = orderSelectedRows();
    if (!rows.length) return;
    const price = Number(($('#ordBatchPrice') && $('#ordBatchPrice').value || '').replace(/[^\d.]/g, ''));
    if (!(price >= 0.03)) {
      toast('新价格至少要 0.03 元（Steam 市场最低价）', true);
      return;
    }
    const gross = price * rows.length;
    const ok = await askConfirm({
      title: `把 ${rows.length} 件挂单改到 ${money(price)}`,
      sub: 'Steam 没有直接改价接口，只能「先下架、再按新价重新上架」',
      tone: 'warn',
      icon: '↻',
      rows: [
        { k: '改价数量', v: `${rows.length} 件` },
        { k: '新挂单价（买家实付）', v: money(price) },
        { k: '合计', v: money(gross) },
        { k: '预计到手', v: money(netOf(price) * rows.length), cls: 'green' },
      ],
      notes: [
        `需要逐件下架再上架，预计耗时 ${Math.ceil((rows.length * 2.6))} 秒以上。`,
        '重新上架可能需要手机令牌确认；没导入令牌的话，结束后到「手机确认」里点一下。',
        '中途失败不会丢物品：下架成功的会按新价重上，没下架成功的保持原样。',
        '改价后 30 分钟内可以用「撤销上次批量」恢复原价。',
      ],
      okText: '开始改价',
      confirmText: rows.length >= 20 || gross >= 500 ? String(rows.length) : '',
      confirmLabel:
        rows.length >= 20 || gross >= 500
          ? `这次涉及 ${rows.length} 件 / ${money(gross)}，输入件数 ${rows.length} 以确认`
          : '',
    });
    if (!ok) return;
    if (!(await riskCheckBatch(rows.length, 'reprice'))) return;

    batchBusy = true;
    const btn = $('#ordBatchReprice');
    if (btn) btn.disabled = true;
    const res = await relistEntries(
      rows.map((r) => ({ assetId: r.assetId, info: r.info, priceYuan: price }))
    );
    batchBusy = false;
    if (btn) btn.disabled = false;
    if (res.relisted > 0) {
      saveUndo({
        at: Date.now(),
        sid: orderSid(),
        kind: 'reprice',
        items: rows.map((r) => ({
          assetId: r.assetId,
          appId: Number(r.info.appId) || 753,
          contextId: r.info.contextId,
          marketHashName: r.info.marketHashName || r.info.name,
          name: r.info.name || '',
          priceYuan: Number(r.info.price) || 0,
        })),
      });
    }

    const parts = [`下架 ${res.removed} 件`];
    if (res.failed) parts.push(`${res.failed} 件下架失败`);
    if (res.error) parts.push(res.error);
    else {
      parts.push(`重新上架 ${res.relisted} 件`);
      if (res.failedRelist) parts.push(`${res.failedRelist} 件上架失败`);
      if (res.pendingConfirm && !res.autoConfirmed) parts.push(`待手机确认 ${res.pendingConfirm} 件`);
    }
    toast(parts.join('，'), !!res.error || !!res.failed || !!res.failedRelist);
    log(`批量改价（${money(price)}）：${parts.join('，')}`, res.error ? 'r' : 'g');

    S.ordSel.clear();
    const inp = $('#ordBatchPrice');
    if (inp) inp.value = '';
    status('就绪');
    await syncOrders({ quiet: true });
  };
}

if ($('#ordStale')) {
  $('#ordStale').onclick = () => {
    S.ordStaleOnly = !S.ordStaleOnly;
    S.ordLimit = 200;
    renderOrders();
  };
}

/** 选中挂单一起跟到当前最低价（逐件 lowest - 0.01） */
if ($('#ordBatchFollow')) {
  $('#ordBatchFollow').onclick = async () => {
    if (batchBusy) return;
    const rows = orderSelectedRows();
    if (!rows.length) return;
    if (!(await riskCheckBatch(rows.length, 'reprice'))) return;
    const pairs = rows.map((r) => ({
      appId: Number(r.info.appId) || 753,
      hashName: r.info.marketHashName || r.info.name,
    }));
    toast(`正在查询 ${pairs.length} 件挂单的当前最低价…`);
    const q = await call(SD.market.quote(730, pairs), { noLog: true });
    if (!q.ok) {
      toast('查价失败：' + (q.message || ''), true);
      return;
    }
    const lowestMap = {};
    for (const item of (q.data && q.data.results) || []) {
      if (!item || !item.marketHashName) continue;
      lowestMap[`${item.appId}:${item.marketHashName}`] = Number(item.lowest) || 0;
    }
    const targets = [];
    let missing = 0;
    for (const r of rows) {
      const app = Number(r.info.appId) || 753;
      const hash = r.info.marketHashName || r.info.name;
      const lowest = lowestMap[`${app}:${hash}`] || 0;
      if (!(lowest > 0)) {
        missing++;
        continue;
      }
      targets.push({
        assetId: r.assetId,
        info: r.info,
        priceYuan: Math.max(0.03, Math.round((lowest - 0.01) * 100) / 100),
      });
    }
    if (!targets.length) {
      toast('这些挂单都没有查到行情，无法跟价', true);
      return;
    }
    const gross = targets.reduce((s, r) => s + r.priceYuan, 0);
    const net = targets.reduce((s, r) => s + netOf(r.priceYuan), 0);
    const ok = await askConfirm({
      title: `把 ${targets.length} 件挂单跟到市场最低价`,
      sub: missing ? `另有 ${missing} 件没有行情，已跳过` : '每件都按「当前最低价 -0.01」重新挂',
      tone: 'warn',
      icon: '↻',
      rows: [
        { k: '跟价数量', v: `${targets.length} 件` },
        { k: '新挂单合计', v: money(gross) },
        { k: '预计到手', v: money(net), cls: 'green' },
        { k: '预计耗时', v: `约 ${Math.ceil(targets.length * 2.6)} 秒` },
      ],
      notes: [
        '按当前最低价跟价，别人再压价时仍会低于你，适合想尽快出手的物品。',
        '会逐件下架再上架，可能需要手机令牌确认。',
        '30 分钟内可以用「撤销上次批量」恢复原价。',
      ],
      okText: '开始跟价',
      confirmText: targets.length >= 20 || gross >= 500 ? String(targets.length) : '',
      confirmLabel:
        targets.length >= 20 || gross >= 500
          ? `这次涉及 ${targets.length} 件 / ${money(gross)}，输入件数 ${targets.length} 以确认`
          : '',
    });
    if (!ok) return;
    batchBusy = true;
    const res = await relistEntries(targets);
    batchBusy = false;
    if (res.relisted > 0) {
      saveUndo({
        at: Date.now(),
        sid: orderSid(),
        kind: 'reprice',
        items: targets.map((t) => ({
          assetId: t.assetId,
          appId: Number(t.info.appId) || 753,
          contextId: t.info.contextId,
          marketHashName: t.info.marketHashName || t.info.name,
          name: t.info.name || '',
          priceYuan: Number(t.info.price) || 0,
        })),
      });
    }
    const parts = [`下架 ${res.removed} 件`];
    if (res.failed) parts.push(`${res.failed} 件下架失败`);
    if (res.error) parts.push(res.error);
    else {
      parts.push(`重新上架 ${res.relisted} 件`);
      if (res.failedRelist) parts.push(`${res.failedRelist} 件上架失败`);
      if (res.blocked) parts.push(`${res.blocked} 件被风控拦截`);
    }
    toast(parts.join('，'), !!res.error || !!res.failed || !!res.failedRelist || !!res.blocked);
    log(`批量跟价：${parts.join('，')}`, res.error ? 'r' : 'g');
    S.ordSel.clear();
    await syncOrders({ quiet: true });
  };
}

/* ------------------------------- 智能定价 ------------------------------- */

const priceTargets = new Map(); // assetId -> 'fast' | 'safe'
let priceRows = [];

function renderPriceList() {
  const box = $('#priceList');
  if (!box) return;
  box.innerHTML =
    `<div class="price-row head"><span>物品</span><span style="text-align:right">当前挂价</span>` +
    `<span style="text-align:right">最低在售</span><span style="text-align:right">快速出手</span>` +
    `<span style="text-align:right">保守价</span></div>` +
    priceRows
      .map((r) => {
        const pick = priceTargets.get(r.assetId) || 'fast';
        const s = r.sug || {};
        const fastCls = pick === 'fast' ? ' sel' : '';
        const safeCls = pick === 'safe' ? ' sel' : '';
        const noData = !(s.fast > 0) && !(s.safe > 0);
        return `<div class="price-row">
        <span class="nm" title="${esc(r.info.name || r.info.marketHashName || '')}">${esc(
          r.info.name || r.info.marketHashName || ''
        )}${noData ? ' <span style="color:var(--dim)">（无行情）</span>' : ''}</span>
        <span class="pr">${r.info.price ? money(r.info.price) : '—'}</span>
        <span class="pr">${s.lowest > 0 ? money(s.lowest) : '—'}</span>
        <span class="pr"><button class="pick${fastCls}" data-pick="fast" data-asset="${esc(
          r.assetId
        )}" ${s.fast > 0 ? '' : 'disabled'} style="width:100%">${
          s.fast > 0 ? money(s.fast) : '—'
        }<span class="sub2">${s.samples7 ? `7天 ${s.samples7} 笔` : ''}</span></button></span>
        <span class="pr"><button class="pick${safeCls}" data-pick="safe" data-asset="${esc(
          r.assetId
        )}" ${s.safe > 0 ? '' : 'disabled'} style="width:100%">${
          s.safe > 0 ? money(s.safe) : '—'
        }<span class="sub2">${s.samples30 ? `30天 ${s.samples30} 笔` : ''}</span></button></span>
      </div>`;
      })
      .join('');
}

async function openPriceSuggest() {
  let rows = orderSelectedRows();
  if (!rows.length) {
    toast('先勾选要定价的挂单', true);
    return;
  }
  if (rows.length > 12) {
    toast('一次最多给 12 件做定价建议，已取前 12 件', true);
    rows = rows.slice(0, 12);
  }
  const pairs = rows.map((r) => ({
    appId: Number(r.info.appId) || 753,
    hashName: r.info.marketHashName || r.info.name,
  }));
  const m = $('#priceModal');
  if (m) m.classList.add('on');
  priceRows = [];
  const list = $('#priceList');
  if (list) list.innerHTML = '<div class="cost-s" style="padding:20px 4px">正在查当前最低价与近 7/30 天成交记录，最多十几件需要一会儿…</div>';
  const pill = $('#pricePill');
  if (pill) pill.textContent = '查询中';
  const r = await call(SD.pricing.suggest(pairs), { silent: true });
  if (!r.ok) {
    if (list) list.innerHTML = `<div class="cost-s" style="padding:20px 4px;color:var(--red)">${esc(
      r.message || '查询失败'
    )}</div>`;
    if (pill) pill.textContent = '失败';
    return;
  }
  const sugMap = {};
  for (const s of (r.data && r.data.items) || []) {
    if (s && s.marketHashName) sugMap[`${s.appId}:${s.marketHashName}`] = s;
  }
  priceTargets.clear();
  priceRows = rows.map((row) => {
    const key = `${Number(row.info.appId) || 753}:${row.info.marketHashName || row.info.name}`;
    const sug = sugMap[key] || { lowest: 0, fast: 0, safe: 0 };
    priceTargets.set(row.assetId, 'fast');
    return { assetId: row.assetId, info: row.info, sug };
  });
  if (pill) pill.textContent = `${priceRows.length} 件`;
  renderPriceList();
}

function selectAllPrices(mode) {
  for (const r of priceRows) {
    const s = r.sug || {};
    if ((mode === 'safe' ? s.safe : s.fast) > 0) priceTargets.set(r.assetId, mode);
  }
  renderPriceList();
}

async function applyPricePicks() {
  const usable = [];
  for (const r of priceRows) {
    const mode = priceTargets.get(r.assetId) || 'fast';
    const raw = Number(mode === 'safe' ? r.sug.safe : r.sug.fast) || 0;
    if (!(raw > 0)) continue;
    usable.push({
      assetId: r.assetId,
      info: r.info,
      priceYuan: Math.max(0.03, Math.round(raw * 100) / 100),
    });
  }
  if (!usable.length) {
    toast('这些挂单都没有可用的建议价', true);
    return;
  }
  if (!(await riskCheckBatch(usable.length, 'reprice'))) return;
  const gross = usable.reduce((s, r) => s + r.priceYuan, 0);
  const ok = await askConfirm({
    title: `按建议价给 ${usable.length} 件挂单改价`,
    sub: '改价 = 先下架、再按新价格重新上架',
    tone: 'warn',
    icon: '↻',
    rows: [
      { k: '改价数量', v: `${usable.length} 件` },
      { k: '新挂单合计', v: money(gross) },
      { k: '预计到手', v: money(usable.reduce((s, r) => s + netOf(r.priceYuan), 0)), cls: 'green' },
      { k: '预计耗时', v: `约 ${Math.ceil(usable.length * 2.6)} 秒` },
    ],
    notes: ['建议价结合了近 7/30 天成交分位，不代表一定卖得掉。', '重新上架可能需要手机令牌确认。'],
    okText: '开始改价',
  });
  if (!ok) return;
  const m = $('#priceModal');
  if (m) m.classList.remove('on');
  batchBusy = true;
  const res = await relistEntries(usable);
  batchBusy = false;
  toast(
    `下架 ${res.removed} 件，重新上架 ${res.relisted} 件${
      res.blocked ? `，${res.blocked} 件被风控拦截` : ''
    }${res.error ? '：' + res.error : ''}`,
    !!res.error || !!res.blocked
  );
  S.ordSel.clear();
  await syncOrders({ quiet: true });
}

if ($('#ordBatchPriceSuggest')) $('#ordBatchPriceSuggest').onclick = () => openPriceSuggest();
if ($('#priceFastAll')) $('#priceFastAll').onclick = () => selectAllPrices('fast');
if ($('#priceSafeAll')) $('#priceSafeAll').onclick = () => selectAllPrices('safe');
if ($('#priceApply')) $('#priceApply').onclick = () => applyPricePicks();
if ($('#priceClose')) $('#priceClose').onclick = () => $('#priceModal').classList.remove('on');
if ($('#priceClose2')) $('#priceClose2').onclick = () => $('#priceModal').classList.remove('on');
if ($('#priceList')) {
  $('#priceList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    priceTargets.set(b.dataset.asset, b.dataset.pick);
    renderPriceList();
  });
}
if ($('#priceModal')) {
  $('#priceModal').addEventListener('click', (e) => {
    if (e.target === $('#priceModal')) $('#priceModal').classList.remove('on');
  });
}

/**
 * 概览页「我的在售挂单」：打开软件就能看到账号正在卖什么。
 * 只显示真实挂单（listingId 存在且状态为在售），金额按真实手续费模型算净到手。
 */
function renderOverviewOrders() {
  const box = $('#ovOrdersList');
  if (!box) return;
  const map = (S.listings && S.listings.map) || {};
  const rows = Object.entries(map)
    .filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && v.listingId)
    .map(([assetId, info]) => ({ assetId, info }))
    .filter(({ info }) => {
      const st = Number(info.state);
      return !Number.isFinite(st) || st === 1;
    })
    .sort((a, b) => (Number(b.info.price) || 0) - (Number(a.info.price) || 0));

  const countEl = $('#ovOrdersCount');
  if (countEl) countEl.textContent = `${rows.length} 件`;

  if (!rows.length) {
    box.innerHTML = `<div class="empty" style="padding:14px 11px" ><b>还没有在售挂单</b>
      <div style="margin-top:4px;font-size:10.5px;color:var(--muted)">在饰品仓库点「立即上架」后，这里会显示售价与预计到手。</div></div>`;
    const foot = $('#ovOrdersFoot');
    if (foot) foot.textContent = S.listings ? `最后同步 ${new Date().toLocaleTimeString('zh-CN')}` : '尚未同步挂单';
    return;
  }

  let gross = 0;
  let net = 0;
  rows.forEach(({ info }) => {
    const p = Number(info.price) || 0;
    gross += p;
    net += netOfListing(info);
  });

  box.innerHTML = rows
    .slice(0, 5)
    .map(({ info }) => {
      const p = Number(info.price) || 0;
      const n = netOfListing(info);
      return `<div class="trow">
        <div style="min-width:0;flex:1">
          <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(
            info.name || info.marketHashName || '物品'
          )}</div>
          <div style="font-size:10.5px;color:var(--dim);margin-top:1px">挂单价 ${p ? money(p) : '—'}</div>
        </div>
        <div class="amt" style="color:var(--green)">${n ? money(n) : '—'}</div>
      </div>`;
    })
    .join('');

  const foot = $('#ovOrdersFoot');
  if (foot) {
    foot.textContent =
      `共 ${rows.length} 件 · 挂单 ${money(gross)} · 预计到手 ${money(net)}` +
      (rows.length > 5 ? `（仅列出金额最高的 5 件）` : '');
  }
}

let underpricedListings = [];

if ($('#ordCheckPrice')) {
  $('#ordCheckPrice').onclick = async () => {
    const map = (S.listings && S.listings.map) || {};
    const entries = Object.entries(map).filter(
      ([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && v.listingId
    );
    if (!entries.length) {
      toast('当前没有有效挂单可比价', true);
      return;
    }

    toast(`正在查询 ${entries.length} 个挂单的当前市场最低价…`);
    status('比价检测中…');

    const pairs = [];
    const seen = new Set();
    for (const [, info] of entries) {
      const app = Number(info.appId) || 753;
      const hashName = info.marketHashName || info.name;
      if (!hashName) continue;
      const key = `${app}:${hashName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ appId: app, hashName });
    }

    const r = await call(SD.market.quote(730, pairs), { noLog: true });
    if (!r.ok) {
      toast('查价失败：' + (r.message || ''), true);
      return;
    }

    const results = (r.data && r.data.results) || [];
    const qMap = {};
    for (const q of results) {
      if (q && q.marketHashName) qMap[`${q.appId}:${q.marketHashName}`] = q.lowest;
    }

    underpricedListings = [];
    for (const [, info] of entries) {
      const app = Number(info.appId) || 753;
      const hashName = info.marketHashName || info.name;
      const latestLowest = qMap[`${app}:${hashName}`];
      if (latestLowest && info.price > latestLowest + 0.01) {
        info.__underpriced = true;
        info.__latestLowest = latestLowest;
        underpricedListings.push(info);
      } else {
        delete info.__underpriced;
        delete info.__latestLowest;
      }
    }

    renderOrders();
    const btnCancel = $('#ordCancelUnderpriced');
    if (btnCancel) {
      btnCancel.disabled = !underpricedListings.length;
      btnCancel.textContent = underpricedListings.length
        ? `撤单被压单物品 (${underpricedListings.length})`
        : '撤单被压单物品';
    }

    if (underpricedListings.length) {
      toast(`检测到 ${underpricedListings.length} 件挂单已被他人低价压单！可点击撤单`);
      log(`比价完成：发现 ${underpricedListings.length} 件挂单价格高于当前市场最低价`, 'a');
    } else {
      toast('恭喜！所有挂单均处于市场最优/最低价格');
      log('比价完成：所有挂单均为市场最低价', 'g');
    }
    status('比价完成');
  };
}

if ($('#ordCancelUnderpriced')) {
  $('#ordCancelUnderpriced').onclick = async () => {
    if (!underpricedListings.length) return;
    const ok = await askConfirm({
      title: `批量下架 ${underpricedListings.length} 件被压单物品`,
      sub: '这些挂单的价格已经高于当前市场最低价，继续挂着很难卖出',
      tone: 'warn',
      icon: '↓',
      rows: [{ k: '下架数量', v: `${underpricedListings.length} 件` }],
      notes: [
        '下架后物品立即回到饰品仓库，不会丢失。',
        '可以按最新最低价重新上架，重新上架同样需要手机令牌确认。',
      ],
      okText: '确认下架',
    });
    if (!ok) return;

    let success = 0;
    for (const info of underpricedListings) {
      const r = await call(SD.sell.remove(S.currentSteamId, info.listingId), { noLog: true });
      if (r.ok) success++;
    }
    toast(`已批量下架 ${success}/${underpricedListings.length} 件被压单物品`);
    log(`已批量下架 ${success} 件被压单物品，可前往饰品仓库重新上架`, 'g');
    underpricedListings = [];
    $('#ordCancelUnderpriced').disabled = true;
    $('#ordCancelUnderpriced').textContent = '撤单被压单物品';
    syncOrders({ quiet: true });
  };
}

document.addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]');
  if (!rm) return;
  const listingId = rm.dataset.remove;
  const rowEl = rm.closest('.tr');
  const nm = rowEl && rowEl.querySelector('.nm') ? rowEl.querySelector('.nm').textContent.trim() : '';
  const priceTxt =
    rowEl && rowEl.querySelector('.pr b') ? rowEl.querySelector('.pr b').textContent.trim() : '';
  const ok = await askConfirm({
    title: '下架这件挂单？',
    sub: nm || `listing ${listingId}`,
    tone: 'warn',
    icon: '↓',
    rows: [
      priceTxt ? { k: '挂单价（买家实付）', v: priceTxt } : null,
      { k: 'Listing ID', v: listingId },
    ],
    notes: ['下架后物品立即回到饰品仓库，不会丢失，可以随时按新价格重新上架。'],
    okText: '确认下架',
  });
  if (!ok) return;
  rm.disabled = true;
  const r = await call(SD.sell.remove(S.currentSteamId, listingId));
  if (r.ok) {
    toast('已下架');
    log(`已下架 listing ${listingId}`, 'g');
    syncOrders({ quiet: true });
  } else {
    rm.disabled = false;
  }
});

$('#ordSync').onclick = () => syncOrders();

/* ---------------------------------- 游戏库 -------------------------------- */

const APP_META = {
  730: { name: 'CS2', color: 'linear-gradient(150deg,#F0B15E,#B4652A)' },
  570: { name: 'Dota 2', color: 'linear-gradient(150deg,#E08A72,#8C3A35)' },
  252490: { name: 'Rust', color: 'linear-gradient(150deg,#A8C8F0,#3C5D8C)' },
  440: { name: 'TF2', color: 'linear-gradient(150deg,#9AC7A8,#3E6B4C)' },
};

async function scanLibrary(opts = {}) {
  $('#libSub').textContent = '扫描中…';
  const r = await call(SD.library.scan({}), { silent: opts.quiet, noLog: opts.quiet });
  if (!r.ok) {
    $('#libSub').textContent = '扫描失败';
    $('#libBody').innerHTML = `<div class="empty" style="grid-column:1/-1"><b>扫描失败</b>${esc(r.message)}</div>`;
    return;
  }
  S.lib = (r.data && r.data.games) || r.data || [];
  $('#libSub').textContent = `${S.lib.length} 个游戏`;
  renderLibFilters();
  renderLibrary();
  if (!opts.quiet) log(`扫描到 ${S.lib.length} 个游戏`, 'b');
  hydrateLibNames();
}

/**
 * 补全中文名。
 * 本地 acf / localconfig 里只有"装过或启动过"的游戏才有名字，
 * 其余显示成 `App 92` 这种占位符；显式让主进程去商店接口批量问，
 * 拿到后就地更新并重绘（结果由主进程写进 settings.appNames 永久缓存）。
 */
let hydrating = false;
async function hydrateLibNames() {
  if (hydrating || !S.lib.length) return;
  hydrating = true;
  const ids = S.lib.map((g) => g.appId);
  // 补名字是 Steam 库的事，用户已经切到 Epic / GOG 时不要抢副标题
  if (S.libSource === 'steam') $('#libSub').textContent = `补全中文名…（${S.lib.length} 个游戏）`;
  try {
    const r = await call(SD.library.names(ids), { noLog: true, silent: true });
    const map = (r && r.ok && r.data) || null;
    if (map && Object.keys(map).length) {
      let changed = 0;
      for (const g of S.lib) {
        const zh = map[String(g.appId)];
        if (zh && zh !== g.name) {
          g.name = zh;
          g.hasName = true;
          changed++;
        }
      }
      S.zhNames = Object.assign(S.zhNames || {}, map);
      if (changed) {
        renderLibFilters();
        renderLibrary();
      }
    }
  } catch { /* 名字补全失败不该影响整页 */ }
  if (S.libSource === 'steam') $('#libSub').textContent = `${S.lib.length} 个游戏`;
  hydrating = false;
}

function renderLibFilters() {
  const tradeableCount = S.lib.filter((g) => g.tradeable || APP_META[String(g.appId)]).length;
  const installedCount = S.lib.filter((g) => g.installed).length;
  $('#libFilter').innerHTML =
    `<button class="tab ${S.libApp === 'all' ? 'on' : ''}" data-lib="all">全部 <span style="opacity:.6">${S.lib.length}</span></button>` +
    `<button class="tab ${S.libApp === 'tradeable' ? 'on' : ''}" data-lib="tradeable">支持市场 <span style="opacity:.6">${tradeableCount}</span></button>` +
    `<button class="tab ${S.libApp === 'installed' ? 'on' : ''}" data-lib="installed">已安装 <span style="opacity:.6">${installedCount}</span></button>`;
}

$('#libFilter').addEventListener('click', (e) => {
  const t = e.target.closest('[data-lib]');
  if (!t) return;
  S.libApp = t.dataset.lib;
  renderLibFilters();
  renderLibrary();
});

$('#libSearch').addEventListener('input', (e) => {
  S.libQuery = e.target.value;
  renderLibrary();
});

$('#libShape').addEventListener('click', (e) => {
  const t = e.target.closest('[data-shape]');
  if (!t) return;
  S.libShape = t.dataset.shape;
  $$('#libShape .tab').forEach((b) => b.classList.toggle('on', b.dataset.shape === S.libShape));
  renderLibrary();
});

/** 按当前封面形状取候选地址：用户选的形状优先，另一个形状作为兜底 */
function pickCovers(g, shape) {
  const want = shape === 'portrait' ? g.coversPortrait : g.covers;
  const other = shape === 'portrait' ? g.covers : g.coversPortrait;
  const list = Array.isArray(want) ? want.slice() : [];
  if (Array.isArray(other)) {
    for (const u of other) if (u && !list.includes(u)) list.push(u);
  }
  if (!list.length) list.push(`sdimg://app/${g.appId}/header.jpg`);
  return list;
}

/** 一屏最多渲染多少张卡片。再多也没有意义，用搜索缩小范围更快。 */
const LIB_CAP = 600;

function renderLibrary() {
  // Epic / GOG 的库结构和 Steam 完全不同，走各自的渲染器
  if (S.libSource !== 'steam') return renderForeignLib();
  const box = $('#libBody');
  // 网格列宽跟随封面形状：横版更宽，竖版更窄（以前从未切换，卡片被挤成窄条）
  box.className = `ggrid ${S.libShape}`;
  const q = S.libQuery.trim().toLowerCase();

  let list = S.lib;
  if (S.libApp === 'installed') list = list.filter((g) => g.installed);
  else if (S.libApp === 'tradeable') list = list.filter((g) => g.tradeable || APP_META[String(g.appId)]);
  else if (S.libApp !== 'all') list = list.filter((g) => String(g.appId) === S.libApp);
  if (q) list = list.filter((g) => `${g.name || ''} ${g.appId}`.toLowerCase().includes(q));

  if (!list.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>没有游戏</b>${
      S.lib.length ? '换个筛选条件或清空搜索试试。' : '点右上角「扫描游戏库」读取本地安装记录。'
    }</div>`;
    return;
  }

  const shape = S.libShape;
  const shown = list.slice(0, LIB_CAP);
  S.coverMap = {};

  box.innerHTML =
    shown
      .map((g) => {
        const covers = pickCovers(g, shape);
        S.coverMap[String(g.appId)] = covers;
        const fallback = (g.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
        // 商店查不到的条目（Steam 截图、测试分支、未上架 DLC）没有正式名字，
        // 与其显示 "App 760" 让人以为没加载出来，不如直说没收录。
        const unnamed = g.hasName === false;
        const shownName = unnamed ? '商店未收录' : g.name;
        // 不足 1 小时显示"0 小时"很怪，单独说清楚
        const mins = Number(g.playtime) || 0;
        const hrs = mins >= 60 ? `${Math.round(mins / 60)} 小时` : mins > 0 ? '不足 1 小时' : '';
        const badge = g.tradeable ? '<span class="stat trade">可交易</span>' : '';
        return `<div class="gcard ${shape}" title="${esc(g.name + ' · AppID ' + g.appId)}">
      <div class="cov">
        <img data-src="${esc(covers[0])}" alt="${esc(shownName)}" loading="lazy" decoding="async"
             data-appid="${esc(String(g.appId))}" data-i="0" onerror="SDCoverErr(this)" />
        <span class="covfb">${esc(fallback)}</span>
        <span class="plat">Steam</span>
        ${badge}
      </div>
      <div class="ib2">
        <div class="nm${unnamed ? ' noname' : ''}">${esc(shownName)}</div>
        <div class="meta">
          <span class="gtag">AppID ${esc(String(g.appId))}</span>
          ${g.installed ? '<span class="gtag ok">已安装</span>' : ''}
          ${hrs ? `<span>${esc(hrs)}</span>` : ''}
        </div>
      </div>
      <div class="gact-row">
        <button class="btn s gact-btn" data-launch="${esc(String(g.appId))}" title="通过 Steam 客户端直接启动">启动</button>
        <button class="btn s gact-btn" data-market="${esc(String(g.appId))}" title="打开该游戏的 Steam 社区市场">市场</button>
      </div>
    </div>`;
      })
      .join('') +
    (list.length > shown.length
      ? `<div class="gmore">还有 ${list.length - shown.length} 个游戏未显示，用搜索缩小范围</div>`
      : '');

  lazyPaintCovers(box);
  updateLibCount(list.length);
}

/* --------------------------- Epic / GOG 游戏库 ---------------------------
 * 两家的库都通过账号令牌 / 网页 Cookie 读取，结构跟 Steam 完全不同，
 * 所以单独一套渲染，搜索框共用。
 */

function renderEpicAccSelect() {
  const sel = $('#libEpicAcc');
  if (!sel) return;
  const list = S.epic.accounts || [];
  if (!list.length) {
    sel.innerHTML = '<option value="">（还没有 Epic 账号）</option>';
    if ($('#libEpicHint')) $('#libEpicHint').textContent = '先到「账号管理」里添加 Epic 账号';
    return;
  }
  if (!S.epicLib.accountId) S.epicLib.accountId = list[0].accountId;
  sel.innerHTML = list
    .map(
      (a) =>
        `<option value="${esc(a.accountId)}" ${a.accountId === S.epicLib.accountId ? 'selected' : ''}>${esc(
          a.displayName || '…' + String(a.accountId).slice(-4)
        )}</option>`
    )
    .join('');
  if ($('#libEpicHint')) {
    $('#libEpicHint').textContent = `已添加 ${list.length} 个 Epic 账号`;
  }
}

function renderGogBar() {
  const state = $('#libGogState');
  const login = $('#libGogLogin');
  const fetchBtn = $('#libGogFetch');
  if (!state) return;
  if (S.gogLib.linked) {
    state.textContent = 'GOG 已登录';
    state.className = 'lb on';
    if (login) login.style.display = 'none';
    if (fetchBtn) fetchBtn.style.display = '';
  } else {
    state.textContent = 'GOG 未登录';
    state.className = 'lb';
    if (login) login.style.display = '';
    if (fetchBtn) fetchBtn.style.display = 'none';
  }
}

function renderForeignLib() {
  const box = $('#libBody');
  if (!box) return;
  box.className = 'ggrid portrait';
  const src = S.libSource;
  const st = src === 'epic' ? S.epicLib : S.gogLib;
  const q = S.libQuery.trim().toLowerCase();
  let list = st.items || [];
  if (q) list = list.filter((g) => String(g.title || '').toLowerCase().includes(q));

  // 渐进加载时 items 会一个个补进来，只有完全没数据时才显示整页读取中
  if (st.loading && !list.length) {
    box.innerHTML = '<div class="empty" style="grid-column:1/-1"><b>正在读取…</b>已缓存的条目会先出来，剩下的边补封面边显示。</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>${
      st.error ? '读取失败' : '还没有数据'
    }</b>${esc(
      st.error ||
        (src === 'epic'
          ? '选好账号后点「拉取 Epic 库」。'
          : '先登录 GOG，再点「拉取 GOG 库」。')
    )}</div>`;
    return;
  }

  box.innerHTML = list
    .slice(0, LIB_CAP)
    .map((g) => {
      const fb =
        String(g.title || '?')
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 2)
          .toUpperCase() || '?';
      return `<div class="gcard portrait" title="${esc(g.title)}">
      <div class="cov">
        ${g.image ? `<img src="${esc(g.image)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />` : ''}
        <span class="covfb">${esc(fb)}</span>
        <span class="plat">${src === 'epic' ? 'Epic' : 'GOG'}</span>
      </div>
      <div class="ib2">
        <div class="nm">${esc(g.title)}</div>
        <div class="meta">
          <span class="gtag">${src === 'epic' ? 'Epic Games' : 'GOG'}</span>
          ${g.desc ? `<span>${esc(g.desc || '').slice(0, 40)}</span>` : ''}
        </div>
      </div>
      <div class="gact-row">
        <button class="btn s gact-btn" data-store-url="${esc(g.url)}">打开商店页</button>
      </div>
    </div>`;
    })
    .join('');
  // Epic / GOG 库封面也要走同一套懒加载：图片 load 之后才会加 .ok 显示出来
  lazyPaintCovers(box);
  updateLibCount(list.length);
}

function setLibSource(src) {
  S.libSource = src;
  $$('#libSource .tab').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
  const isSteam = src === 'steam';
  if ($('#libEpicBar')) $('#libEpicBar').style.display = src === 'epic' ? '' : 'none';
  if ($('#libGogBar')) $('#libGogBar').style.display = src === 'gog' ? '' : 'none';
  if ($('#libFilter')) $('#libFilter').style.display = isSteam ? '' : 'none';
  if ($('#libShape')) $('#libShape').style.display = isSteam ? '' : 'none';
  if ($('#libFetchOwned')) $('#libFetchOwned').style.display = isSteam ? '' : 'none';
  if ($('#libScan')) $('#libScan').style.display = isSteam ? '' : 'none';
  S.libQuery = '';
  if ($('#libSearch')) $('#libSearch').value = '';

  if (isSteam) {
    $('#libSub').textContent = S.lib.length ? `${S.lib.length} 个游戏` : '扫描已安装的 Steam 游戏';
    renderLibrary();
    return;
  }
  if (src === 'epic') {
    renderEpicAccSelect();
    $('#libSub').textContent = S.epicLib.items.length
      ? `Epic 库 · ${S.epicLib.items.length} 个游戏`
      : '读取 Epic 已拥有游戏';
    renderForeignLib();
    if (!S.epicLib.items.length && !S.epicLib.loading && (S.epic.accounts || []).length) {
      loadEpicLib();
    }
    return;
  }
  renderGogBar();
  $('#libSub').textContent = S.gogLib.items.length
    ? `GOG 库 · ${S.gogLib.items.length} 个游戏`
    : '读取 GOG 已拥有游戏';
  renderForeignLib();
  loadGogStatus().then(() => {
    if (S.gogLib.linked && !S.gogLib.items.length && !S.gogLib.loading) loadGogLib();
  });
}

async function loadEpicLib() {
  const st = S.epicLib;
  const acc = st.accountId || ((S.epic.accounts || [])[0] || {}).accountId;
  if (!acc) {
    st.error = '还没有 Epic 账号，先到「账号管理」里添加';
    renderForeignLib();
    return;
  }
  st.accountId = acc;
  st.loading = true;
  st.error = '';
  st.partial = false;
  $('#libSub').textContent = '正在读取 Epic 库…';
  renderForeignLib();

  const r = await call(SD.epic.library(acc), { noLog: true, silent: true });
  st.loading = false;
  st.partial = false;
  if (r.ok && r.data) {
    st.items = r.data.items || [];
    st.at = r.data.at || Date.now();
    $('#libSub').textContent = `Epic 库 · ${st.items.length} 个游戏`;
    log(`Epic 库已更新：${st.items.length} 个游戏`, 'g');
  } else {
    st.error = r.message || '读取失败';
    $('#libSub').textContent = 'Epic 库读取失败';
    toast(st.error, true);
    log(`Epic 库读取失败：${st.error}`, 'r');
  }
  renderForeignLib();
}

async function loadGogStatus() {
  const r = await call(SD.gog.status(), { noLog: true, silent: true });
  S.gogLib.linked = !!(r.ok && r.data && r.data.linked);
  renderGogBar();
  return S.gogLib.linked;
}

async function loadGogLib() {
  const st = S.gogLib;
  if (!(await loadGogStatus())) {
    st.error = '还没有登录 GOG';
    renderForeignLib();
    return;
  }
  st.loading = true;
  st.error = '';
  $('#libSub').textContent = '正在读取 GOG 库…';
  renderForeignLib();

  const r = await call(SD.gog.library(), { noLog: true, silent: true });
  st.loading = false;
  if (r.ok && r.data) {
    st.items = r.data.items || [];
    st.at = r.data.at || Date.now();
    $('#libSub').textContent = `GOG 库 · ${st.items.length} 个游戏`;
    log(`GOG 库已更新：${st.items.length} 个游戏`, 'g');
  } else {
    st.error = r.message || '读取失败';
    $('#libSub').textContent = 'GOG 库读取失败';
    toast(st.error, true);
    log(`GOG 库读取失败：${st.error}`, 'r');
  }
  renderForeignLib();
}

if ($('#libSource')) {
  $('#libSource').addEventListener('click', (e) => {
    const t = e.target.closest('[data-src]');
    if (!t) return;
    setLibSource(t.dataset.src);
  });
  if ($('#libEpicFetch')) $('#libEpicFetch').onclick = () => loadEpicLib();
  if ($('#libEpicAcc')) {
    $('#libEpicAcc').onchange = (e) => {
      S.epicLib.accountId = e.target.value;
      S.epicLib.items = [];
      loadEpicLib();
    };
  }
  if ($('#libGogLogin')) {
    $('#libGogLogin').onclick = async () => {
      toast('已打开 GOG 登录窗口，登录完成后会自动关闭');
      const r = await call(SD.gog.login(), { noLog: true, silent: true });
      if (!r.ok) {
        if (!/已关闭/.test(r.message || '')) toast(r.message || 'GOG 登录失败', true);
        return;
      }
      await loadGogStatus();
      toast('GOG 已登录');
      loadGogLib();
    };
  }
  if ($('#libGogFetch')) $('#libGogFetch').onclick = () => loadGogLib();
}

if ($('#libBody')) {
  $('#libBody').addEventListener('click', async (e) => {
    const launchBtn = e.target.closest('[data-launch]');
    if (launchBtn) {
      const appId = launchBtn.dataset.launch;
      toast(`正在唤起 Steam 客户端启动游戏 (${appId})…`);
      await call(SD.app.openExternal(`steam://run/${appId}`));
      return;
    }
    const storeBtn = e.target.closest('[data-store-url]');
    if (storeBtn) {
      const url = storeBtn.dataset.storeUrl;
      if (url) await call(SD.app.openExternal(url), { noLog: true, silent: true });
      return;
    }
    const marketBtn = e.target.closest('[data-market]');
    if (marketBtn) {
      const appId = marketBtn.dataset.market;
      toast('正在打开 Steam 社区市场…');
      await call(SD.app.openExternal(`https://steamcommunity.com/market/search?appid=${appId}`));
      return;
    }
  });
}

function updateLibCount(filtered) {
  const sub = $('#libSub');
  if (!sub) return;
  if (S.libSource !== 'steam') {
    const st = S.libSource === 'epic' ? S.epicLib : S.gogLib;
    const total = (st.items || []).length;
    const label = S.libSource === 'epic' ? 'Epic 库' : 'GOG 库';
    sub.textContent = S.libQuery.trim()
      ? `${label} · 匹配 ${filtered} / ${total} 个游戏`
      : `${label} · ${total} 个游戏`;
    return;
  }
  if (S.libQuery.trim()) sub.textContent = `匹配 ${filtered} / ${S.lib.length} 个游戏`;
  else sub.textContent = `${S.lib.length} 个游戏`;
}

/* ===== 图片绘制器 =====
   Electron 里把 sdimg:// 直接塞进 img.src，偶发首帧解码为空且不触发 onerror，
   表现为"灰块但没兜底字母"。这里统一改成：取字节 → blob URL → 交给 img。
   blob 走完整字节，实测稳定；失败才退回直连。 */
const PAINT_MAX = 4;
let paintRunning = 0;
const paintQueue = [];

function paintNext() {
  while (paintRunning < PAINT_MAX && paintQueue.length) {
    const job = paintQueue.shift();
    paintRunning += 1;
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .then(() => {
        paintRunning -= 1;
        paintNext();
      });
  }
}

async function paintImg(img) {
  if (!img || img.dataset.painting === '1' || img.dataset.painted === '1') return;
  const url = img.dataset.src || img.getAttribute('src') || '';
  if (!url) return;
  img.dataset.painting = '1';
  paintQueue.push(async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      if (!blob || !blob.size) throw new Error('empty');
      const u = URL.createObjectURL(blob);
      img.dataset.painted = '1';
      img.dataset.objurl = u;
      img.src = u;
    } catch {
      // 兜底：直接交给 img，仍由 onerror 走多级回退
      img.dataset.painted = '1';
      img.src = url;
    } finally {
      delete img.dataset.painting;
    }
  });
  paintNext();
}

/**
 * 只在卡片滚进视口时才去取封面。
 *
 * 老版本一次给最多 300 张卡片全部排进绘制队列。配上"域名列表里全是死域名"，
 * 每张图都要先把 5 个连不上的域名超时一遍，整页看起来就是"封面永远不出来"。
 * 域名问题已在 main/imageProxy.js 修掉，这里再把并发压力降下来：
 * 视口外的卡片一个字节都不取。
 */
let coverObserver = null;

function lazyPaintCovers(root) {
  const imgs = root.querySelectorAll('.cov img');
  if (!imgs.length) return;

  if (!coverObserver) {
    coverObserver = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          coverObserver.unobserve(en.target);
          paintImg(en.target);
        }
      },
      { root: null, rootMargin: '400px 0px' }
    );
  }

  imgs.forEach((img) => {
    img.addEventListener('load', () => {
      if (!img.naturalWidth) return;
      img.classList.add('ok');
      const fb = img.parentElement.querySelector('.covfb');
      if (fb) fb.style.display = 'none';
    });
    img.addEventListener('error', () => SDCoverErr(img));
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('ok');
      const fb = img.parentElement.querySelector('.covfb');
      if (fb) fb.style.display = 'none';
      return;
    }
    coverObserver.observe(img);
  });
}

/** 封面多级回退：竖版 library → header → capsule → 字母块 */
function SDCoverErr(img) {
  try {
    const list = (S.coverMap && S.coverMap[String(img.dataset.appid)]) || [];
    const next = Number(img.dataset.i || 0) + 1;
    if (next < list.length) {
      img.dataset.i = String(next);
      img.dataset.src = list[next];
      delete img.dataset.painted;
      if (img.dataset.objurl) {
        URL.revokeObjectURL(img.dataset.objurl);
        delete img.dataset.objurl;
      }
      img.removeAttribute('src');
      paintImg(img);
      return;
    }
  } catch { /* ignore */ }
  img.style.display = 'none';
  const fb = img.parentElement.querySelector('.covfb');
  if (fb) fb.style.display = 'grid';
}
window.SDCoverErr = SDCoverErr;

$('#libScan').onclick = () => scanLibrary();

// 在线拉取完整游戏库（需 API Key）
if ($('#libFetchOwned')) {
  $('#libFetchOwned').onclick = async () => {
    const steamId = S.currentSteamId;
    if (!steamId) { toast('请先选择账号', true); return; }
    $('#libSub').textContent = '在线拉取中…';
    const r = await call(SD.library.owned(steamId), { noLog: true });
    if (!r.ok) {
      $('#libSub').textContent = '在线拉取失败';
      toast(r.message || '拉取失败', true);
      log(`在线拉取游戏库失败：${r.message}`, 'a');
      return;
    }
    const games = (r.data && r.data.games) || [];
    S.lib = games;
    $('#libSub').textContent = `${games.length} 个游戏（在线）`;
    renderLibFilters();
    renderLibrary();
    hydrateLibNames();
    log(`在线拉取到 ${games.length} 个游戏`, 'g');
  };
}

/* ---------------------------------- 概览 ---------------------------------- */

function renderKpi() {
  // 库存估值 = Σ(每种件数 × 市场最低价)；没有行情时明确说明，而不是显示 0.00 让人以为坏了
  const pieces = S.invRows.reduce((s, r) => s + (r.qty || 0), 0);
  const value = S.invRows.reduce((s, r) => s + (r.lowestPrice || 0) * (r.qty || 1), 0);
  const quoted = S.invRows.filter((r) => r.lowestPrice > 0).length;
  const total = S.invRows.length;
  // 只有能上架的物品才该参与"有没有行情"的对比。
  // 背景/表情一旦被 Steam 永久下架就永远查不到价，若拿全量做分母，
  // 用户会看到"22/210 有行情"，误以为查价大面积失败。
  const sellable = S.invRows.filter((r) => r.marketHashName && r.marketableQty > 0).length;
  // 没有任何行情时不显示 0.00（会被误认为"坏了"），诚实显示 —
  if (quoted > 0) {
    $('#kValue').textContent = money(value);
    const dead = total - sellable;
    $('#kValueSub').textContent = dead > 0
      ? `${quoted}/${sellable} 种可售物品有行情 · 另 ${dead} 件市场已下架`
      : `${quoted}/${sellable} 种物品有行情`;
  } else {
    // 没有本次行情时，回落到最近一次快照估值——否则会与上面的趋势图自相矛盾
    const snaps = typeof loadTrend === 'function' ? loadTrend() : [];
    const last = snaps.length ? snaps[snaps.length - 1].v : 0;
    if (last > 0) {
      $('#kValue').textContent = money(last);
      $('#kValueSub').textContent = total
        ? `上次拉取估值 · 本次尚未查价`
        : '上次拉取估值 · 本次未拉取库存';
    } else {
      $('#kValue').textContent = '—';
      $('#kValueSub').textContent = total
        ? '已拉取，尚未查价（点「查询行情」）'
        : '未拉取库存';
    }
  }
  // 未拉取时显示 —：显示 0 会被误读成"库存真的是空的"
  const loaded = S.invRows.length > 0;
  $('#kCount').textContent = loaded ? String(pieces) : '—';
  $('#kCountSub').textContent = loaded
    ? `${S.invRows.length} 种 · 当前账号当前游戏`
    : '未拉取库存';

  // 在线 = 当前正持有有效 Steam 会话（session.online），"自动登录"不等于在线
  const online = S.accounts.filter((a) => a.online).length;
  $('#kOnline').innerHTML = `${online}<small> / ${S.accounts.length}</small>`;

  const lc = (S.listings && S.listings.count) || 0;
  $('#kListings').textContent = lc;
  $('#kListSub').textContent = S.listings ? '已同步' : '未同步';

  const d = new Date();
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  $('#ovSub').textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${wd} · ${S.accounts.length} 个账号已绑定`;
}

function renderLogs() {
  const box = $('#logList');
  if (!box) return;
  $('#logCount').textContent = `${S.logs.length} 条`;
  if (!S.logs.length) {
    box.innerHTML = `<div class="empty"><b>暂无操作记录</b>拉取库存、查价、上架都会记在这里</div>`;
    return;
  }
  const toneMap = { g: 'g', r: 'r', a: 'a', b: 'b', n: 'n' };
  box.innerHTML = S.logs.slice(0, 8).map((l) => `<div class="trow">
    <div style="min-width:0"><div class="nm">${esc(l.text)}</div>
    <div class="sub">${new Date(l.at).toLocaleTimeString('zh-CN')}</div></div>
    <div class="amt"><span class="pill ${toneMap[l.tone] || 'n'}">${
      l.tone === 'r' ? '失败' : l.tone === 'g' ? '完成' : l.tone === 'a' ? '注意' : '记录'
    }</span></div>
  </div>`).join('');
}

async function exportReport() {
  const rows = S.invRows;
  if (!rows.length) {
    toast('没有数据可导出', true);
    return;
  }
  // 导出当前筛选后的结果：用户筛出"冷却中"再导出，拿到手的就该是那一批
  const list = viewRows();
  const header = ['物品', '类型', '数量', '可上架', '市场最低', '中位价', '挂单价', '到手/件', '小计', 'assetid'];
  const lines = [header.join(',')].concat(
    list.map((r) => {
      const sub = r.priceYuan > 0 ? r.priceYuan * r.sellableQty : 0;
      return [
        `"${String(r.name || '').replace(/"/g, '""')}"`,
        `"${String(r.type || '').replace(/"/g, '""')}"`,
        r.qty,
        r.sellableQty,
        (r.lowestPrice || 0).toFixed(2),
        (r.medianPrice || 0).toFixed(2),
        (r.priceYuan || 0).toFixed(2),
        netOf(r.priceYuan).toFixed(2),
        sub.toFixed(2),
        `"${r.assets.map((a) => a.assetId).join(' ')}"`,
      ].join(',');
    })
  );
  const csv = '\ufeff' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `steamdesk-inventory-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`报表已导出（${list.length} 种）`);
  log(`导出库存报表：${list.length} 种物品`, 'b');
}

/* ------------------------------- CSV 导出 -------------------------------- */

function csvCell(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

function csvStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 带 BOM 的 UTF-8 CSV，Excel 打开中文不乱码 */
function downloadCsv(filename, header, rows) {
  if (!rows.length) {
    toast('没有数据可导出', true);
    return false;
  }
  const lines = [header.map(csvCell).join(',')].concat(
    rows.map((r) => r.map(csvCell).join(','))
  );
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

function exportFreeCsv() {
  const items = S.free.items || [];
  const rows = items.map((it) => [
    // 和卡片保持一致：去掉数据里带的书名号
    String(it.title || '').replace(/^《(.+)》$/, '$1'),
    FREE_PLAT[it.platform] || it.platform || '',
    it.worth || '',
    it.endAt ? new Date(it.endAt).toLocaleString('zh-CN') : '长期有效',
    it.claimed || (S.free.claimed && S.free.claimed[it.id])
      ? '已领取'
      : S.free.webFallback[it.id]
        ? '自动领取失败，需网页领取'
        : it.upcoming
          ? '即将开始'
          : '可领取',
    it.url || '',
  ]);
  if (downloadCsv(`steamdesk-free-${csvStamp()}.csv`, ['标题', '平台', '原价', '截止时间', '状态', '链接'], rows)) {
    toast(`已导出 ${rows.length} 条免费活动`);
    log(`导出免费活动：${rows.length} 条`, 'b');
  }
}

/* ------------------------------ 成交收益统计 ------------------------------ */

/**
 * 成交记录里的金额币种来自 Steam（2000 + 币种 id）。
 * 账号换过钱包地区时，历史记录里会混着几种币，数值直接相加没有意义，
 * 所以统计只算"当前币种"（最近一笔成交的币种），其余单独提示被排除。
 */
const MH_CUR_SYM = {
  2001: '$', 2002: '£', 2003: '€', 2004: 'CHF ', 2005: '₽', 2006: 'zł ', 2007: 'R$ ',
  2008: '¥', 2009: 'kr ', 2010: 'Rp ', 2011: 'RM ', 2012: '₱ ', 2013: 'S$ ', 2014: '฿ ',
  2015: '₫ ', 2016: '₩ ', 2017: '₺ ', 2018: '₴ ', 2019: 'MX$ ', 2020: 'C$ ', 2021: 'A$ ',
  2022: 'NZ$ ', 2023: '¥', 2024: '₹ ', 2025: 'CLP$ ', 2026: 'S/ ', 2027: 'COL$ ', 2028: 'R ',
  2029: 'HK$ ', 2030: 'NT$ ', 2031: 'SR ', 2032: 'AED ', 2033: 'ARS$ ', 2034: '₪',
  2035: 'Br ', 2036: '₸ ', 2037: 'KD ', 2038: 'QR ', 2039: '₡', 2040: '$U ',
};

function mhFmt(cents, sym) {
  const n = Math.abs(Number(cents) || 0) / 100;
  return (
    (sym || '') +
    n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function mhStatsData() {
  const all = (S.mh.items || []).filter((x) => x.kind === 'sell' || x.kind === 'buy');
  // 记录已按时间倒序，第一笔的币种就是当前钱包币种
  const cur = (all.find((x) => x.currency) || {}).currency || 0;
  const sym = MH_CUR_SYM[cur] || '';
  const items = all.filter((x) => (x.currency || 0) === cur);
  const skipped = all.length - items.length;
  const months = new Map();
  const byItem = new Map();
  let soldN = 0;
  let netCents = 0;
  let buyN = 0;
  let spendCents = 0;
  let firstTime = 0;
  let lastTime = 0;

  for (const x of items) {
    const key = x.time
      ? (() => {
          const d = new Date(x.time * 1000);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        })()
      : '未知';
    let m = months.get(key);
    if (!m) {
      m = { key, sell: 0, net: 0, buy: 0, spend: 0 };
      months.set(key, m);
    }
    if (x.time) {
      if (!firstTime || x.time < firstTime) firstTime = x.time;
      if (x.time > lastTime) lastTime = x.time;
    }
    if (x.kind === 'sell') {
      soldN += 1;
      netCents += x.receivedCents || 0;
      m.sell += 1;
      m.net += x.receivedCents || 0;
      const k = x.name || '未知物品';
      const it = byItem.get(k) || { n: 0, net: 0 };
      it.n += 1;
      it.net += x.receivedCents || 0;
      byItem.set(k, it);
    } else {
      buyN += 1;
      spendCents += x.priceCents || 0;
      m.buy += 1;
      m.spend += x.priceCents || 0;
    }
  }

  // 已实现盈亏：只算「记过成本」的卖出，成本按账号单独记录
  let realizedCents = 0;
  let realizedN = 0;
  const costs = S.costs || {};
  for (const x of items) {
    if (x.kind !== 'sell') continue;
    const rec = x.marketHashName ? costs[x.marketHashName] : null;
    if (!rec || !(rec.cost > 0)) continue;
    realizedCents += (x.receivedCents || 0) - Math.round(rec.cost * 100);
    realizedN += 1;
  }

  return {
    cur,
    sym,
    skipped,
    soldN,
    buyN,
    netCents,
    spendCents,
    cashCents: netCents - spendCents,
    avgCents: soldN ? Math.round(netCents / soldN) : 0,
    realizedCents,
    realizedN,
    firstTime,
    lastTime,
    months: [...months.values()].sort((a, b) => (a.key < b.key ? 1 : -1)),
    top: [...byItem.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.net - a.net)
      .slice(0, 5),
  };
}

/**
 * 按物品汇总"已实现盈亏"：卖出的实际到手 - 记录的成本。
 * 只统计当前币种、且记过成本的物品，用来回答"哪几种东西赚/亏得最多"。
 */
function mhRealizedRankHtml(sym) {
  const cur = (S.mh.items || []).find((x) => x.currency) || null;
  if (!cur) return '';
  const currency = Number(cur.currency) || 0;
  const map = new Map();
  for (const x of S.mh.items || []) {
    if (x.kind !== 'sell' || !x.marketHashName) continue;
    if ((Number(x.currency) || 0) !== currency) continue;
    const rec = (S.costs || {})[x.marketHashName];
    const unit = rec ? Number(rec.cost) || 0 : 0;
    if (!(unit > 0)) continue;
    const received = Number(x.receivedCents) || Number(x.priceCents) || 0;
    const rowData = map.get(x.marketHashName) || {
      name: x.name || x.marketHashName,
      n: 0,
      cents: 0,
    };
    rowData.n += 1;
    rowData.cents += received - Math.round(unit * 100);
    map.set(x.marketHashName, rowData);
  }
  const list = [...map.values()].sort((a, b) => b.cents - a.cents);
  if (!list.length) return '';
  const f = (cents) => mhFmt(cents, sym);
  return `<div class="mh-st-col" style="margin-top:12px">
    <div class="mh-st-t">按物品的已实现盈亏（Top ${Math.min(10, list.length)}）</div>
    ${list
      .slice(0, 10)
      .map(
        (t, i) => `<div class="mh-st-row rank">
        <span class="mh-st-m">${i + 1}. ${esc(t.name)}</span>
        <span>${t.n} 笔</span>
        <span class="${t.cents >= 0 ? 'g' : 'r'}">${t.cents >= 0 ? '+' : '-'}${f(Math.abs(t.cents))}</span>
      </div>`
      )
      .join('')}
  </div>`;
}

function renderMhStats() {
  const box = $('#mhStatsBox');
  if (!box) return;
  if (!S.mhStats) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const rows = ((S.mh.items || []).filter((x) => x.kind === 'sell' || x.kind === 'buy'));
  if (!rows.length) {
    box.style.display = '';
    box.innerHTML = '<div class="mh-stats-empty">还没有成交记录，无法统计</div>';
    return;
  }
  const d = mhStatsData();
  const f = (cents) => mhFmt(cents, d.sym);
  const sign = d.cashCents >= 0 ? '' : '-';
  const span =
    d.firstTime && d.lastTime
      ? `${new Date(d.firstTime * 1000).getFullYear()}–${new Date(d.lastTime * 1000).getFullYear()}`
      : '—';
  const monthRows = d.months
    .slice(0, 12)
    .map(
      (m) => `<div class="mh-st-row">
        <span class="mh-st-m">${esc(m.key)}</span>
        <span>卖 ${m.sell} 笔</span>
        <span class="g">${f(m.net)}</span>
        <span>买 ${m.buy} 笔</span>
        <span class="r">${m.spend ? '-' + f(m.spend) : '—'}</span>
        <span class="b">${m.net - m.spend < 0 ? '-' : ''}${f(m.net - m.spend)}</span>
      </div>`
    )
    .join('');
  const topRows = d.top
    .map(
      (t, i) => `<div class="mh-st-row">
        <span class="mh-st-m">${i + 1}. ${esc(t.name)}</span>
        <span>${t.n} 笔</span>
        <span class="g">${f(t.net)}</span>
      </div>`
    )
    .join('');
  box.style.display = '';
  box.innerHTML = `<div class="mh-st-grid">
      <div class="mh-st-kpi"><div class="k">卖出到手</div><div class="v g">${f(d.netCents)}</div><div class="s">${d.soldN} 笔 · 平均每笔 ${d.soldN ? f(d.avgCents) : '—'}</div></div>
      <div class="mh-st-kpi"><div class="k">买入支出</div><div class="v r">${d.spendCents ? '-' + f(d.spendCents) : f(0)}</div><div class="s">${d.buyN} 笔</div></div>
      <div class="mh-st-kpi"><div class="k">净现金流</div><div class="v ${d.cashCents >= 0 ? 'g' : 'r'}">${sign}${f(Math.abs(d.cashCents))}</div><div class="s">到手 - 买入</div></div>
      <div class="mh-st-kpi"><div class="k">成交笔数</div><div class="v">${d.soldN + d.buyN}</div><div class="s">${span} · 仅统计当前钱包币种</div></div>
    </div>
    <div class="mh-st-cols">
      <div class="mh-st-col">
        <div class="mh-st-t">按月份（最近 12 个有成交的月份）</div>
        ${monthRows || '<div class="mh-st-row">暂无</div>'}
      </div>
      <div class="mh-st-col">
        <div class="mh-st-t">卖出到手排行</div>
        ${topRows || '<div class="mh-st-row">暂无</div>'}
      </div>
    </div>
    ${mhRealizedRankHtml(d.sym)}
    ${d.skipped ? `<div class="mh-st-warn">另有 ${d.skipped} 笔历史成交使用其它币种（账号早期钱包地区不同），未计入以上金额。</div>` : ''}
    ${d.soldN ? `<div class="mh-st-note">已实现盈亏（按你记录的成本）：<b class="${d.realizedN ? (d.realizedCents >= 0 ? 'g' : 'r') : ''}">${
      d.realizedN
        ? `${d.realizedCents >= 0 ? '+' : '-'}${f(Math.abs(d.realizedCents))}`
        : '—'
    }</b> · 覆盖 ${d.realizedN}/${d.soldN} 笔卖出${
      d.realizedN ? '' : '（先在物品详情里记录成本，这里才算得出来）'
    }</div>` : ''}`;
}

function exportHistoryCsv() {
  const items = S.mh.items || [];
  const rows = items.map((x) => [
    x.dateText || (x.time ? new Date(x.time * 1000).toLocaleString('zh-CN') : ''),
    x.kind === 'sell' ? '卖出' : x.kind === 'buy' ? '买入' : '交易',
    x.name || '',
    x.marketHashName || '',
    x.priceText || '',
    x.receivedText || '',
    x.actor || '',
    x.failed ? '交易失败' : '正常',
  ]);
  if (downloadCsv(
    `steamdesk-market-history-${csvStamp()}.csv`,
    ['时间', '类型', '物品', '市场名称', '成交价', '到手', '对手', '状态'],
    rows
  )) {
    toast(`已导出 ${rows.length} 条成交记录`);
    log(`导出成交历史：${rows.length} 条`, 'b');
  }
}

$('#ovExport').onclick = exportReport;
$('#btnRefresh').onclick = async () => {
  await scanAccounts({ quiet: true });
  if ($('.pg[data-p="orders"]').classList.contains('on')) syncOrders({ quiet: true });
  if ($('.pg[data-p="library"]').classList.contains('on')) scanLibrary({ quiet: true });
  toast('已刷新');
};

/* --------------------------------- 启动流程 -------------------------------- */

/* ================= 概览：估值趋势 + 最近成交 ================= */
// 趋势数据存在本地：每次成功拉取库存记一个快照点，不做假的演示曲线
function trendKey() {
  return 'sd_trend_v1';
}
function loadTrend() {
  try {
    const a = JSON.parse(localStorage.getItem(trendKey()) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function pushTrend(value) {
  const v = Number(value);
  // 0 / 非数一律不记：空库存或未查价时写入 0，会把整条曲线拉到地板，
  // 还会把涨跌幅算成 100.0%，看着像数据坏了。
  if (!Number.isFinite(v) || v <= 0) return;

  const a = loadTrend();
  // 同一分钟内重复值跳过，避免快照被灌水
  const last = a[a.length - 1];
  if (last && Math.abs(Number(last.v) - v) < 0.005 && Date.now() - Number(last.t) < 60000) return;

  a.push({ t: Date.now(), v });
  try {
    localStorage.setItem(trendKey(), JSON.stringify(a.slice(-800)));
  } catch { /* ignore */ }
}

/**
 * Catmull-Rom → 三次贝塞尔。
 * 原来的折线是一段段直线连起来的，快照一多就像锯齿；这里做一次平滑，
 * 并把张力压到 0.22，避免曲线穿过两组数据之间产生夸张的"过冲"。
 */
function smoothSvgPath(xs, ys, tension = 0.22) {
  if (!xs.length) return '';
  if (xs.length === 1) return `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  const at = (i) => ({ x: xs[Math.max(0, Math.min(xs.length - 1, i))], y: ys[Math.max(0, Math.min(ys.length - 1, i))] });
  let d = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderTrend(mode) {
  mode = mode || S.trMode || 'h';
  S.trMode = mode;
  const span = mode === 'h' ? 864e5 : mode === 'd' ? 7 * 864e5 : 30 * 864e5;
  const now = Date.now();
  // 兼容历史脏数据：早期版本可能写进 0 值，直接忽略
  const pts = loadTrend()
    .filter((p) => p && Number(p.v) > 0 && now - Number(p.t || 0) <= span);

  const line = $('#trLine');
  const area = $('#trArea');
  const dot = $('#trDot');
  if (!line) return;

  let d = 'M8 130 L592 130';
  let ap = 'M8 130 L592 130 L592 130 L8 130 Z';

  if (pts.length >= 2) {
    const vs = pts.map((p) => Number(p.v) || 0);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const rng = max - min || 1;
    const xs = pts.map((p, i) => 8 + (584 * i) / (pts.length - 1));
    const ys = pts.map((p) => 118 - ((Number(p.v) - min) / rng) * 92);
    d = smoothSvgPath(xs, ys);
    ap = `${d} L${xs[xs.length - 1].toFixed(1)} 130 L${xs[0].toFixed(1)} 130 Z`;
    if (dot) {
      dot.setAttribute('cx', xs[xs.length - 1].toFixed(1));
      dot.setAttribute('cy', ys[ys.length - 1].toFixed(1));
    }
  } else if (dot) {
    dot.setAttribute('cx', '592');
    dot.setAttribute('cy', '130');
  }

  line.setAttribute('d', d);
  if (area) area.setAttribute('d', ap);

  const hint = $('#trHint');
  if (hint) hint.style.display = pts.length >= 2 ? 'none' : 'flex';
  if (dot) dot.style.display = pts.length >= 2 ? '' : 'none';

  // 曲线画完后回写一次 KPI：否则"估值 —"与"趋势有金额"会互相打脸
  if (typeof renderKpi === 'function') renderKpi();

  const cur = pts.length ? Number(pts[pts.length - 1].v) || 0 : 0;
  const big = $('#trBig');
  if (big) big.textContent = '¥' + cur.toFixed(2);

  const pill = $('#trPill');
  if (pill) {
    if (pts.length >= 2) {
      const first = Number(pts[0].v) || 0;
      const diff = first ? ((cur - first) / first) * 100 : 0;
      pill.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% · ${pts.length} 个快照`;
      pill.className = 'pill ' + (diff >= 0 ? 'g' : 'a');
    } else if (pts.length === 1) {
      pill.textContent = '1 个快照';
      pill.className = 'pill n';
    } else {
      pill.textContent = '暂无快照';
      pill.className = 'pill n';
    }
  }

  document.querySelectorAll('[data-tr]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tr === mode);
  });
}

/** 最近成交：没有真实成交数据就诚实显示空态，不编造 */
function renderRecent() {
  const box = $('#recentList');
  if (!box) return;
  const rows = (S.recentSales || []).slice(0, 6);
  if (!rows.length) {
    box.innerHTML = `<div class="empty" style="padding:20px 11px">
      <b>暂无成交记录</b>
      <div style="margin-top:5px;color:var(--muted);font-size:10.5px;line-height:1.6">
        上架并在市场成交后，这里会显示最近成交的物品与金额。<br>
        当前可先去「市场挂单」查看已上架物品。
      </div>
      <div style="margin-top:9px"><button class="btn s" data-go="orders">去看挂单</button></div>
    </div>`;
    return;
  }
  box.innerHTML = rows.map((r) => `<div class="trow">
    <div class="cv" style="position:relative;overflow:hidden;padding:0">
      ${r.iconUrl ? `<img src="${esc(r.iconUrl)}" alt="" style="width:100%;height:100%;object-fit:contain"
        onload="this.parentElement.classList.add('hasimg')" onerror="this.remove()">
        <b class="cvfb">${esc(initial(r.name))}</b>` : `<b class="cvfb">${esc(initial(r.name))}</b>`}
    </div>
    <div style="min-width:0">
      <div class="nm">${esc(r.name)}</div>
      <div class="sub">${esc(r.time || '')}${r.account ? ' · ' + esc(r.account) : ''}</div>
    </div>
    <div class="amt">${money(r.price)}<span class="pill g">已完成</span></div>
  </div>`).join('') + (rows.length < 6 ? `<div class="rfoot">仅显示最近 6 条成交 · 共 ${(S.recentSales || []).length} 条</div>` : '');
}

document.querySelectorAll('[data-tr]').forEach((btn) => {
  btn.addEventListener('click', () => renderTrend(btn.dataset.tr));
});

/* --------------------------- Steam 成交历史（账号本人） ---------------------------
 * 数据来自 Steam 网页端「我的市场历史」，认网页登录 Cookie。
 * 不管物品是在本软件、网页还是手机上卖出的，都会出现在这里。
 */

const MH_PAGE = 50;

function mhFiltered() {
  const st = S.mh;
  return st.kind === 'all' ? st.items : st.items.filter((x) => x.kind === st.kind);
}

function mhAccountLabel() {
  const sid = String(S.mh.steamId || '');
  if (!sid) return '';
  const acc = (S.accounts || []).find((a) => String(a.steamId) === sid);
  const name = acc ? acc.personaName || acc.accountName : `…${sid.slice(-6)}`;
  return `当前读取：<b>${esc(name)}</b> · 含其它软件/网页成交`;
}

function mhRender() {
  const st = S.mh;
  const box = $('#mhList');
  if (!box) return;
  renderMhStats();

  const all = st.items || [];
  const sells = all.filter((x) => x.kind === 'sell').length;
  const buys = all.filter((x) => x.kind === 'buy').length;
  $('#mhTotal').textContent = all.length ? `卖出 ${sells} · 买入 ${buys}` : '';
  $('#mhAcc').innerHTML = mhAccountLabel();

  const list = mhFiltered();
  const pages = Math.max(1, Math.ceil(list.length / MH_PAGE));
  if (st.page >= pages) st.page = pages - 1;
  if (st.page < 0) st.page = 0;
  const rows = list.slice(st.page * MH_PAGE, st.page * MH_PAGE + MH_PAGE);

  $('#mhPage').textContent = list.length ? `${st.page + 1} / ${pages}` : '0 / 0';
  const prev = $('#mhPrev');
  const next = $('#mhNext');
  if (prev) prev.disabled = st.page <= 0;
  if (next) next.disabled = st.page >= pages - 1;

  if (!rows.length) {
    box.innerHTML = `<div class="mh-empty">${
      st.kind === 'sell'
        ? '这个账号还没有卖出记录'
        : st.kind === 'buy'
          ? '这个账号还没有买入记录'
          : '这个账号还没有成交记录'
    }<br><span style="font-size:11px;color:var(--dim)">Steam 只保留最近一段时间的市场历史，更早的记录请在 Steam 网页端查看。</span></div>`;
    return;
  }

  box.innerHTML = rows.map((x) => {
    const kind =
      x.kind === 'sell'
        ? '<span class="mh-kind sell">卖出</span>'
        : x.kind === 'buy'
          ? '<span class="mh-kind buy">买入</span>'
          : '<span class="mh-kind">交易</span>';
    const other = x.actor
      ? `${x.kind === 'buy' ? '卖家' : '买家'} …${String(x.actor).slice(-6)}`
      : '';
    const date = x.dateText || (x.time ? new Date(x.time * 1000).toLocaleDateString('zh-CN') : '');
    return `<div class="mh-row">
      ${iconHtml(x.icon, x.name, 'mh-ico')}
      <div class="mh-main">
        <div class="mh-nm" title="${esc(x.marketHashName || x.name)}">${esc(x.name)}</div>
        <div class="mh-sub">${esc(date)}${other ? ' · ' + esc(other) : ''}${
          x.failed ? ' · <span style="color:var(--amber)">交易失败</span>' : ''
        }</div>
      </div>
      ${kind}
      <div class="mh-price">${esc(x.priceText || '—')}${
        x.receivedText ? `<small>到手 ${esc(x.receivedText)}</small>` : ''
      }</div>
    </div>`;
  }).join('');
}

async function mhLoad(force) {
  const st = S.mh;
  if (st.loading) return;
  st.loading = true;
  st.error = '';
  const box = $('#mhList');
  if (box) box.innerHTML = '<div class="mh-empty">正在读取 Steam 成交历史…<br>记录多的账号要等几秒。</div>';
  $('#mhPage').textContent = '…';
  $('#mhPrev').disabled = true;
  $('#mhNext').disabled = true;

  const r = await call(SD.market.myHistory(!!force), { noLog: true, silent: true });
  st.loading = false;
  if (!r.ok) {
    st.items = [];
    st.error = r.message || '读取失败';
    if (box) box.innerHTML = `<div class="mh-empty">${esc(st.error)}</div>`;
    $('#mhTotal').textContent = '';
    $('#mhAcc').innerHTML = '';
    $('#mhPage').textContent = '0 / 0';
    return;
  }
  const d = r.data || {};
  st.items = d.items || [];
  st.total = Number(d.total) || st.items.length;
  st.truncated = !!d.truncated;
  st.steamId = d.steamId || '';
  st.at = d.at || Date.now();
  st.page = 0;
  // 收益统计里的「已实现盈亏」要用这个账号的成本记录
  if (st.steamId) await loadCosts(st.steamId);
  mhRender();
}

function mhOpenModal() {
  const m = $('#mhModal');
  if (!m) return;
  m.classList.add('on');
  // 5 分钟内的缓存直接用；过期或首次打开就重新读
  if (!S.mh.items.length || Date.now() - (S.mh.at || 0) > 5 * 60 * 1000) mhLoad(false);
  else mhRender();
}

function mhCloseModal() {
  const m = $('#mhModal');
  if (m) m.classList.remove('on');
}

if ($('#mhOpen')) $('#mhOpen').onclick = () => mhOpenModal();
if ($('#mhExport')) $('#mhExport').onclick = exportHistoryCsv;
if ($('#mhStats')) {
  $('#mhStats').onclick = () => {
    S.mhStats = !S.mhStats;
    $('#mhStats').classList.toggle('on', S.mhStats);
    renderMhStats();
  };
}
if ($('#mhClose')) $('#mhClose').onclick = () => mhCloseModal();
if ($('#mhClose2')) $('#mhClose2').onclick = () => mhCloseModal();
if ($('#mhRefresh')) $('#mhRefresh').onclick = () => mhLoad(true);
if ($('#mhPrev')) $('#mhPrev').onclick = () => { S.mh.page -= 1; mhRender(); };
if ($('#mhNext')) $('#mhNext').onclick = () => { S.mh.page += 1; mhRender(); };
if ($('#mhKind')) {
  $('#mhKind').addEventListener('click', (e) => {
    const t = e.target.closest('[data-kind]');
    if (!t) return;
    S.mh.kind = t.dataset.kind;
    S.mh.page = 0;
    $$('#mhKind .tab').forEach((b) => b.classList.toggle('on', b === t));
    mhRender();
  });
}
if ($('#mhModal')) {
  $('#mhModal').addEventListener('click', (e) => {
    if (e.target === $('#mhModal')) mhCloseModal();
  });
}

/* -------------------------------- 账号体检 -------------------------------- */

let healthBusy = false;
let healthRows = [];
const healthQueue = { running: false, stop: false };

function healthOpen() {
  const m = $('#healthModal');
  if (!m) return;
  m.classList.add('on');
  healthWatchRefresh();
  if (!healthBusy) runHealth();
}

async function healthWatchRefresh() {
  const r = await call(SD.health.state(), { silent: true, noLog: true });
  if (r.ok && $('#healthWatch')) $('#healthWatch').checked = !!(r.data && r.data.watch);
}

function healthClose() {
  const m = $('#healthModal');
  if (m) m.classList.remove('on');
}

function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function runHealth() {
  const body = $('#healthBody');
  if (!body || healthBusy || healthQueue.running) return;
  healthBusy = true;
  body.innerHTML = '<div class="health-empty">正在逐个检查账号的网页会话，<br>账号多的需要十几秒…</div>';
  const pill = $('#healthPill');
  if (pill) pill.textContent = '检查中';
  const r = await call(SD.health.check(), { silent: true, noLog: true });
  healthBusy = false;
  if (!r.ok) {
    body.innerHTML = `<div class="health-empty">${esc(r.message || '检查失败')}</div>`;
    if (pill) pill.textContent = '失败';
    return;
  }
  const d = r.data || {};
  const rows = d.rows || [];
  healthRows = rows;
  if (pill) {
    pill.textContent = `${d.ok || 0}/${d.total || 0} 可用` + (d.restricted ? ` · ${d.restricted} 个市场受限` : '');
  }
  const batchBtn = $('#healthBatchLogin');
  if (batchBtn) {
    const queued = rows.filter((a) => !a.ok && (!a.cookie || !a.cookie.network)).length;
    batchBtn.style.display = queued ? '' : 'none';
    batchBtn.textContent = healthQueue.running ? batchBtn.textContent : `登录缺失的 ${queued} 个账号`;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="health-empty">没有找到本地账号</div>';
    return;
  }
  body.innerHTML =
    `<div class="health-row head"><span>账号</span><span>网页会话</span><span>手机令牌</span><span>自动登录</span><span></span></div>` +
    rows
      .map(
        (a) => `<div class="health-row">
      <div class="health-nm"><b title="${esc(a.accountName || a.name)}">${esc(a.name)}</b>${
        a.online ? '<span class="pill g" style="font-size:9.5px">当前登录</span>' : ''
      }</div>
      <div class="health-state" title="${esc(
        (a.cookie ? a.cookie.text : '') + (a.market ? `；市场：${a.market.text}` : '')
      )}">
        <i class="health-dot ${a.ok && !(a.market && a.market.restricted) ? 'ok' : 'bad'}"></i>
        <span>${esc(
          a.market && a.market.restricted
            ? `市场受限：${a.market.text}`
            : a.ok
            ? '会话有效'
            : a.cookie
            ? a.cookie.text
            : '没有保存的网页会话（只能读公开库存）'
        )}</span>
      </div>
      <span style="color:${a.guard ? 'var(--green)' : 'var(--dim)'}">${a.guard ? '已导入' : '未导入'}</span>
      <span style="color:${a.autoLogin ? 'var(--green)' : 'var(--dim)'}">${a.autoLogin ? '已开启' : '未开启'}</span>
      <button class="btn s" data-hlogin="${esc(a.steamId)}" style="height:24px;padding:0 8px;font-size:11px">${
        a.ok ? '重新登录' : '登录'
      }</button>
    </div>`
      )
      .join('');
  log(`账号体检：${d.ok}/${d.total} 个会话有效`, d.ok === d.total ? 'g' : 'a');
}

/**
 * 批量登录：按体检结果逐个打开网页登录窗。
 * 一次只开一个——多个登录窗同时抢 Steam 的登录态，先登录的会被后一个顶掉。
 */
async function healthLoginMissing() {
  const btn = $('#healthBatchLogin');
  if (healthQueue.running) {
    healthQueue.stop = true;
    if (btn) btn.textContent = '正在停止…';
    return;
  }
  // 网络超时的号不代表 Cookie 失效，重登也解决不了，先排除
  const missing = healthRows.filter((a) => !a.ok && (!a.cookie || !a.cookie.network));
  const offline = healthRows.filter((a) => !a.ok && a.cookie && a.cookie.network).length;
  if (!missing.length) {
    toast(offline ? '网络不通，无法判断会话；先检查 Steam 社区能否打开' : '所有账号的网页会话都有效', true);
    return;
  }
  if (offline) log(`批量登录：${offline} 个账号是网络超时，已跳过（不是会话失效）`, 'a');
  healthQueue.running = true;
  healthQueue.stop = false;
  const pill = $('#healthPill');
  let done = 0;
  let stopped = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '停止排队';
  }
  for (let i = 0; i < missing.length; i++) {
    if (healthQueue.stop) {
      stopped = true;
      break;
    }
    const a = missing[i];
    if (btn) btn.textContent = `停止（${i + 1}/${missing.length}）`;
    if (pill) pill.textContent = `登录中 ${i + 1}/${missing.length}`;
    status(`批量登录 ${i + 1}/${missing.length}：${a.name}`);
    try {
      await openWebLogin(a.steamId);
      done++;
    } catch {
      /* 单个失败继续下一个 */
    }
    if (i < missing.length - 1) await new Promise((r) => setTimeout(r, 800));
  }
  healthQueue.running = false;
  healthQueue.stop = false;
  if (btn) btn.textContent = '登录缺失的账号';
  if (pill) pill.textContent = '重新检查中';
  toast(
    stopped
      ? `已停止：处理了 ${done}/${missing.length} 个账号`
      : `批量登录结束：处理了 ${done}/${missing.length} 个账号`
  );
  log(`批量登录：处理 ${done}/${missing.length} 个账号`, 'g');
  if ($('#healthModal') && $('#healthModal').classList.contains('on')) runHealth();
}

if ($('#accHealth')) $('#accHealth').onclick = () => healthOpen();
if ($('#healthBatchLogin')) $('#healthBatchLogin').onclick = () => healthLoginMissing();
if ($('#healthClose')) $('#healthClose').onclick = () => healthClose();
if ($('#healthClose2')) $('#healthClose2').onclick = () => healthClose();
if ($('#healthRun')) $('#healthRun').onclick = () => runHealth();
if ($('#healthModal')) {
  $('#healthModal').addEventListener('click', (e) => {
    if (e.target === $('#healthModal')) healthClose();
  });
  $('#healthModal').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hlogin]');
    if (!b) return;
    if (healthQueue.running) {
      toast('批量登录队列正在运行，先停止再单独登录', true);
      return;
    }
    const sid = b.dataset.hlogin;
    b.disabled = true;
    b.textContent = '登录中…';
    await openWebLogin(sid);
    if ($('#healthModal').classList.contains('on')) runHealth();
  });
}

if ($('#healthWatch')) {
  $('#healthWatch').onchange = async () => {
    const on = $('#healthWatch').checked;
    const r = await call(SD.health.setWatch(on), { silent: true });
    if (r.ok) toast(on ? '已开启每 3 小时自动巡检' : '已关闭自动巡检');
  };
}
if (SD.health.onAlert) {
  SD.health.onAlert(() => {
    healthOpen();
    toast('有账号的网页会话失效了，请重新登录', true);
  });
}

/* -------------------------------- 库存变动 -------------------------------- */

let watchBusy = false;

async function watchRefresh() {
  const list = $('#watchList');
  if (!list) return;
  const r = await call(SD.watch.state(), { silent: true, noLog: true });
  if (!r.ok) {
    list.innerHTML = `<div class="watch-empty">${esc(r.message || '读取失败')}</div>`;
    return;
  }
  const d = r.data || {};
  const toggle = $('#watchEnabled');
  if (toggle) toggle.checked = !!d.enabled;
  const pill = $('#watchPill');
  if (pill) pill.textContent = d.enabled ? '监控中' : '已关闭';
  const meta = $('#watchMeta');
  if (meta) {
    meta.textContent = d.at
      ? `上次检查 ${fmtWhen(d.at)} · 已记录 ${d.accounts} 个账号 · 每 6 小时一次`
      : '还没有拍过快照：软件启动 2 分钟后会自动建立基线，第一次只记基线、不提醒';
  }
  const changes = d.changes || [];
  if (!changes.length) {
    list.innerHTML =
      '<div class="watch-empty">还没有检测到库存变动<br><span style="font-size:11px;color:var(--dim)">每 6 小时对比一次；卖出、被交易走或挂单成交都会出现在这里</span></div>';
    return;
  }
  list.innerHTML =
    '<div class="watch-row head"><span>时间</span><span>物品</span><span>账号</span><span style="text-align:right">变动</span></div>' +
    changes
      .map(
        (c) => `<div class="watch-row">
        <span class="wt">${fmtWhen(c.at)}</span>
        <span class="wn" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="wn" style="color:var(--muted)">${esc(c.account || '')}</span>
        <span class="wd ${c.delta > 0 ? 'up' : 'down'}" style="text-align:right">${c.delta > 0 ? '+' : ''}${c.delta}</span>
      </div>`
      )
      .join('');
}

async function watchOpen() {
  const m = $('#watchModal');
  if (!m) return;
  m.classList.add('on');
  await watchRefresh();
}

function watchClose() {
  const m = $('#watchModal');
  if (m) m.classList.remove('on');
}

async function watchRunNow() {
  if (watchBusy) return;
  watchBusy = true;
  const list = $('#watchList');
  const btn = $('#watchRun');
  if (btn) btn.disabled = true;
  if (list) list.innerHTML = '<div class="watch-empty">正在逐个账号读取库存并对比，<br>账号多时要等一两分钟…</div>';
  const r = await call(SD.watch.run(true), { silent: true });
  watchBusy = false;
  if (btn) btn.disabled = false;
  if (!r.ok) {
    toast(r.message || '检查失败', true);
  } else {
    const d = r.data || {};
    if (d.skipped) toast(d.reason || '本次没有检查', true);
    else if (d.baseline) toast(`已建立基线（${d.accounts} 个账号）`);
    else toast(d.changes && d.changes.length ? `发现 ${d.changes.length} 项库存变动` : '没有发现库存变动');
  }
  await watchRefresh();
}

if ($('#invWatchBtn')) $('#invWatchBtn').onclick = () => watchOpen();
if ($('#watchClose')) $('#watchClose').onclick = () => watchClose();
if ($('#watchClose2')) $('#watchClose2').onclick = () => watchClose();
if ($('#watchRun')) $('#watchRun').onclick = () => watchRunNow();
if ($('#watchEnabled')) {
  $('#watchEnabled').onchange = async () => {
    const on = $('#watchEnabled').checked;
    const r = await call(SD.watch.setEnabled(on), { silent: true });
    if (r.ok) {
      toast(on ? '已启用库存变动监控' : '已关闭库存变动监控');
      watchRefresh();
    }
  };
}
if ($('#watchModal')) {
  $('#watchModal').addEventListener('click', (e) => {
    if (e.target === $('#watchModal')) watchClose();
  });
}

/* -------------------------------- 自动补货 -------------------------------- */

let restockBusy = false;

async function restockRefresh() {
  const list = $('#restockList');
  if (!list) return;
  const r = await call(SD.restock.state(), { silent: true, noLog: true });
  if (!r.ok) {
    list.innerHTML = `<div class="watch-empty">${esc(r.message || '读取失败')}</div>`;
    return;
  }
  const d = r.data || {};
  if ($('#restockEnabled')) $('#restockEnabled').checked = !!d.enabled;
  if ($('#restockCap')) $('#restockCap').value = d.dailyCap;
  if ($('#restockPer')) $('#restockPer').value = d.maxPerRun;
  const pill = $('#restockPill');
  if (pill) pill.textContent = d.enabled ? (d.monitoring ? '检查中' : '已开启') : '已关闭';
  const meta = $('#restockMeta');
  if (meta) {
    const today = `今天已补 ${d.usedToday || 0}/${d.dailyCap || 0} 件`;
    meta.textContent = d.lastAt
      ? `上次检查 ${fmtWhen(d.lastAt)} · ${today} · 每 ${d.intervalMin} 分钟一次`
      : `还没有检查过 · ${today}`;
  }
  const log = d.log || [];
  if (!log.length) {
    list.innerHTML =
      '<div class="watch-empty">还没有补货记录<br><span style="font-size:11px;color:var(--dim)">开启后，成交记录里出现新的卖出时才会自动重新上架</span></div>';
    return;
  }
  list.innerHTML =
    '<div class="watch-row head"><span>时间</span><span>物品</span><span style="text-align:right">价格</span><span style="text-align:right">结果</span></div>' +
    log
      .map((l) => {
        const cls = l.status === 'listed' ? 'up' : l.status === 'failed' ? 'down' : '';
        const txt = l.status === 'listed' ? '已补' : l.status === 'failed' ? '失败' : '跳过';
        return `<div class="watch-row">
        <span class="wt">${fmtWhen(l.at)}</span>
        <span class="wn" title="${esc(l.name)}">${esc(l.name)}</span>
        <span class="wn" style="text-align:right;font-variant-numeric:tabular-nums">${
          l.priceYuan ? money(l.priceYuan) : ''
        }</span>
        <span class="wd ${cls}" style="text-align:right">${txt}</span>
      </div>`;
      })
      .join('');
}

function restockOpen() {
  const m = $('#restockModal');
  if (!m) return;
  m.classList.add('on');
  restockRefresh();
}

function restockClose() {
  const m = $('#restockModal');
  if (m) m.classList.remove('on');
}

async function restockRunNow() {
  if (restockBusy) return;
  restockBusy = true;
  const btn = $('#restockRun');
  if (btn) btn.disabled = true;
  const list = $('#restockList');
  if (list) list.innerHTML = '<div class="watch-empty">正在读取最新成交记录与库存，需要十几秒…</div>';
  const r = await call(SD.restock.run(true), { silent: true });
  restockBusy = false;
  if (btn) btn.disabled = false;
  if (!r.ok) toast(r.message || '检查失败', true);
  else {
    const d = r.data || {};
    if (d.baseline) toast('已建立基线：从现在开始的成交才会自动补货');
    else if (d.skipped) toast(d.reason || '本次没有检查', true);
    else if (!d.sales) toast('最近没有新的成交记录');
    else if (d.reason) toast(d.reason, true);
    else toast(d.listed ? `已补货 ${d.listed} 件` : '有成交，但没有可补的同款库存', !d.listed);
  }
  await restockRefresh();
  if (r.ok && r.data && r.data.listed) syncOrders({ quiet: true });
}

if ($('#ordRestockBtn')) $('#ordRestockBtn').onclick = () => restockOpen();
if ($('#restockClose')) $('#restockClose').onclick = () => restockClose();
if ($('#restockClose2')) $('#restockClose2').onclick = () => restockClose();
if ($('#restockRun')) $('#restockRun').onclick = () => restockRunNow();
if ($('#restockEnabled')) {
  $('#restockEnabled').onchange = async () => {
    const on = $('#restockEnabled').checked;
    const r = await call(SD.restock.setEnabled(on), { silent: true });
    if (r.ok) {
      toast(on ? '已开启自动补货（只对当前网页登录账号生效）' : '已关闭自动补货');
      if (on) log('自动补货已开启：卖出后会自动用库存里的同款按最低价补上', 'b');
      restockRefresh();
    }
  };
}
const restockSaveOptions = async () => {
  const patch = {
    restockDailyCap: Math.max(0, Number($('#restockCap').value) || 0),
    restockMaxPerRun: Math.max(1, Number($('#restockPer').value) || 1),
  };
  const r = await call(SD.settings.set(patch), { silent: true });
  if (r.ok) {
    S.settings = r.data;
    toast('补货上限已保存');
    restockRefresh();
  }
};
if ($('#restockCap')) $('#restockCap').onchange = restockSaveOptions;
if ($('#restockPer')) $('#restockPer').onchange = restockSaveOptions;
if ($('#restockModal')) {
  $('#restockModal').addEventListener('click', (e) => {
    if (e.target === $('#restockModal')) restockClose();
  });
}

/* -------------------------------- 经营报表 -------------------------------- */

let reportDays = 14;
let reportBusy = false;
let reportData = null;
let reportView = 'day';

/** 其它币种不参与合计，但要在说明里列出来，不能静默丢掉 */
function reportCurrencyNote(d) {
  const list = (d.byCurrency || []).filter((x) => Number(x.currency) !== Number(d.currency));
  if (!list.length) return '';
  return (
    ' · 其它币种：' +
    list
      .slice(0, 3)
      .map((x) => `${x.sym} 卖 ${x.sellN} 件 / 到手 ${reportMoney(x.sym, x.received)}`)
      .join('，')
  );
}

function reportMoney(sym, n) {
  return `${sym || '¥'}${(Number(n) || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function reportLoad() {
  if (reportBusy) return;
  reportBusy = true;
  const list = $('#reportList');
  const sum = $('#reportSum');
  const pill = $('#reportPill');
  if (pill) pill.textContent = '生成中';
  if (sum) sum.innerHTML = '';
  if (list) list.innerHTML = '<div class="watch-empty">正在读取成交历史并汇总…</div>';
  const r = await call(SD.reports.get(reportDays), { silent: true });
  reportBusy = false;
  if (!r.ok) {
    if (pill) pill.textContent = '失败';
    if (list) list.innerHTML = `<div class="watch-empty">${esc(netText(r.message) || '生成失败')}</div>`;
    return;
  }
  reportData = r.data || {};
  if (pill) pill.textContent = `近 ${reportData.days} 天`;
  renderReport();
}

/** 按当前视图渲染报表正文（数据已在 reportData） */
function renderReport() {
  const d = reportData || {};
  const list = $('#reportList');
  const sum = $('#reportSum');
  const sym = d.sym || '¥';
  if (!list) return;
  if (reportView === 'app') {
    renderReportByApp(d, sym);
    return;
  }
  const t = d.totals || {};
  const profitCls = (t.realized || 0) >= 0 ? 'g' : 'r';
  if (sum) {
    sum.innerHTML = `
      <div class="rs"><span>卖出件数</span><b>${t.sellN || 0}</b></div>
      <div class="rs"><span>挂单流水</span><b>${reportMoney(sym, t.gross)}</b></div>
      <div class="rs"><span>实际到手</span><b class="g">${reportMoney(sym, t.received)}</b></div>
      <div class="rs"><span>手续费</span><b>${reportMoney(sym, t.fee)}</b></div>
      <div class="rs"><span>已实现盈亏</span><b class="${profitCls}">${
        (t.realized || 0) >= 0 ? '+' : '-'
      }${reportMoney(sym, Math.abs(t.realized || 0))}</b></div>`;
  }
  const w = d.week || {};
  const pw = d.prevWeek || {};
  // 成交速度：近 7 天的件数与日均，比单看总量更能判断压货有没有在动
  const v7 = (d.rows || []).slice(-7).reduce((s, r) => s + (Number(r.sellN) || 0), 0);
  const acc = $('#reportAcc');
  if (acc) {
    acc.textContent = `${d.steamId ? '尾号 ' + String(d.steamId).slice(-6) : ''} · 本周 ${
      w.sellN || 0
    } 件 / 到手 ${reportMoney(sym, w.received)} · 上周 ${pw.sellN || 0} 件 / 到手 ${reportMoney(
      sym,
      pw.received
    )}${d.holdSamples ? ` · 平均持有 ${d.holdDays} 天（${d.holdSamples} 笔）` : ''} · 近 7 天成交 ${v7} 件（日均 ${(
      v7 / 7
    ).toFixed(1)} 件）${reportCurrencyNote(d)}`;
  }
  const rows = (d.rows || []).slice().reverse();
  if (!rows.some((x) => x.sellN || x.buyN)) {
    if (list) list.innerHTML = '<div class="watch-empty">这段时间没有成交记录</div>';
    return;
  }
  const body = rows
    .map(
      (x) => `<div class="report-row">
      <span>${esc(x.date)}</span>
      <span class="n">${x.sellN || 0}</span>
      <span class="n">${x.gross ? reportMoney(sym, x.gross) : '—'}</span>
      <span class="n">${x.received ? reportMoney(sym, x.received) : '—'}</span>
      <span class="n">${x.fee ? reportMoney(sym, x.fee) : '—'}</span>
      <span class="n">${x.spend ? reportMoney(sym, x.spend) : '—'}</span>
      <span class="n ${x.realized >= 0 ? 'g' : 'r'}">${
        x.realizedN ? `${x.realized >= 0 ? '+' : '-'}${reportMoney(sym, Math.abs(x.realized))}` : '—'
      }</span>
    </div>`
    )
    .join('');
  list.innerHTML =
    `<div class="report-row head"><span>日期</span><span class="n">卖出</span><span class="n">流水</span>` +
    `<span class="n">到手</span><span class="n">手续费</span><span class="n">买入支出</span><span class="n">已实现盈亏</span></div>` +
    body;
}

/** 按游戏/品类汇总，直接看哪个游戏在赚钱 */
function renderReportByApp(d, sym) {
  const list = $('#reportList');
  const sum = $('#reportSum');
  if (!list) return;
  const t = d.totals || {};
  if (sum) {
    sum.innerHTML = `
      <div class="rs"><span>涉及游戏</span><b>${(d.byApp || []).length}</b></div>
      <div class="rs"><span>卖出件数</span><b>${t.sellN || 0}</b></div>
      <div class="rs"><span>实际到手</span><b class="g">${reportMoney(sym, t.received)}</b></div>
      <div class="rs"><span>已实现盈亏</span><b class="${(t.realized || 0) >= 0 ? 'g' : 'r'}">${
        (t.realized || 0) >= 0 ? '+' : '-'
      }${reportMoney(sym, Math.abs(t.realized || 0))}</b></div>`;
  }
  const acc = $('#reportAcc');
  if (acc) {
    acc.textContent = `${d.steamId ? '尾号 ' + String(d.steamId).slice(-6) : ''} · 按游戏汇总（近 ${
      d.days || 14
    } 天）${d.holdSamples ? ` · 平均持有 ${d.holdDays} 天` : ''} · 已实现盈亏只统计有成本记录的卖出${reportCurrencyNote(d)}`;
  }
  const rows = (d.byApp || []).filter((x) => x.sellN || x.buyN);
  if (!rows.length) {
    list.innerHTML = '<div class="watch-empty">这段时间没有成交记录</div>';
    return;
  }
  const body = rows
    .map(
      (x) => `<div class="report-row byapp">
      <span title="appid ${x.appId}">${esc(appNameOf(x.appId) || 'App ' + x.appId)}</span>
      <span class="n">${x.sellN || 0}</span>
      <span class="n">${x.gross ? reportMoney(sym, x.gross) : '—'}</span>
      <span class="n">${x.received ? reportMoney(sym, x.received) : '—'}</span>
      <span class="n">${x.fee ? reportMoney(sym, x.fee) : '—'}</span>
      <span class="n ${x.realized >= 0 ? 'g' : 'r'}">${
        x.realizedN ? `${x.realized >= 0 ? '+' : '-'}${reportMoney(sym, Math.abs(x.realized))}` : '—'
      }</span>
    </div>`
    )
    .join('');
  list.innerHTML =
    `<div class="report-row head byapp"><span>游戏</span><span class="n">卖出</span><span class="n">流水</span>` +
    `<span class="n">到手</span><span class="n">手续费</span><span class="n">已实现盈亏</span></div>` +
    body;
}

function reportOpen() {
  const m = $('#reportModal');
  if (!m) return;
  m.classList.add('on');
  reportLoad();
}

function reportClose() {
  const m = $('#reportModal');
  if (m) m.classList.remove('on');
}

if ($('#ovReport')) $('#ovReport').onclick = () => reportOpen();
if ($('#reportClose')) $('#reportClose').onclick = () => reportClose();
if ($('#reportClose2')) $('#reportClose2').onclick = () => reportClose();
if ($('#reportReload')) $('#reportReload').onclick = () => reportLoad();
if ($('#reportExport')) {
  $('#reportExport').onclick = async () => {
    if (!reportData) {
      toast('先等报表加载完成', true);
      return;
    }
    const r = await call(SD.reports.export(reportDays), { silent: true });
    if (!r.ok) toast(r.message || '导出失败', true);
    else if (r.data && r.data.canceled) {
      /* 用户取消 */
    } else toast('报表已导出');
  };
}
if ($('#reportRange')) {
  $('#reportRange').addEventListener('click', (e) => {
    const t = e.target.closest('[data-days]');
    if (!t) return;
    $$('#reportRange .tab').forEach((b) => b.classList.toggle('on', b === t));
    reportDays = Number(t.dataset.days) || 14;
    reportLoad();
  });
}

if ($('#reportView')) {
  $('#reportView').addEventListener('click', (e) => {
    const t = e.target.closest('[data-view]');
    if (!t) return;
    $$('#reportView .tab').forEach((b) => b.classList.toggle('on', b === t));
    reportView = t.dataset.view === 'app' ? 'app' : 'day';
    if (reportData) renderReport();
  });
}
if ($('#reportModal')) {
  $('#reportModal').addEventListener('click', (e) => {
    if (e.target === $('#reportModal')) reportClose();
  });
}

/** 库存页游戏下拉：进入页面时按注册表 + 本地库填充（含"所有支持市场的游戏"） */
async function ensureInvAppOptions(force) {
  const sel = $('#invApp');
  if (!sel) return;
  if (!force && sel.dataset.filled === '1' && sel.options.length > 1) return;

  let opts = [];
  try {
    const reg = await call(SD.library.registry(), { silent: true, noLog: true });
    if (reg.ok && Array.isArray(reg.data)) opts = reg.data;
  } catch { /* ignore */ }
  if (!opts.length && S.lib && S.lib.length) {
    opts = S.lib.map((g) => ({ appId: g.appId, name: g.name, ctx: g.ctx }));
  }
  if (!opts.length) {
    opts = [
      { appId: 753, name: 'Steam 本体（卡牌/背景/表情）' },
      { appId: 730, name: 'Counter-Strike 2' },
      { appId: 570, name: 'Dota 2' },
      { appId: 440, name: 'Team Fortress 2' },
    ];
  }

  // 先记下"不支持社区市场"的 app，再从下拉里剔除。
  // 用户明确要求：游戏不支持的别留在列表里，点进去只会报错。
  const deadIds = new Set(
    opts.filter((o) => o.noMarket).map((o) => Number(o.appId)).filter(Boolean)
  );
  opts = opts.filter((o) => !o.noMarket);

  // 用户自己添加过的 AppID 也要一直在下拉里（永久保存，重启还在）
  try {
    const st = await call(SD.settings.get(), { silent: true, noLog: true });
    const custom = (st.ok && st.data && Array.isArray(st.data.customApps)) ? st.data.customApps : [];
    for (const c of custom) {
      const cid = Number(c.appId);
      if (!cid || deadIds.has(cid)) continue;
      // 添加时探测过市场、明确没有在售商品的自定义 app 也不再列出
      if (c.tradeable === false) continue;
      if (!opts.some((o) => Number(o.appId) === cid)) {
        opts.push({ appId: cid, name: c.name || `App ${cid}` });
      }
    }
  } catch { /* ignore */ }

  // 库里已有的排前面，其余按注册表顺序留在后面——"所有支持市场的游戏"都能选
  const ownedIds = new Set((S.lib || []).map((g) => Number(g.appId)));
  const owned = opts.filter((o) => ownedIds.has(Number(o.appId)));
  const rest = opts.filter((o) => !ownedIds.has(Number(o.appId)));
  const ordered = owned.concat(rest);

  sel.innerHTML = ordered
    .map((o) => `<option value="${o.appId}">${esc(o.name)} (${o.appId})</option>`)
    .join('');
  sel.dataset.filled = '1';
  if (S.invAppId) sel.value = String(S.invAppId);
}

async function boot() {
  renderLogs();
  renderKpi();
  await loadInfo();

  const acc = await call(SD.accounts.list(), { silent: true, noLog: true });
  if (acc.ok) {
    applyAccounts(acc.data);
    await markSessions();
    renderAccounts();
    renderQuickAcc();
    renderCurrentBadge();
    ensureAvatars();
    renderKpi();

    // 填充库存页的账号下拉
    $('#invAcc').innerHTML =
      S.accounts
        .map((a) => `<option value="${esc(a.steamId)}">${esc(a.personaName || a.accountName)}</option>`)
        .join('') +
      (S.accounts.length > 1 ? '<option value="__all__">全部账号（汇总）</option>' : '');
    if (S.currentSteamId) $('#invAcc').value = S.currentSteamId;
  }

  setSwitchState('空闲', '切换会关闭 Steam 客户端后重写配置');
  status('就绪');

  // Epic / GOG 登录态（免费领取页用）：失败不影响主流程
  loadEpicStatus().catch(() => {});
  loadGogAccount().catch(() => {});
  loadPriceAlerts().catch(() => {});

  if (!S.accounts.length) {
    log('没有检测到本地 Steam 账号，请检查 Steam 路径', 'a');
  }

  // 概览页：趋势图与最近成交（有数据画曲线，没数据显式提示，不留空白盒）
  renderTrend();
  renderRecent();
  renderOverviewOrders();
  renderCostOverview();
  renderTodo();
  renderTasks();
  noticesRefresh(false);
  refreshUndoBtn();
  loadWebPrices();
  setInterval(() => {
    noticesRefresh(false);
    loadWebPrices();
  }, 60 * 1000);

  // 库存页游戏下拉：开机就先填满，避免用户点进去看到空白下拉
  ensureInvAppOptions();

  // 初始化挂机行情与商店提醒
  loadIdleGames();
  renderStoreAlerts();

  // 手机令牌状态：已导入就在按钮上标出来，并在日志里说明可自动确认
  refreshGuardStatus().catch(() => {});

  // 托盘 / 菜单跳转
  if (SD.app.onNavigate) SD.app.onNavigate((page) => { if (page) goto(page); });
  if (SD.app.onTrayHint) {
    SD.app.onTrayHint(() =>
      toast('SteamDesk 已最小化到右下角托盘，点击托盘图标可重新打开')
    );
  }
  // Epic 游戏库分批推送：先出已缓存的条目，剩余的在后台补封面时陆续出现
  if (SD.epic && SD.epic.onLibraryBatch) {
    SD.epic.onLibraryBatch((d) => {
      if (!d || !Array.isArray(d.items)) return;
      if (S.epicLib.accountId && d.accountId && d.accountId !== S.epicLib.accountId) return;
      S.epicLib.items = d.items;
      S.epicLib.partial = !d.done;
      if (S.libSource === 'epic') {
        const sub = $('#libSub');
        if (sub) {
          sub.textContent = d.done
            ? `Epic 库 · ${d.items.length} 个游戏`
            : `Epic 库 · 已加载 ${d.items.length} 个（读取中…）`;
        }
        if (d.items.length) renderForeignLib();
      }
    });
  }

  // 启动自动检测：恢复登录态 → 游戏库 → 我的挂单 → 上次的库存
  autoDetectOnStartup();

  // 首次使用向导：只自动弹一次，之后从设置抽屉手动打开
  if (!BOOT_PAGE && S.settings && S.settings.wizardDone !== true) {
    setTimeout(() => wizardOpen(0), 900);
  }
}

let autoDetectRan = false;

async function autoDetectOnStartup() {
  if (autoDetectRan) return;
  autoDetectRan = true;

  let loggedIn = false;
  try {
    const rs = await call(SD.session.restore(S.currentSteamId), { silent: true, noLog: true });
    loggedIn = Boolean(rs.ok && rs.data && rs.data.loggedIn);
    if (loggedIn) {
      const src = rs.data.source === 'restored' ? '已从本地凭据恢复' : '已保持';
      log(`Steam 登录态${src}，无需重新登录`, 'g');
      await markSessions();
      renderAccounts();
      renderQuickAcc();
      renderCurrentBadge();
      renderKpi();
    }
  } catch { /* ignore */ }

  if (!loggedIn) {
    if (S.currentSteamId) {
      log('未检测到有效的 Steam 登录态。到「账号管理」网页登录一次后，之后打开会自动记住。', 'a');
    }
    return;
  }

  const steamId = S.currentSteamId;
  if (!steamId) return;

  // 1) 本地已安装
  scanLibrary({ quiet: true }).catch(() => {});

  // 2) 在线完整已拥有列表（登录态内自动取，不需要 Key）
  call(SD.library.owned(steamId), { silent: true, noLog: true })
    .then((r) => {
      const games = (r.ok && r.data && r.data.games) || [];
      if (!games.length) return;
      S.lib = games;
      $('#libSub').textContent = `${games.length} 个游戏（已拥有）`;
      renderLibFilters();
      renderLibrary();
      hydrateLibNames();
      log(`启动自动识别到 ${games.length} 个已拥有游戏`, 'g');
    })
    .catch(() => {});

  // 3) 我的在售挂单
  syncOrders({ quiet: true });

  // 4) 上次浏览的库存（默认 Steam 社区物品）
  setTimeout(() => {
    try {
      if ($('#invAcc') && S.currentSteamId) $('#invAcc').value = S.currentSteamId;
      const last = Number(localStorage.getItem('sd_last_inv_app')) || 753;
      loadInventory(last);
    } catch { /* ignore */ }
  }, 500);
}

/* ----------------------------- 商店查价与挂机资讯 ---------------------------- */

let idleRegistry = null;
let idleStatsCache = [];
let idleHist = {};
// 正在玩的 appid（来自 Steam 客户端注册表），用来把对应卡片置顶
let playingAppId = 0;
const idleVolume = {};

/** 按内置掉落频率估算「每天大概值多少钱」，返回 null 表示没法估 */
function idleEstimate(g, meta) {
  const perDay = Number(meta && meta.dropsPerDay) || 0;
  const cents = Number(g && g.lowestCents) || 0;
  if (!perDay || cents <= 0) return null;
  return { perDay, yuan: (cents / 100) * perDay };
}

/** 最低价小曲线：至少两天数据才画，否则给一句提示 */
function idleSpark(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return '<span style="color:var(--dim);font-size:11px">走势要积累 2 天，明天再来看</span>';
  }
  const cs = points.map((p) => Number(p.c) || 0);
  const min = Math.min(...cs);
  const max = Math.max(...cs);
  const w = 110;
  const h = 24;
  const pad = 2;
  const span = max - min || 1;
  const pts = cs
    .map((c, i) => {
      const x = pad + (i * (w - pad * 2)) / (cs.length - 1);
      const y = pad + (1 - (c - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const diff = cs[cs.length - 1] - cs[0];
  const pct = cs[0] ? (diff / cs[0]) * 100 : 0;
  const color = diff > 0 ? 'var(--red)' : diff < 0 ? 'var(--green)' : 'var(--muted)';
  return `<span style="display:inline-flex;align-items:center;gap:6px">
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>
    <span style="color:${color};font-size:11px">${diff > 0 ? '+' : ''}${pct.toFixed(1)}%（${points.length} 天）</span>
  </span>`;
}

function idleCard(g, meta) {
  const errLine = g.error
    ? `<div class="idle-game-foot" style="color:var(--red)">行情读取失败：${esc(g.error)}</div>`
    : '';
  const lowText = g.lowestText || '暂无在售';
  const cheap = Array.isArray(g.cheapest) && g.cheapest.length
    ? `<div class="idle-game-drop" style="color:var(--muted)"><span>低价物品：</span><b>${g.cheapest
        .map((c) => `${esc(c.name)} ${esc(c.price)}`)
        .join(' · ')}</b></div>`
    : '';
  const metaLine = [
    meta && meta.category ? meta.category : '挂机掉落',
    g.total ? `市场条目约 ${Number(g.total).toLocaleString('zh-CN')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const dropLine = meta && meta.dropInterval
    ? `<div class="idle-game-drop"><span>掉落周期：</span><b>${esc(meta.dropInterval)}</b></div>`
    : '';
  const est = idleEstimate(g, meta);
  const vol = idleVolume[String(g.appId)] || 0;
  const estLine = est
    ? `<div class="idle-game-drop" style="background:transparent;border:0;padding:0;flex-wrap:wrap;row-gap:4px">
        <span>估算收益：</span><b style="white-space:nowrap;flex:none">≈ ¥${est.yuan.toFixed(2)}/天</b>
        <span style="color:var(--dim)">按约 ${est.perDay} 件/天 × 最低价</span>
        ${vol ? `<span style="color:var(--muted)">· 该物品 24h 成交 ${Number(vol).toLocaleString('zh-CN')} 笔</span>`
          : `<a href="javascript:void 0" data-idle-vol="${esc(String(g.appId))}" style="color:var(--blue);font-size:11px;text-decoration:none">查 24h 成交</a>`}
      </div>`
    : '';
  const hist = idleHist[String(g.appId)];
  const sparkLine = Array.isArray(hist) && hist.length
    ? `<div style="display:flex;align-items:center;gap:8px"><span style="color:var(--dim);font-size:11px">7 天走势</span>${idleSpark(hist)}</div>`
    : '';
  const watchBtn = g.builtin
    ? ''
    : `<button class="btn s" data-idle-unwatch="${esc(String(g.appId))}" title="从监控列表移除">移除</button>`;
  return `<div class="idle-game-card">
    <div class="idle-game-header">
      <div style="flex:1;min-width:0">
        <div class="idle-game-title">
          <span>${esc(g.name)}</span>
          <span class="pill ${g.builtin ? 'g' : 'b'}">${g.builtin ? '内置' : '已监控'}</span>
          ${playingAppId && Number(g.appId) === playingAppId
            ? '<span class="pill" style="background:rgba(64,180,120,.18);color:var(--green)">正在玩</span>'
            : ''}
        </div>
        <div class="idle-game-meta">${esc(metaLine)}</div>
      </div>
      <div style="display:flex;gap:4px;flex:none">
        <button class="btn s" data-market-jump="${esc(String(g.appId))}" title="打开 Steam 社区市场">市场</button>
        <button class="btn s" data-store-jump="${esc(String(g.appId))}">商店</button>
        ${watchBtn}
      </div>
    </div>
    <div class="idle-game-desc" style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
      <span>最低在售：<b class="price">${esc(lowText)}</b></span>
      <span style="color:var(--dim);font-size:11px">${g.lowestName ? esc(g.lowestName) : ''}</span>
    </div>
    ${estLine}
    ${cheap}
    ${dropLine}
    ${sparkLine}
    ${errLine}
  </div>`;
}

/** 按当前排序/筛选条件重画卡片（不重新请求行情） */
function renderIdleCards() {
  const container = $('#idleGamesList');
  if (!container) return;
  const byId = new Map((idleRegistry || []).map((g) => [Number(g.appId), g]));
  const sort = ($('#idleSort') && $('#idleSort').value) || 'default';
  const hideEmpty = !!($('#idleHideEmpty') && $('#idleHideEmpty').checked);
  let list = idleStatsCache.slice();
  if (hideEmpty) list = list.filter((g) => Number(g.lowestCents) > 0);
  const earn = (g) => {
    const e = idleEstimate(g, byId.get(Number(g.appId)));
    return e ? e.yuan : -1;
  };
  if (sort === 'earn') list.sort((a, b) => earn(b) - earn(a));
  else if (sort === 'price') list.sort((a, b) => (Number(a.lowestCents) || Infinity) - (Number(b.lowestCents) || Infinity));
  else if (sort === 'count') list.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  // 正在玩的那个游戏永远排第一：挂机时最常看的就它
  if (playingAppId) {
    const i = list.findIndex((g) => Number(g.appId) === playingAppId);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  container.innerHTML = list.map((g) => idleCard(g, byId.get(Number(g.appId)))).join('') ||
    '<div class="empty">没有符合条件的游戏</div>';
}

async function loadIdleGames(force) {
  const container = $('#idleGamesList');
  if (!container) return;
  if (!idleRegistry) {
    const rr = await call(SD.store.idleGames(), { silent: true, noLog: true });
    idleRegistry = rr.ok && Array.isArray(rr.data) ? rr.data : [];
  }
  container.innerHTML = '<div class="empty">正在读取 Steam 社区市场行情…</div>';
  const r = await call(SD.store.idleStats(!!force), { silent: true, noLog: true });
  if (!r.ok || !Array.isArray(r.data)) {
    container.innerHTML = `<div class="empty">读取失败：${esc((r && r.message) || '没有返回数据')}</div>`;
    return;
  }
  idleStatsCache = r.data;
  const pr = await call(SD.store.playing(), { silent: true, noLog: true });
  playingAppId = pr.ok && pr.data ? Number(pr.data.appId) || 0 : 0;
  const hr = await call(SD.store.priceHistory(), { silent: true, noLog: true });
  idleHist = hr.ok && hr.data && typeof hr.data === 'object' ? hr.data : {};
  renderIdleCards();
  const at = r.data.reduce((a, g) => Math.max(a, Number(g.at) || 0), 0);
  if ($('#idleUpdated')) {
    $('#idleUpdated').textContent = at ? `行情 ${new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新` : '行情 —';
  }
}

async function addIdleWatch(appId, name) {
  const r = await call(SD.store.idleWatchAdd(appId, name), { silent: true });
  if (!r.ok) {
    toast(r.message || '加入监控失败', true);
    return false;
  }
  await loadIdleGames(true);
  return true;
}

async function doStoreSearch(term) {
  const q = (term || $('#storeSearchInput')?.value || '').trim();
  if (!q) {
    toast('请输入游戏名称或 AppID', true);
    return;
  }
  const resBox = $('#storeSearchResult');
  if (!resBox) return;
  resBox.style.display = 'block';
  resBox.innerHTML = '<div class="empty">正在连接 Steam 官方商店查询最新价格与折扣…</div>';

  const r = await call(SD.store.price(q));
  if (!r.ok) {
    resBox.innerHTML = `<div class="empty" style="color:var(--red)"><b>查询失败</b>${esc(r.message || '未查到游戏详情')}</div>`;
    return;
  }

  const d = r.data;
  const hasDiscount = d.discountPercent > 0;
  resBox.innerHTML = `<div class="store-price-card">
    <img class="store-price-img" src="${esc(d.headerImage)}" alt="" onerror="this.style.display='none'">
    <div class="store-price-info">
      <div class="title">
        <span>${esc(d.name)}</span>
        <span class="pill n">AppID ${esc(String(d.appId))}</span>
        ${hasDiscount ? `<span class="store-discount-tag">-${d.discountPercent}% 折扣</span>` : ''}
      </div>
      <div class="meta">类型: ${esc(d.type)} · 发售时间: ${esc(d.releaseDate)} · 货币: ${esc(d.currency)} · 区服 ${esc(d.region || 'CN')}</div>
      <div class="meta" id="storeItadLine" style="color:var(--dim)"></div>
      <div class="meta" id="storeHoldingLine" style="color:var(--muted)"></div>
    </div>
    <div class="store-price-values">
      ${hasDiscount ? `<span class="initial">${esc(d.initialPriceFormatted)}</span>` : ''}
      <div class="final">${esc(d.finalPriceFormatted)}</div>
    </div>
    <div style="flex:none;display:flex;flex-direction:column;gap:6px">
      <button class="btn p" data-launch="${esc(String(d.appId))}">立即启动</button>
      <button class="btn s" data-store-jump="${esc(String(d.appId))}">商店主页</button>
      <button class="btn s" data-store-inv="${esc(String(d.appId))}">查看可卖物品</button>
      <button class="btn s" data-store-monitor="${esc(String(d.appId))}">加入监控</button>
    </div>
  </div>`;

  S.storePrice = d;
  if ($('#storeAlertRow')) $('#storeAlertRow').style.display = '';
  if ($('#storeAlertTarget') && !$('#storeAlertTarget').value) {
    $('#storeAlertTarget').value = d.finalPriceYuan ? Math.round(d.finalPriceYuan * 0.8) : '';
  }
  loadStoreHolding(d.appId);
  loadStoreItad(d.appId);
}

/** 查询结果里顺带显示：这个游戏在我库存里有多少、挂了几件、成本多少 */
async function loadStoreHolding(appId) {
  const line = $('#storeHoldingLine');
  const box = $('#storeHolding');
  if (!line) return;
  line.textContent = '正在读你的库存与挂单…';
  if (box) box.style.display = 'none';
  const r = await call(SD.store.holding(appId), { silent: true, noLog: true });
  if (!r.ok) {
    line.textContent = `库存联动读取失败：${r.message || ''}`;
    return;
  }
  const d = r.data || {};
  if (!d.loggedIn) {
    line.textContent = '还没有登录 Steam 网页会话，登录后这里会显示你的库存、挂单和成本。';
    return;
  }
  if (d.hasMarket === false) {
    line.textContent = '这个游戏没有社区市场库存（没有可卖的饰品或卡片）。';
    return;
  }
  const parts = [`库存 ${d.itemCount} 件（${d.groupCount} 种）`, `当前挂单 ${d.listings} 件`];
  if (d.costQty > 0) parts.push(`有成本 ${d.costQty} 件，总成本 ¥${Number(d.costTotal).toFixed(2)}`);
  else parts.push('还没有成本记录');
  line.textContent = parts.join(' · ');
  S.storeHolding = d;
}

/** 可选：有 ITAD Key 时显示历史最低价 */
async function loadStoreItad(appId) {
  const line = $('#storeItadLine');
  if (!line) return;
  line.textContent = '';
  const r = await call(SD.store.itad(appId), { silent: true, noLog: true });
  if (!r.ok || !r.data || !r.data.configured) return;
  if (!r.data.found) {
    line.textContent = '史低：ITAD 没有收录这个游戏';
    return;
  }
  if (!r.data.low) {
    line.textContent = '史低：暂无记录';
    return;
  }
  const low = r.data.low;
  const when = low.at ? new Date(low.at).toLocaleDateString('zh-CN') : '';
  line.textContent = `史低 ${low.text}（${low.shop}${when ? ` · ${when}` : ''}）`;
}

/* ------------------------------- 每日促销 ------------------------------- */

let dealData = null;
let dealFilter = 'all';
let dealOwned = new Set();
let dealWish = new Set();
let dealWishStatus = '';
const DEAL_PLAT = {
  steam: ['Steam', 'steam'],
  gog: ['GOG', 'gog'],
  epic: ['Epic', 'epic'],
  humble: ['Humble', 'humble'],
  fanatical: ['Fanatical', 'fanatical'],
};

function dealEndsText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return `至 ${d.getMonth() + 1}月${d.getDate()}日`;
}

function dealCardHtml(d) {
  const steam = d.source === 'steam';
  const [plat, cls] = DEAL_PLAT[d.source] || ['商店', ''];
  const ends = dealEndsText(d.endsAt);
  const appId = Number(d.appId) || 0;
  const owned = steam && appId && dealOwned.has(appId);
  const wish = steam && appId && dealWish.has(appId);
  const tags = [
    wish ? '<span class="pill b" style="font-size:10px">愿望单</span>' : '',
    owned ? '<span class="pill g" style="font-size:10px">已在库</span>' : '',
    d.isHistLow ? '<span class="pill" style="font-size:10px;background:rgba(224,166,60,.18);color:var(--amber)">史低</span>' : '',
  ].filter(Boolean).join(' ');
  const lowLine = d.histLowText
    ? `<div class="fld-hint" style="margin:0">历史最低 ${esc(d.histLowText)}${d.isHistLow ? '（本次就是）' : ''}</div>`
    : '';
  const alertBtn = steam && appId
    ? `<button class="btn g" data-deal-alert="${esc(String(appId))}" data-name="${esc(d.name)}" data-disc="${Number(d.discount) || 0}" title="留空按「再降 10%」提醒；填了目标价就按目标价">加提醒</button>`
    : '';
  const target = steam && appId
    ? `<div class="fg-target"><span>目标价</span><input type="number" min="0" step="0.01" placeholder="可留空" data-deal-price="${esc(String(appId))}" /><span>元</span></div>`
    : '';
  return `<div class="fg">
    <div class="fg-cover">
      <span class="fg-plat ${cls}">${plat}</span>
      <span class="fg-disc">-${Number(d.discount) || 0}%</span>
      ${d.image ? `<img src="${esc(d.image)}" loading="lazy" alt="" />` : `<span class="fg-ph">${esc(String(d.name || '?').slice(0, 1))}</span>`}
    </div>
    <div class="fg-body">
      <div class="fg-title">${esc(d.name || '')}</div>
      <div class="fg-tags">${tags}</div>
      <div class="fg-meta">
        <span class="fg-price">${esc(d.finalText || '')}</span>
        <span class="fg-old">${esc(d.originalText || '')}</span>
        ${ends ? `<span class="fg-end">${esc(ends)}</span>` : ''}
      </div>
      ${lowLine}
      ${target}
      <div class="fg-deal-row">
        <button class="btn s" data-deal-open="${esc(d.url || '')}">去商店</button>
        ${alertBtn}
      </div>
    </div>
  </div>`;
}

function renderDeals() {
  const grid = $('#dealGrid');
  if (!grid || !dealData) return;
  // Steam 的首页特惠放前面，GOG 折扣榜跟在后面，其他平台最后；各自内部已按折扣排好
  const all = [...(dealData.steam || []), ...(dealData.gog || []), ...(dealData.other || [])];
  let list = all;
  if (dealFilter === 'gog' || dealFilter === 'steam' || dealFilter === 'epic') {
    list = all.filter((x) => x.source === dealFilter);
  } else if (dealFilter === 'other') {
    list = all.filter((x) => x.source === 'humble' || x.source === 'fanatical');
  }
  if ($('#dealHideOwned') && $('#dealHideOwned').checked) {
    list = list.filter((d) => !(d.source === 'steam' && dealOwned.has(Number(d.appId))));
  }
  grid.innerHTML =
    list.map(dealCardHtml).join('') ||
    '<div class="empty">这个筛选下暂时没有促销</div>';
  if ($('#dealUpdated')) {
    const at = Number(dealData.at) || 0;
    $('#dealUpdated').textContent = at
      ? `更新 ${new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      : '促销 —';
  }
  if ($('#dealSub')) {
    const other = dealData.other || [];
    const bits = [
      `Steam ${(dealData.steam || []).length}`,
      `GOG ${(dealData.gog || []).length}`,
      `Epic ${other.filter((x) => x.source === 'epic').length}`,
      `其他 ${other.filter((x) => x.source !== 'epic').length}`,
      `区服 ${dealData.region || 'CN'}`,
    ];
    if (dealWishStatus === 'fail') bits.push('愿望单未公开，未标记');
    if (dealData.errors && dealData.errors.length) bits.push(`部分失败：${dealData.errors.join('；')}`);
    $('#dealSub').textContent = bits.join(' · ');
  }
}

/** 已有游戏与愿望单：给促销卡打标记、支持「隐藏我已有的」 */
async function loadDealContext(force) {
  dealOwned = new Set((S.lib || []).map((g) => Number(g.appId)).filter(Boolean));
  if (dealWishStatus === 'ok' && !force) return;
  const w = await call(SD.store.wishlistList(), { silent: true, noLog: true });
  if (w.ok && w.data && Array.isArray(w.data.ids)) {
    dealWish = new Set(w.data.ids.map((x) => Number(x)).filter(Boolean));
    dealWishStatus = 'ok';
  } else {
    dealWish = new Set();
    dealWishStatus = 'fail';
  }
}

async function loadDailyDeals(force) {
  const grid = $('#dealGrid');
  if (!grid) return;
  if (dealData && !force) {
    renderDeals();
    return;
  }
  grid.innerHTML = '<div class="empty">正在读取 Steam · GOG · Epic 的促销…</div>';
  await loadDealContext(force).catch(() => {});
  const r = await call(SD.store.dailyDeals(!!force), { silent: true, noLog: true });
  if (!r.ok) {
    grid.innerHTML = `<div class="empty">读取失败：${esc(r.message || '没有返回数据')}</div>`;
    return;
  }
  dealData = r.data || {};
  renderDeals();
}

if ($('#dealRefresh')) {
  $('#dealRefresh').onclick = async () => {
    toast('正在刷新每日促销…');
    await loadDailyDeals(true);
    toast('促销已刷新');
  };
}
if ($('#dealFilter')) {
  $('#dealFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-df]');
    if (!b) return;
    dealFilter = b.dataset.df;
    $$('#dealFilter .tab').forEach((x) => x.classList.toggle('on', x === b));
    renderDeals();
  });
}
if ($('#dealHideOwned')) {
  $('#dealHideOwned').addEventListener('change', () => renderDeals());
}

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-deal-open]');
  if (open) {
    await call(SD.app.openExternal(open.dataset.dealOpen));
    return;
  }
  const alertBtn = e.target.closest('[data-deal-alert]');
  if (alertBtn) {
    const disc = Number(alertBtn.dataset.disc) || 0;
    const card = alertBtn.closest('.fg');
    const input = card && card.querySelector('[data-deal-price]');
    const targetYuan = input ? Number(input.value) : 0;
    // 填了目标价就按目标价提醒；留空则设在「再降 10%」的位置（现在已经在打折了）
    const pct = targetYuan > 0 ? 0 : Math.max(10, Math.min(90, disc + 10));
    const r = await call(
      SD.storeAlerts.add({
        appId: Number(alertBtn.dataset.dealAlert),
        name: alertBtn.dataset.name,
        targetYuan: targetYuan > 0 ? targetYuan : 0,
        discountPct: pct,
      }),
      { silent: true }
    );
    toast(
      r.ok
        ? targetYuan > 0
          ? `已加提醒：降到 ¥${targetYuan} 时通知`
          : `已加提醒：折扣降到 ${pct}% 时通知`
        : r.message || '加入提醒失败',
      !r.ok
    );
    return;
  }
});

/* --------------------------- 愿望单批量查价 --------------------------- */

let wishItems = [];

async function importWishlist() {
  const box = $('#wishlistBox');
  if (!box) return;
  box.innerHTML = '<div class="fld-hint" style="margin:8px 0">正在读取 Steam 愿望单…</div>';
  const l = await call(SD.store.wishlistList(), { silent: true });
  if (!l.ok) {
    box.innerHTML = `<div class="fld-hint" style="margin:8px 0;color:var(--red)">${esc(l.message || '读取愿望单失败')}</div>`;
    return;
  }
  const d = l.data || {};
  if (!d.items || !d.items.length) {
    box.innerHTML =
      '<div class="fld-hint" style="margin:8px 0">愿望单是空的，或者在 Steam 隐私设置里不是「公开」状态——公开后才能读取。</div>';
    return;
  }
  const secs = Math.max(3, Math.ceil(d.items.length * 0.4));
  box.innerHTML = `<div class="fld-hint" style="margin:8px 0">愿望单共 ${Number(d.total).toLocaleString('zh-CN')} 个，正在查前 ${d.items.length} 个的价格（约 ${secs} 秒）…</div>`;
  const p = await call(SD.store.wishlistPrices(d.items), { silent: true });
  if (!p.ok) {
    box.innerHTML = `<div class="fld-hint" style="margin:8px 0;color:var(--red)">${esc(p.message || '查价失败')}</div>`;
    return;
  }
  wishItems = (p.data && p.data.items) || [];
  renderWishlist(p.data && p.data.region);
}

function renderWishlist(region) {
  const box = $('#wishlistBox');
  if (!box) return;
  if (!wishItems.length) {
    box.innerHTML = '<div class="fld-hint" style="margin:8px 0">这一批没有查到价格。</div>';
    return;
  }
  const rows = wishItems.map((it) => {
    const disc = Number(it.discountPercent) || 0;
    const price = it.error
      ? `<span style="color:var(--red);font-size:11px">${esc(it.error)}</span>`
      : it.comingSoon
        ? '<span style="color:var(--dim);font-size:11px">未发售</span>'
        : `<span style="font-weight:600">${esc(it.finalPriceFormatted || '')}</span>${
            disc > 0
              ? ` <span style="color:var(--dim);font-size:11px;text-decoration:line-through">${esc(it.initialPriceFormatted || '')}</span> <span class="pill b" style="font-size:10px">-${disc}%</span>`
              : ''
          }`;
    const btn = it.error || it.comingSoon
      ? ''
      : `<button class="btn s" data-wish-alert="${esc(String(it.appId))}" title="折扣达到 20% 时提醒">加提醒</button>`;
    return `<div class="rowx" style="align-items:center;gap:8px;padding:6px 0;border-top:.5px solid var(--line)">
      <span style="flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}</span>
      ${price}
      ${btn}
      <button class="btn s" data-store-jump="${esc(String(it.appId))}">商店</button>
    </div>`;
  }).join('');
  const canAlert = wishItems.some((it) => !it.error && !it.comingSoon);
  box.innerHTML = `<div class="rowx" style="align-items:center;gap:8px;margin:8px 0 4px">
      <span class="fld-hint" style="margin:0;flex:1">愿望单这批 ${wishItems.length} 个 · 区服 ${esc(String(region || 'CN'))}</span>
      ${canAlert ? '<button class="btn s" data-wish-all>全部加提醒（折扣≥20%）</button>' : ''}
    </div>` + rows;
}

/* --------------------------- 商店价格提醒 --------------------------- */

async function renderStoreAlerts() {
  const box = $('#storeAlertsBox');
  if (!box || !SD.storeAlerts) return;
  const r = await call(SD.storeAlerts.list(), { silent: true, noLog: true });
  const list = r.ok && Array.isArray(r.data) ? r.data : [];
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="fld-hint" style="margin:0 0 6px">已设置的商店价格提醒</div>` +
    list.map((a) => {
      const cond = [
        Number(a.targetYuan) > 0 ? `≤ ¥${Number(a.targetYuan).toFixed(2)}` : '',
        Number(a.discountPct) > 0 ? `折扣 ≥ ${a.discountPct}%` : '',
      ].filter(Boolean).join(' · ');
      const now = a.lastPrice ? `现在 ¥${Number(a.lastPrice).toFixed(2)}（-${a.lastDiscount || 0}%）` : '';
      const err = a.lastError ? ` · ${esc(a.lastError)}` : '';
      return `<div class="rowx" style="align-items:center;gap:8px;padding:6px 0;border-top:.5px solid var(--line)">
        <span style="flex:1;min-width:0;font-size:12px">${esc(a.name)} <span style="color:var(--dim)">${esc(cond)}</span></span>
        <span style="font-size:11px;color:var(--muted)">${esc(now)}${err}</span>
        <button class="btn s" data-alert-del="${esc(String(a.id))}" title="删除这条提醒">删除</button>
      </div>`;
    }).join('');
}

if ($('#storeAlertAdd')) {
  $('#storeAlertAdd').onclick = async () => {
    const d = S.storePrice;
    if (!d) {
      toast('先查一款游戏再加提醒', true);
      return;
    }
    const targetYuan = Number($('#storeAlertTarget') && $('#storeAlertTarget').value) || 0;
    const discountPct = Number($('#storeAlertDiscount') && $('#storeAlertDiscount').value) || 0;
    if (!targetYuan && !discountPct) {
      toast('目标价和折扣至少填一个', true);
      return;
    }
    const r = await call(SD.storeAlerts.add({ appId: d.appId, name: d.name, targetYuan, discountPct }), { silent: true });
    if (!r.ok) {
      toast(r.message || '加入提醒失败', true);
      return;
    }
    toast('价格提醒已加入，达到条件会走通知渠道');
    renderStoreAlerts();
  };
}

if ($('#storeSearchBtn')) {
  $('#storeSearchBtn').onclick = () => doStoreSearch();
}
if ($('#storeSearchInput')) {
  $('#storeSearchInput').onkeydown = (e) => {
    if (e.key === 'Enter') doStoreSearch();
  };
}
if ($('#newsRefresh')) {
  $('#newsRefresh').onclick = async () => {
    toast('正在刷新 Steam 市场行情…');
    await loadIdleGames(true);
    await renderStoreAlerts();
    toast('行情已刷新');
  };
}

if ($('#wishImport')) {
  $('#wishImport').onclick = () => importWishlist();
}

// 挂机卡片的排序与筛选：记住上次选择
(function initIdleControls() {
  const sort = $('#idleSort');
  const hide = $('#idleHideEmpty');
  if (!sort || !hide) return;
  const saved = localStorage.getItem('sd_idle_sort') || 'default';
  if ([...sort.options].some((o) => o.value === saved)) sort.value = saved;
  hide.checked = localStorage.getItem('sd_idle_hide') === '1';
  sort.onchange = () => {
    localStorage.setItem('sd_idle_sort', sort.value);
    renderIdleCards();
  };
  hide.onchange = () => {
    localStorage.setItem('sd_idle_hide', hide.checked ? '1' : '0');
    renderIdleCards();
  };
})();

if ($('#idleAddBtn')) {
  $('#idleAddBtn').onclick = async () => {
    const raw = String(($('#idleAddApp') && $('#idleAddApp').value) || '').trim();
    if (!raw) {
      toast('输入游戏 AppID 或名称', true);
      return;
    }
    const pr = await call(SD.store.price(raw), { silent: true });
    if (!pr.ok) {
      toast(pr.message || '没找到这个游戏', true);
      return;
    }
    if (await addIdleWatch(pr.data.appId, pr.data.name)) {
      toast(`已加入监控：${pr.data.name}`);
      if ($('#idleAddApp')) $('#idleAddApp').value = '';
    }
  };
  if ($('#idleAddApp')) {
    $('#idleAddApp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#idleAddBtn').click();
    });
  }
}

document.addEventListener('click', async (e) => {
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const id = quick.dataset.quick;
    if ($('#storeSearchInput')) $('#storeSearchInput').value = id;
    doStoreSearch(id);
    return;
  }
  const jump = e.target.closest('[data-store-jump]');
  if (jump) {
    const id = jump.dataset.storeJump;
    await call(SD.app.openExternal(`https://store.steampowered.com/app/${id}/`));
    return;
  }
  const mkt = e.target.closest('[data-market-jump]');
  if (mkt) {
    await call(SD.app.openExternal(`https://steamcommunity.com/market/search?appid=${mkt.dataset.marketJump}`));
    return;
  }
  const unwatch = e.target.closest('[data-idle-unwatch]');
  if (unwatch) {
    const r = await call(SD.store.idleWatchRemove(unwatch.dataset.idleUnwatch), { silent: true });
    if (r.ok) {
      toast('已从监控列表移除');
      await loadIdleGames(true);
    } else toast(r.message || '移除失败', true);
    return;
  }
  const monitor = e.target.closest('[data-store-monitor]');
  if (monitor) {
    const d = S.storePrice;
    if (!d) return;
    if (await addIdleWatch(d.appId, d.name)) toast(`已加入监控：${d.name}`);
    return;
  }
  const volBtn = e.target.closest('[data-idle-vol]');
  if (volBtn) {
    const id = String(volBtn.dataset.idleVol);
    const g = idleStatsCache.find((x) => String(x.appId) === id);
    if (!g || !g.lowestHash) {
      toast('这个价格暂时没有可查的物品', true);
      return;
    }
    volBtn.textContent = '查询中…';
    const q = await call(SD.market.quoteOne(Number(id), g.lowestHash), { silent: true });
    if (q.ok && q.data) {
      idleVolume[id] = Number(q.data.volume) || 0;
      renderIdleCards();
    } else {
      volBtn.textContent = '查 24h 成交';
      toast(q.message || '没查到成交量', true);
    }
    return;
  }
  const wishAlert = e.target.closest('[data-wish-alert]');
  if (wishAlert) {
    const appId = Number(wishAlert.dataset.wishAlert);
    const it = wishItems.find((x) => Number(x.appId) === appId);
    if (!it) return;
    const r = await call(
      SD.storeAlerts.add({ appId, name: it.name, targetYuan: 0, discountPct: 20 }),
      { silent: true }
    );
    toast(r.ok ? `已加提醒：${it.name}（折扣≥20%）` : r.message || '加入提醒失败', !r.ok);
    if (r.ok) renderStoreAlerts();
    return;
  }
  const wishAll = e.target.closest('[data-wish-all]');
  if (wishAll) {
    const items = wishItems
      .filter((it) => !it.error && !it.comingSoon)
      .map((it) => ({ appId: it.appId, name: it.name, targetYuan: 0, discountPct: 20 }));
    if (!items.length) return;
    const r = await call(SD.storeAlerts.addMany(items), { silent: true });
    if (!r.ok) {
      toast(r.message || '批量加提醒失败', true);
      return;
    }
    const d = r.data || {};
    toast(`已加 ${d.added || 0} 条提醒${d.dup ? `，${d.dup} 条重复已跳过` : ''}`);
    renderStoreAlerts();
    return;
  }
  const inv = e.target.closest('[data-store-inv]');
  if (inv) {
    const appId = Number(inv.dataset.storeInv);
    goto('inventory');
    await ensureInvAppOptions();
    const sel = $('#invApp');
    if (sel && ![...sel.options].some((o) => o.value === String(appId))) {
      const opt = document.createElement('option');
      opt.value = String(appId);
      opt.textContent = `App ${appId}`;
      sel.appendChild(opt);
    }
    if (sel) sel.value = String(appId);
    loadInventory(appId);
    return;
  }
  const del = e.target.closest('[data-alert-del]');
  if (del) {
    const r = await call(SD.storeAlerts.remove(del.dataset.alertDel), { silent: true });
    if (r.ok) {
      toast('提醒已删除');
      renderStoreAlerts();
    }
    return;
  }
});

/* ------------------------------ 免费游戏领取 ------------------------------
 * 数据在主进程里拉（Epic 官方接口 + GamerPower 聚合），这里只管展示。
 * 只做发现和跳转，不代领：三个平台的领取都要各自的登录态和结账流程。
 */
const FREE_PLAT = { epic: 'Epic', steam: 'Steam', gog: 'GOG' };
const FREE_TYPE = { DLC: '资料片', 'Early Access': '抢先体验', Beta: '测试', Playtest: '测试', Loot: '道具' };

/** 截止时间写成「截止 11月13日 00:00」，和商店页的写法一致 */
function freeTimeText(it) {
  if (it.upcoming && it.startAt) {
    const d = new Date(it.startAt);
    return { text: `开抢 ${d.getMonth() + 1}月${d.getDate()}日`, hot: false, soon: true };
  }
  if (!it.endAt) return { text: '长期有效', hot: false, soon: false };
  const ms = it.endAt - Date.now();
  if (ms <= 0) return { text: '已结束', hot: true, soon: false };
  const d = new Date(it.endAt);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return {
    text: `截止 ${d.getMonth() + 1}月${d.getDate()}日 ${hm}`,
    hot: ms < 86400000,
    soon: false,
  };
}

function freeCard(it) {
  const t = freeTimeText(it);
  // 参考商店页的写法：一行「免费领取 · 原价 ¥80.00 · 截止 11月13日 00:00」
  const meta = [];
  if (it.type && FREE_TYPE[it.type]) meta.push(FREE_TYPE[it.type]);
  if (it.worth) meta.push(`原价 ${it.worth}`);
  meta.push(t.text);
  // 数据里有些标题带书名号，卡片上只显示干净的标题
  const titleText = String(it.title || '未知').replace(/^《(.+)》$/, '$1');
  const letter = esc(String(titleText || '?').slice(0, 1).toUpperCase());
  const cover = it.image
    ? `<img src="${esc(it.image)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  // Epic 带 offerId/namespace；Steam 免费包走商店入库接口；GOG 走站内赠送接口。
  const canClaim = it.platform === 'epic' && it.offerId && it.namespace;
  const claimed = it.claimed || (S.free.claimed && S.free.claimed[it.id]);
  // 自动领取失败过：除了原来的按钮，再给一个直接去网页领的入口
  const webHtml = !claimed && S.free.webFallback[it.id] && it.url
    ? `<a class="fg-web" href="#" data-claim="${esc(it.url)}" title="自动领取没成功，去网页用你自己的登录态领">网页领取 →</a>`
    : '';
  const btn = claimed
    ? '<button class="fg-btn done" disabled>已领取 ✓</button>'
    : canClaim
      ? `<button class="fg-btn" data-epic-claim="1" data-offer="${esc(it.offerId)}"
         data-ns="${esc(it.namespace)}" data-name="${esc(it.title)}"
         ${S.epic.linked ? '' : 'title="需要先登录 Epic（点一下就会弹出登录窗口）"'}>
         ${S.epic.linked ? '去领取' : '登录后领取'} <span class="fg-arrow">→</span></button>`
      : it.platform === 'steam'
        ? `<button class="fg-btn" data-steam-claim="${esc(it.id)}">去领取 <span class="fg-arrow">→</span></button>`
        : it.platform === 'gog'
          ? `<button class="fg-btn" data-gog-claim="${esc(it.id)}">去领取 <span class="fg-arrow">→</span></button>`
          : `<button class="fg-btn" data-claim="${esc(it.url)}">去领取 <span class="fg-arrow">→</span></button>`;
  return `<div class="fg">
    <div class="fg-cover"><div class="fg-ph">${letter}</div>${cover}
      <span class="fg-plat ${esc(it.platform)}">${esc(FREE_PLAT[it.platform] || it.platform)}</span>
      ${t.soon ? '<span class="fg-soon">即将开始</span>' : ''}
    </div>
    <div class="fg-body">
      <div class="fg-title" title="${esc(titleText)}">${esc(titleText)}</div>
      <div class="fg-meta"><span class="fg-free">免费领取</span><span class="fg-end ${t.hot ? 'hot' : ''}">· ${esc(meta.join(' · '))}</span></div>
      <div class="fg-actions">${btn}${webHtml}</div>
    </div>
  </div>`;
}

function renderFree() {
  const box = $('#freeList');
  if (!box) return;
  const all = S.free.items || [];
  const items = all
    .filter((x) => S.free.filter === 'all' || x.platform === S.free.filter)
    // '只看完整游戏'：DLC / 测试 / 道具这类条目收起来（Epic 官方条目没有 type，视为游戏）
    .filter((x) => !S.free.gameOnly || !FREE_TYPE[x.type]);

  const bd = $('#navFree');
  if (bd) {
    const active = all.filter((x) => !x.upcoming && (!x.endAt || x.endAt > Date.now())).length;
    bd.textContent = active;
    bd.style.display = active ? '' : 'none';
  }

  const errs = (S.free.errors || []).map(
    (e) => `${FREE_PLAT[e.platform] || e.platform} 获取失败：${e.message}`
  );
  const errHtml = errs.length ? `<div class="free-err">${esc(errs.join(' · '))}</div>` : '';
  const runHtml = runPanelHtml();

  if (!items.length) {
    const txt = S.free.loading || !S.free.loaded
      ? '正在获取…'
      : (S.free.filter === 'all' ? '当前没有可领取的活动，过一会儿再刷新看看' : '这个平台暂时没有可领取的活动');
    box.innerHTML = errHtml + runHtml + `<div class="free-empty">${txt}</div>`;
    return;
  }
  box.innerHTML = errHtml + runHtml + items.map(freeCard).join('');
}

/* ------------------------------ 领取结果面板 ------------------------------
 * 批量领取失败时只弹一个 toast，一闪就没了，用户不知道哪条失败、为什么失败。
 * 这里把最近一次领取的每一条结果收集起来，在列表上方给一张可展开的汇总卡：
 * 成功/已在库/待确认/需手动/失败各几条，失败条目带原因，并能直接重试或去网页领。
 */

function beginRun(label) {
  S.free.lastRun = { at: Date.now(), label: label || '领取', rows: [], done: false };
  return S.free.lastRun;
}

function addRunRow(row) {
  const run = S.free.lastRun || beginRun();
  run.rows.push({ state: 'fail', message: '', ...row });
  return run;
}

function finishRun() {
  const run = S.free.lastRun;
  if (!run) return;
  run.done = true;
  renderFree();
}

/** 结果面板里点「重试」：按平台重新走一次单条领取 */
async function retryRunRow(i) {
  const run = S.free.lastRun;
  const row = run && run.rows[i];
  if (!row || !row.item) return;
  const it = row.item;
  if (row.platform === 'epic') await epicClaim([it]);
  else if (row.platform === 'steam') await steamClaim(it);
  else if (row.platform === 'gog') await gogClaim(it);
  else if (it.url) await call(SD.app.openExternal(it.url), { noLog: true, silent: true });
}

const RUN_STATE_TEXT = {
  ok: '已入库',
  owned: '已在库',
  pending: '已提交，待确认',
  external: '需在网页领取',
  fail: '失败',
};

function runPanelHtml() {
  const run = S.free.lastRun;
  if (!run || !run.done || !run.rows.length) return '';
  const count = (s) => run.rows.filter((r) => r.state === s).length;
  const sum = [
    ['ok', '入库'],
    ['owned', '已在库'],
    ['pending', '待确认'],
    ['external', '需手动'],
    ['fail', '失败'],
  ]
    .filter(([s]) => count(s))
    .map(([s, label]) => `${label} ${count(s)}`)
    .join(' · ');
  const time = new Date(run.at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  // 只把需要用户处理的条目列出来，成功的不用占地方
  const rows = run.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.state !== 'ok' && r.state !== 'owned');
  const list = rows.length
    ? `<div class="fr-rows">${rows
        .map(({ r, i }) => {
          const plat = FREE_PLAT[r.platform] || '';
          const canWeb = !!(r.item && r.item.url);
          return `<div class="fr-row">
            <div class="fr-main">
              <div class="fr-nm" title="${esc(r.title || '')}">${esc(r.title || '未知条目')}</div>
              <div class="fr-sub">${esc(plat)}${r.account ? ` · ${esc(r.account)}` : ''} · ${esc(
                RUN_STATE_TEXT[r.state] || r.state
              )}${r.message ? `：${esc(r.message)}` : ''}</div>
            </div>
            ${r.item ? `<button class="btn s fr-btn" data-run-retry="${i}">重试</button>` : ''}
            ${canWeb ? `<button class="btn s fr-btn" data-run-web="${esc(r.item.url)}">网页领取</button>` : ''}
          </div>`;
        })
        .join('')}</div>`
    : '<div class="fr-ok">这一批全部领取成功，没有需要处理的条目。</div>';
  return `<div class="free-run">
    <div class="fr-head">
      <span class="fr-title">本次${esc(run.label)}结果</span>
      <span class="fr-sum">${esc(sum || '无记录')}</span>
      <span class="fr-at">${esc(time)}</span>
      <button class="fr-x" data-run-close title="收起">✕</button>
    </div>
    ${list}
  </div>`;
}

async function loadFree(opts = {}) {
  if (S.free.loading) return;
  S.free.loading = true;
  if (!opts.quiet) toast('正在获取免费游戏…');
  // 先确认三个平台登录态，后面判断"是否已拥有"要用到
  await loadFreeAccounts();
  await loadEpicStatus().catch(() => {});
  renderFree();
  renderEpicBar();

  const r = await call(SD.free.list(!!opts.force), { noLog: true, silent: true });
  S.free.loading = false;
  if (r.ok && r.data) {
    S.free.items = r.data.items || [];
    S.free.errors = r.data.errors || [];
    S.free.at = r.data.at || Date.now();
    S.free.loaded = true;
    const sub = $('#freeSub');
    if (sub) {
      const t = new Date(S.free.at);
      const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      sub.textContent = `Steam / Epic / GOG 当前可领的活动 · 更新于 ${hm}`;
    }
  } else {
    S.free.errors = [{ platform: 'all', message: r.message || '获取失败' }];
  }
  renderFree();
  if (!opts.quiet) {
    toast(S.free.items.length ? `已更新，共 ${S.free.items.length} 个活动` : '暂时没有可领取的活动');
  }
  // 拿真正的游戏库核对哪些已经拥有；手动刷新时强制重新读一次库
  refreshClaimed(!!opts.force).catch(() => {});
}

/** 用游戏库（而不是本地临时标记）判断哪些免费条目已经拥有 */
async function refreshClaimed(force) {
  const items = S.free.items || [];
  const jobs = [];

  const epicItems = items.filter(
    (x) => x.platform === 'epic' && x.offerId && x.namespace && !x.upcoming
  );
  if (epicItems.length && S.epic.linked) {
    jobs.push(
      call(
        SD.epic.owned(
          epicItems.map((x) => ({ offerId: x.offerId, namespace: x.namespace, title: x.title })),
          !!force
        ),
        { noLog: true, silent: true }
      ).then((r) => {
        if (!r.ok || !r.data || !Array.isArray(r.data.owned)) return;
        const set = new Set(r.data.owned.map((x) => x.offerId));
        // 有号没读成功时，不能把没匹配到的条目判成"没领过"
        const partial = (r.data.accounts || []).some((a) => a.error);
        epicItems.forEach((it) => {
          if (set.has(it.offerId)) setOwned(it, true);
          else if (!partial) setOwned(it, false);
        });
      })
    );
  }

  const gogItems = items.filter((x) => x.platform === 'gog' && !x.upcoming);
  if (gogItems.length && S.gogFree && S.gogFree.linked) {
    jobs.push(
      call(
        SD.gog.owned(gogItems.map((x) => ({ id: x.id, title: x.title })), !!force),
        { noLog: true, silent: true }
      ).then((r) => {
        if (!r.ok || !r.data || !Array.isArray(r.data.owned)) return;
        const set = new Set(r.data.owned);
        gogItems.forEach((it) => setOwned(it, set.has(it.id)));
      })
    );
  }

  if (!jobs.length) return;
  await Promise.all(jobs);
  renderFree();
}

function setOwned(it, owned) {
  it.claimed = owned;
  if (owned) {
    S.free.claimed[it.id] = true;
    delete S.free.webFallback[it.id];
  } else {
    delete S.free.claimed[it.id];
  }
}

/** 自动领取失败：在卡片上补一个「网页领取」入口 */
function markWebFallback(it) {
  if (it && it.id && it.url) S.free.webFallback[it.id] = true;
}
function markWebFallbackByOffer(offerId) {
  if (!offerId) return;
  (S.free.items || []).forEach((it) => {
    if (it.offerId === offerId) markWebFallback(it);
  });
}

/* ---------------------------- Epic 登录与一键领取 ----------------------------
 * 支持多个 Epic 号：账号存在加密区，可分别勾选「参与领取」。
 * 领取时按勾选的账号逐个提交，结果按账号分开回报。
 */

function epicEnabledAccounts() {
  return (S.epic.accounts || []).filter((a) => a.enabled);
}

function epicShortName(a) {
  return a && (a.displayName || '…' + String(a.accountId || '').slice(-4));
}

function epicLabel() {
  const all = S.epic.accounts || [];
  if (!all.length) return '';
  if (all.length === 1) return epicShortName(all[0]);
  return `${epicShortName(all[0])} 等 ${all.length} 个号`;
}

/** 免费页顶部账号条：按当前筛选只显示对应平台，切换 Steam/GOG 时不再挂着 Epic */
function renderEpicBar() {
  const bar = $('#freeEpicBar');
  if (!bar) return;
  const f = S.free.filter;
  const parts = [];

  if (f === 'all' || f === 'epic') {
    if (S.epic.linked) {
      const on = epicEnabledAccounts().length;
      parts.push(
        '<span class="fe-main">' +
          `<span class="fe-lab"><span class="epic-dot ${on ? '' : 'off'}"></span>Epic 已登录：<b>${esc(epicLabel())}</b></span>` +
          `<span class="dim2 fe-note">（参与领取 ${on} 个号）</span>` +
        '</span>' +
          '<button class="btn s" id="epicManage">管理账号</button>'
      );
    } else {
      parts.push(
        '<span class="fe-main">' +
          '<span class="fe-lab"><span class="epic-dot off"></span>Epic 未登录</span>' +
          '<span class="dim2 fe-note">登录后可以在软件内一键领取</span>' +
        '</span>' +
          '<button class="btn s" id="epicLogin">登录 Epic</button>'
      );
    }
  }

  if (f === 'all' || f === 'steam') {
    const cur = (S.accounts || []).find((a) => a.steamId === S.currentSteamId);
    const nm = cur ? cur.personaName || cur.accountName : '';
    if (S.steamFree && S.steamFree.linked) {
      parts.push(
        '<span class="fe-main">' +
          `<span class="fe-lab"><span class="epic-dot"></span>Steam 已登录${nm ? `：<b>${esc(nm)}</b>` : ''}</span>` +
          '<span class="dim2 fe-note">（免费包会直接入库）</span>' +
        '</span>' +
          '<button class="btn s" id="steamRelogin">重新登录</button>'
      );
    } else {
      parts.push(
        '<span class="fe-main">' +
          '<span class="fe-lab"><span class="epic-dot off"></span>Steam 未登录</span>' +
          '<span class="dim2 fe-note">登录后免费包可直接入库</span>' +
        '</span>' +
          '<button class="btn s" id="steamLogin">登录 Steam</button>'
      );
    }
  }

  if (f === 'all' || f === 'gog') {
    if (S.gogFree && S.gogFree.linked) {
      parts.push(
        '<span class="fe-main">' +
          '<span class="fe-lab"><span class="epic-dot"></span>GOG 已登录</span>' +
          '<span class="dim2 fe-note">（赠送可一键领取）</span>' +
        '</span>' +
          '<button class="btn s" id="gogManage">管理账号</button>'
      );
    } else {
      parts.push(
        '<span class="fe-main">' +
          '<span class="fe-lab"><span class="epic-dot off"></span>GOG 未登录</span>' +
          '<span class="dim2 fe-note">登录后可直接领取赠送</span>' +
        '</span>' +
          '<button class="btn s" id="gogLogin">登录 GOG</button>'
      );
    }
  }

  // 每个平台包一层，窄窗口时整组换行，不会出现"按钮单独掉到下一行"
  bar.innerHTML = parts.map((p) => `<span class="fe-item">${p}</span>`).join('');

  const m = $('#epicManage');
  if (m) m.onclick = () => goto('accounts');
  const el = $('#epicLogin');
  if (el) el.onclick = () => epicLogin();
  const sl = $('#steamLogin');
  if (sl) sl.onclick = () => steamWebLogin();
  const sr = $('#steamRelogin');
  if (sr) sr.onclick = () => steamWebLogin();
  const gl = $('#gogLogin');
  if (gl) gl.onclick = () => gogWebLogin();
  const gm = $('#gogManage');
  if (gm) gm.onclick = () => goto('accounts');

  const all = $('#freeClaimAll');
  if (all) {
    if (f === 'steam') all.textContent = '一键领取全部 Steam';
    else if (f === 'gog') all.textContent = '一键领取 GOG 赠送';
    else
      all.textContent = S.epic.linked
        ? `一键领取 Epic（${epicEnabledAccounts().length} 个号）`
        : '登录 Epic 并领取';
  }
}

/** 顶部按钮里的登录动作；登录完刷新状态条 */
async function steamWebLogin() {
  toast('已打开 Steam 登录窗口，请在窗口里完成登录');
  const r = await call(SD.session.login(), { noLog: true, silent: true });
  if (!r.ok) {
    if (!/已关闭/.test(r.message || '')) toast(r.message || 'Steam 登录失败', true);
    return;
  }
  await scanAccounts({ quiet: true });
  await loadFreeAccounts();
  toast('Steam 登录成功');
}

async function gogWebLogin() {
  toast('已打开 GOG 登录窗口，请在窗口里完成登录');
  const r = await call(SD.gog.login(), { noLog: true, silent: true });
  if (!r.ok) {
    if (!/已关闭/.test(r.message || '')) toast(r.message || 'GOG 登录失败', true);
    return;
  }
  await loadFreeAccounts();
  toast('GOG 登录成功');
}

/** 读取 Steam / GOG 的登录状态，供免费页顶部条和批量按钮使用 */
async function loadFreeAccounts() {
  const [st, gs] = await Promise.all([
    call(SD.steamFree.status(), { noLog: true, silent: true }),
    call(SD.gog.status(), { noLog: true, silent: true }),
  ]);
  S.steamFree = { linked: !!(st.ok && st.data && st.data.linked) };
  S.gogFree = { linked: !!(gs.ok && gs.data && gs.data.linked) };
  renderEpicBar();
}

function renderEpicAccounts() {
  const box = $('#epicAccList');
  if (!box) return;
  const list = S.epic.accounts || [];
  if ($('#epicAccCount')) $('#epicAccCount').textContent = list.length ? `${list.length} 个` : '';
  if (!list.length) {
    box.innerHTML =
      '<div class="empty" style="grid-column:1/-1"><b>还没有添加 Epic 账号</b>点右上「添加 Epic 账号」，在弹出的窗口里登录即可——登录几个就存几个，领取时按勾选的号逐个入库。</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (a) => `<div class="acard ${a.enabled ? 'on' : ''}">
      <div class="top">
        <div class="av2" style="background:linear-gradient(135deg,#C3A6F0,#5A2EA6)">${esc(
          initial(a.displayName || 'E')
        )}</div>
        <div style="min-width:0">
          <div class="nm" data-copy="${esc(a.displayName || '')}" data-copy-label="Epic 昵称" title="点击复制昵称">${esc(a.displayName || 'Epic 账号')}</div>
          <div class="sub">Epic 账号</div>
        </div>
        <div class="st2 ${a.enabled ? 'on' : 'off'}"><span class="dot ${
        a.enabled ? '' : 'o'
      }"></span>${a.enabled ? '参与领取' : '已暂停'}</div>
      </div>
      <div class="ast">
        <div data-copy="${esc(a.accountId)}" data-copy-label="Epic 账号 ID" title="点击复制完整账号 ID"><div class="k">账号 ID</div><div class="v sid">…${esc(String(a.accountId).slice(-6))}</div></div>
        <div data-copy="${a.hasSession ? '已保存' : '需重新登录'}" data-copy-label="领取会话" title="点击复制"><div class="k">领取会话</div><div class="v">${
          a.hasSession ? '已保存' : '需重新登录'
        }</div></div>
      </div>
      <div class="arow">
        <label class="epic-toggle"><input type="checkbox" data-epic-enable="${esc(
          a.accountId
        )}" ${a.enabled ? 'checked' : ''}> 参与</label>
        <button class="btn s" data-epic-del="${esc(a.accountId)}" style="margin-left:auto">删除</button>
      </div>
    </div>`
    )
    .join('');

  box.querySelectorAll('[data-epic-enable]').forEach((cb) => {
    cb.onchange = async () => {
      const r = await call(SD.epic.setEnabled(cb.dataset.epicEnable, cb.checked), {
        noLog: true,
        silent: true,
      });
      if (r.ok) {
        await loadEpicStatus();
        toast(cb.checked ? '已加入批量领取' : '已暂停该号');
      } else {
        cb.checked = !cb.checked;
        toast(r.message || '操作失败', true);
      }
    };
  });

  box.querySelectorAll('[data-epic-del]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.epicDel;
      const acc = (S.epic.accounts || []).find((x) => x.accountId === id);
      const ok = await askConfirm({
        title: '移除这个 Epic 账号？',
        sub: acc ? acc.displayName || acc.accountId : id,
        tone: 'warn',
        icon: '!',
        notes: ['只删掉本软件保存的登录令牌，Epic 账号和已领取的游戏都不受影响。'],
        okText: '移除',
      });
      if (!ok) return;
      await call(SD.epic.remove(id), { noLog: true, silent: true });
      await loadEpicStatus();
      toast('已移除');
    };
  });
}

async function loadEpicStatus() {
  const r = await call(SD.epic.status(), { noLog: true, silent: true });
  const d = (r.ok && r.data) || { linked: false, accounts: [] };
  S.epic.accounts = d.accounts || [];
  S.epic.linked = S.epic.accounts.length > 0;
  renderEpicBar();
  renderEpicAccounts();
  renderFree();
}

async function epicLogin() {
  if (S.epic.busy) return false;
  S.epic.busy = true;
  toast('已打开 Epic 登录窗口，请在窗口里完成登录');
  const r = await call(SD.epic.login(), { noLog: true, silent: true });
  S.epic.busy = false;
  if (!r.ok) {
    if (/已关闭/.test(r.message || '')) {
      log('Epic 登录窗口已关闭，未登录');
    } else {
      toast(r.message || 'Epic 登录失败', true);
      log(`Epic 登录失败：${r.message || '未知原因'}`, 'r');
    }
    return false;
  }
  await loadEpicStatus();
  const cnt = (r.data && r.data.count) || (S.epic.accounts || []).length;
  toast(`Epic 已登录：${(r.data && r.data.displayName) || ''}（共 ${cnt} 个号）`);
  log(`Epic 账号已保存：${(r.data && r.data.displayName) || ''}（共 ${cnt} 个号）`, 'g');
  return true;
}

function epicClaimables() {
  return (S.free.items || []).filter(
    (x) => x.platform === 'epic' && x.offerId && x.namespace && !x.upcoming && !x.claimed
  );
}

/**
 * 在软件内领取 Epic 免费游戏（按勾选的账号逐个领）。
 * 价格校验在主进程里做：非 0 元订单直接中止。
 */
async function epicClaim(items, btn) {
  if (S.epic.busy) return;
  if (!S.epic.linked && !(await epicLogin())) return;

  const list = (items || []).filter((x) => x.offerId && x.namespace);
  if (!list.length) {
    toast('没有可领取的 Epic 条目');
    return;
  }
  const accs = epicEnabledAccounts();
  if (!accs.length) {
    toast('没有勾选参与领取的 Epic 账号，去账号管理里勾一个', true);
    return;
  }

  S.epic.busy = true;
  beginRun('Epic 领取');
  const oldText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '领取中…';
  }
  toast(`正在为 ${accs.length} 个号领取 ${list.length} 个游戏…`);

  const r = await call(
    SD.epic.claim(list.map((x) => ({ offerId: x.offerId, namespace: x.namespace, title: x.title }))),
    { noLog: true, silent: true }
  );

  S.epic.busy = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = oldText;
  }
  if (!r.ok) {
    toast(r.message || '领取失败', true);
    log(`Epic 领取失败：${r.message || '未知原因'}`, 'r');
    return;
  }

  const data = r.data || {};
  const results = data.accounts || [];
  const allOk = new Set();

  results.forEach((acc) => {
    const who = acc.displayName || acc.accountId;
    if (!acc.ok) {
      toast(`${who} 领取失败：${acc.error || '登录过期'}`, true);
      log(`${who}：${acc.error || '登录过期'}`, 'r');
      addRunRow({
        platform: 'epic',
        account: who,
        title: `账号 ${who}`,
        state: 'fail',
        message: acc.error || '登录过期',
      });
      return;
    }
    acc.results.forEach((x) => {
      const item = list.find((it) => it.offerId === x.offerId);
      const state = !x.ok
        ? 'fail'
        : x.state === 'owned'
          ? 'owned'
          : x.verified
            ? 'ok'
            : 'pending';
      addRunRow({
        platform: 'epic',
        account: who,
        title: x.title || (item && item.title) || '未知条目',
        state,
        message: x.message || '',
        item,
      });
      if (!x.ok) {
        // 自动领取没成功（登录过期、需要人工点、页面改版等）：卡片上给一个网页领取入口
        markWebFallbackByOffer(x.offerId);
        log(`${who} 领取失败：${x.title} — ${x.message}`, 'r');
      } else if (x.state === 'owned') {
        log(`${who} 已在库中：${x.title}`, 'g');
      } else if (x.verified) {
        log(`${who} 领取成功并已入库：${x.title}`, 'g');
      } else {
        log(`${who} 已提交但库里还没查到：${x.title} — ${x.message || ''}`, 'a');
      }
    });
  });

  // 只有真的有号把游戏放进库里（已拥有或核对通过），才标成"已领取"
  list.forEach((it) => {
    const done = results.length > 0 && results.every(
      (acc) =>
        acc.ok &&
        acc.results.some(
          (x) => x.offerId === it.offerId && (x.state === 'owned' || x.verified)
        )
    );
    if (done) allOk.add(it.offerId);
  });
  (S.free.items || []).forEach((x) => {
    if (allOk.has(x.offerId)) x.claimed = true;
  });
  finishRun();

  const confirmed = results.reduce(
    (n, a) =>
      n + (a.results || []).filter((x) => x.ok && (x.state === 'owned' || x.verified)).length,
    0
  );
  const submitted = results.reduce((n, a) => n + (a.results || []).filter((x) => x.ok).length, 0);
  const total = data.total || 0;
  if (confirmed > 0) {
    toast(
      `领取完成：${accs.length} 个号确认入库 ${confirmed} 件（提交 ${submitted}/${total} 次）`.slice(0, 110)
    );
  } else if (submitted > 0) {
    toast('Epic 已受理，但库里暂时还没查到，稍后点刷新再看', true);
  } else {
    const firstFail = results
      .flatMap((a) => (a.results || []).filter((x) => !x.ok))
      .find(Boolean);
    toast(
      (firstFail && `领取失败：${firstFail.message}`) || '这次没有领取成功，详情看日志',
      true
    );
  }
}

/**
 * Steam 免费包：先看它最终跳到哪
 *   · Steam 商店页 → 主进程用 addfreelicense 直接入库
 *   · 第三方站点 → 帮用户打开浏览器，剩下的要自己领
 */
async function steamClaimOne(item) {
  const r = await call(SD.steamFree.claim({ url: item.url, title: item.title }), {
    noLog: true,
    silent: true,
  });
  if (!r.ok) return { kind: 'error', message: r.message || '领取失败' };
  const d = r.data || {};
  if (d.state === 'external') return { kind: 'external', url: d.url || item.url, message: d.message || '' };
  if (d.ok) {
    S.free.claimed[item.id] = true;
    return { kind: 'ok', message: d.message || '已领取' };
  }
  return { kind: 'fail', message: d.message || '领取失败' };
}

async function steamClaim(item, btn) {
  if (!item || S.free.busy) return;
  S.free.busy = true;
  beginRun('Steam 领取');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '领取中…';
  }
  const res = await steamClaimOne(item);
  S.free.busy = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '一键领取';
  }
  if (res.kind === 'external') {
    addRunRow({ platform: 'steam', title: item.title, state: 'external', message: res.message, item });
    finishRun();
    toast('这个活动要跳转到第三方站点领取，已帮你打开');
    await call(SD.app.openExternal(res.url), { noLog: true, silent: true });
    return;
  }
  if (res.kind === 'ok' || res.kind === 'owned') {
    addRunRow({
      platform: 'steam',
      title: item.title,
      state: res.kind === 'owned' ? 'owned' : 'ok',
      message: res.message,
      item,
    });
    finishRun();
    toast(`${item.title}：${res.message}`);
    log(`Steam 领取成功：${item.title}（${res.message}）`, 'g');
  } else {
    addRunRow({ platform: 'steam', title: item.title, state: 'fail', message: res.message, item });
    markWebFallback(item);
    finishRun();
    toast(`${item.title}：${res.message}`, true);
    log(`Steam 领取失败：${item.title} — ${res.message}`, 'r');
  }
}

function steamClaimables() {
  return (S.free.items || []).filter(
    (x) => x.platform === 'steam' && !x.upcoming && !x.claimed && !S.free.claimed[x.id]
  );
}

/** Steam 批量：逐个解析并领取；第三方活动不逐个弹浏览器，只记日志 */
async function steamClaimAll(btn) {
  if (S.free.busy) return;
  const list = steamClaimables();
  if (!list.length) {
    toast('当前没有可领取的 Steam 条目');
    return;
  }
  S.free.busy = true;
  beginRun('Steam 批量领取');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '领取中…';
  }
  let ok = 0;
  let owned = 0;
  let ext = 0;
  let fail = 0;
  for (const it of list) {
    const res = await steamClaimOne(it);
    const rowState =
      res.kind === 'ok'
        ? 'ok'
        : res.kind === 'owned'
          ? 'owned'
          : res.kind === 'external'
            ? 'external'
            : 'fail';
    addRunRow({ platform: 'steam', title: it.title, state: rowState, message: res.message, item: it });
    if (res.kind === 'ok') {
      ok += 1;
      log(`Steam 领取成功：${it.title}（${res.message}）`, 'g');
    } else if (res.kind === 'owned') {
      owned += 1;
      log(`Steam 已在库中：${it.title}`, 'g');
    } else if (res.kind === 'external') {
      ext += 1;
      log(`Steam 需去第三方站点领取：${it.title} — ${res.url}`, 'b');
    } else {
      fail += 1;
      markWebFallback(it);
      log(`Steam 领取失败：${it.title} — ${res.message}`, 'r');
    }
    renderFree();
  }
  S.free.busy = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '一键领取全部 Steam';
  }
  finishRun();
  toast(
    `Steam 领取完成：入库 ${ok}、已在库 ${owned}${ext ? `、需手动 ${ext}` : ''}${
      fail ? `、失败 ${fail}` : ''
    }`.slice(0, 120)
  );
}

async function gogClaimOne(item) {
  const r = await call(SD.gog.claim(), { noLog: true, silent: true });
  if (!r.ok) return { kind: 'error', message: r.message || '领取失败' };
  const d = r.data || {};
  if (d.ok) {
    if (item) S.free.claimed[item.id] = true;
    return { kind: 'ok', message: d.message || '已领取' };
  }
  return { kind: 'fail', message: d.message || '领取失败' };
}

/** GOG：官方站内赠送接口，认登录 Cookie；一次领当前正在送的那款 */
async function gogClaim(item, btn) {
  if (!item || S.free.busy) return;
  S.free.busy = true;
  beginRun('GOG 领取');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '领取中…';
  }
  const res = await gogClaimOne(item);
  S.free.busy = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '一键领取';
  }
  if (res.kind === 'ok') {
    addRunRow({ platform: 'gog', title: item.title, state: 'ok', message: res.message, item });
    finishRun();
    toast(`${item.title}：${res.message}`);
    log(`GOG 领取成功：${item.title}（${res.message}）`, 'g');
    return;
  }
  const msg = res.message || '领取失败';
  addRunRow({ platform: 'gog', title: item.title, state: 'fail', message: msg, item });
  markWebFallback(item);
  finishRun();
  toast(/未登录|登录/.test(msg) ? 'GOG 未登录：请先点上方「登录 GOG」' : msg, true);
  log(`GOG 领取失败：${msg}`, 'r');
}

function gogClaimables() {
  return (S.free.items || []).filter(
    (x) => x.platform === 'gog' && !x.upcoming && !x.claimed && !S.free.claimed[x.id]
  );
}

async function gogClaimAll(btn) {
  if (S.free.busy) return;
  const list = gogClaimables();
  if (!list.length) {
    toast('当前没有可领取的 GOG 赠送');
    return;
  }
  S.free.busy = true;
  beginRun('GOG 批量领取');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '领取中…';
  }
  let ok = 0;
  let fail = 0;
  for (const it of list) {
    const res = await gogClaimOne(it);
    addRunRow({
      platform: 'gog',
      title: it.title,
      state: res.kind === 'ok' ? 'ok' : 'fail',
      message: res.message,
      item: it,
    });
    if (res.kind === 'ok') {
      ok += 1;
      log(`GOG 领取成功：${it.title}（${res.message}）`, 'g');
    } else {
      fail += 1;
      markWebFallback(it);
      log(`GOG 领取失败：${it.title} — ${res.message}`, 'r');
    }
    renderFree();
  }
  S.free.busy = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '一键领取 GOG 赠送';
  }
  finishRun();
  toast(`GOG 领取完成：入库 ${ok}${fail ? `、失败 ${fail}` : ''}`);
}

if ($('#freeList')) {
  $$('#freeFilter .tab').forEach((b) => {
    b.onclick = () => {
      $$('#freeFilter .tab').forEach((x) => x.classList.toggle('on', x === b));
      S.free.filter = b.dataset.fp || 'all';
      renderFree();
      renderEpicBar();
    };
  });
  if ($('#freeGameOnly')) {
    $('#freeGameOnly').onchange = (e) => {
      S.free.gameOnly = !!e.target.checked;
      renderFree();
    };
  }
  if ($('#freeRefresh')) {
    $('#freeRefresh').onclick = () => loadFree({ force: true });
  }
  if ($('#freeExport')) {
    $('#freeExport').onclick = exportFreeCsv;
  }
  if ($('#freeClaimAll')) {
    $('#freeClaimAll').onclick = () => {
      const f = S.free.filter;
      if (f === 'steam') return steamClaimAll($('#freeClaimAll'));
      if (f === 'gog') return gogClaimAll($('#freeClaimAll'));
      return epicClaim(epicClaimables(), null);
    };
  }

  $('#freeList').addEventListener('click', async (e) => {
    // 领取结果面板：收起 / 网页领取 / 重试
    const rc = e.target.closest('[data-run-close]');
    if (rc) {
      S.free.lastRun = null;
      renderFree();
      return;
    }
    const rw = e.target.closest('[data-run-web]');
    if (rw) {
      await call(SD.app.openExternal(rw.dataset.runWeb), { noLog: true, silent: true });
      return;
    }
    const rr = e.target.closest('[data-run-retry]');
    if (rr) {
      await retryRunRow(Number(rr.dataset.runRetry));
      return;
    }
    // Epic：软件内领取
    const eb = e.target.closest('[data-epic-claim]');
    if (eb) {
      if (eb.disabled) return;
      const item = (S.free.items || []).find((x) => x.offerId === eb.dataset.offer);
      await epicClaim(item ? [item] : [], eb);
      return;
    }
    // Steam / GOG：软件内领取
    const sb = e.target.closest('[data-steam-claim]');
    if (sb) {
      if (sb.disabled) return;
      const item = (S.free.items || []).find((x) => x.id === sb.dataset.steamClaim);
      if (item) await steamClaim(item, sb);
      return;
    }
    const gb = e.target.closest('[data-gog-claim]');
    if (gb) {
      if (gb.disabled) return;
      const item = (S.free.items || []).find((x) => x.id === gb.dataset.gogClaim);
      if (item) await gogClaim(item, gb);
      return;
    }
    // 其它平台：只能开浏览器，领取得用用户自己的登录态
    const btn = e.target.closest('[data-claim]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const url = btn.dataset.claim;
    if (!url) return;
    btn.disabled = true;
    const r = await call(SD.app.openExternal(url), { noLog: true, silent: true });
    if (!r.ok) toast(r.message || '无法打开链接', true);
    setTimeout(() => { btn.disabled = false; }, 1200);
  });
}

/* ============================ 命令面板（Ctrl+K） ============================
   一个输入框搜全部：页面、常用功能、账号、库存物品。
   只调用已有函数，不复制业务逻辑，避免两套行为走偏。 */
const CMDK = { items: [], filtered: [], idx: 0 };

function cmdkCommands() {
  const out = [];
  const pages = [
    ['overview', '概览'],
    ['inventory', '饰品仓库'],
    ['orders', '市场挂单'],
    ['storeNews', '查价与挂机'],
    ['free', '免费领取'],
    ['accounts', '账号管理'],
    ['library', '游戏库'],
  ];
  pages.forEach(([p, n]) => out.push({ kind: '页面', icon: '页', name: n, hint: '打开页面', run: () => goto(p) }));

  const acts = [
    ['表', '经营报表', '按天 / 按游戏汇总', () => { goto('overview'); reportOpen(); }],
    ['本', '成本管理', '回填每件买入价', () => { goto('inventory'); costOpen(); }],
    ['检', '账号体检', '登录态与市场限制', () => healthOpen()],
    ['单', '同步市场挂单', '读取当前账号在售', () => { goto('orders'); syncOrders(); }],
    ['补', '补货队列', '库存够就自动补挂', () => { goto('orders'); restockOpen(); }],
    ['价', '智能定价', '按行情给出建议售价', async () => { goto('orders'); await openPriceSuggest(); }],
    ['设', '打开设置', '通知、阶梯降价、归档、更新', () => openDrawer()],
    ['导', '使用向导', '重新走一遍初始化步骤', () => wizardOpen(0)],
  ];
  acts.forEach(([icon, name, hint, run]) => out.push({ kind: '功能', icon, name, hint, run }));

  const paused = !!(S.settings && S.settings.automationPaused);
  out.push({
    kind: '开关',
    icon: '停',
    name: paused ? '关闭维护模式（恢复自动任务）' : '打开维护模式（暂停自动任务）',
    hint: '补货 / 阶梯降价 / 定时巡检',
    run: async () => {
      const r = await call(SD.automation.pause(!paused), { silent: true });
      if (r.ok) {
        if (S.settings) S.settings.automationPaused = !paused;
        toast(!paused ? '已暂停所有自动任务' : '自动任务已恢复');
      } else toast(r.message || '切换失败', true);
    },
  });

  (S.accounts || []).forEach((a) => {
    const cur = a.steamId === S.currentSteamId;
    out.push({
      kind: '账号',
      icon: initial(a.personaName || a.accountName),
      name: a.personaName || a.accountName,
      hint: cur ? '当前账号' : '切换到该账号',
      run: () => doSwitch(a.steamId),
    });
  });

  (S.invRows || []).slice(0, 1200).forEach((row) => {
    out.push({
      kind: '库存',
      icon: '物',
      name: row.name,
      hint: `${row.qty || 0} 件${row.lowestPrice > 0 ? ' · ' + money(row.lowestPrice) : ''}`,
      run: () => {
        goto('inventory');
        openItemDetail(row);
      },
    });
  });
  return out;
}

/** 匹配打分：前缀 > 包含 > 类型/说明包含 > 按顺序出现 */
function cmdkScore(it, q) {
  const name = String(it.name || '').toLowerCase();
  const hint = String(it.hint || '').toLowerCase();
  const kind = String(it.kind || '').toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (kind.includes(q)) return 40;
  if (hint.includes(q)) return 25;
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i >= q.length ? 10 : -1;
}

function cmdkHi(text, q) {
  const s = String(text || '');
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<b>' + esc(s.slice(i, i + q.length)) + '</b>' + esc(s.slice(i + q.length));
}

function cmdkRender() {
  const list = $('#cmdkList');
  if (!list) return;
  const q = ($('#cmdkInput').value || '').trim().toLowerCase();
  const scored = CMDK.items
    .map((it) => ({ it, s: q ? cmdkScore(it, q) : 1 }))
    .filter((x) => x.s >= 0);
  scored.sort((a, b) => b.s - a.s);
  CMDK.total = scored.length;
  CMDK.filtered = scored.slice(0, 30).map((x) => x.it);
  if (CMDK.idx >= CMDK.filtered.length) CMDK.idx = 0;
  if (!CMDK.filtered.length) {
    list.innerHTML = '<div class="cmdk-empty">没有匹配的页面、功能、账号或物品</div>';
  } else {
    list.innerHTML = CMDK.filtered
      .map(
        (it, i) =>
          `<div class="cmdk-item${i === CMDK.idx ? ' on' : ''}" data-ci="${i}">` +
          `<span class="ci">${esc(it.icon || '·')}</span>` +
          `<span class="cn">${cmdkHi(it.name, q)}</span>` +
          `<span class="ck">${esc(it.kind)}${it.hint ? ' · ' + esc(it.hint) : ''}</span>` +
          `</div>`
      )
      .join('');
  }
  const cnt = $('#cmdkCount');
  if (cnt) {
    const total = CMDK.total || CMDK.filtered.length;
    cnt.textContent = total > CMDK.filtered.length
      ? `显示 ${CMDK.filtered.length} / 匹配 ${total} 项`
      : `${total} 项`;
  }
  const on = list.querySelector('.cmdk-item.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function cmdkOpen() {
  const mask = $('#cmdkMask');
  if (!mask) return;
  CMDK.items = cmdkCommands();
  CMDK.idx = 0;
  mask.classList.add('on');
  const inp = $('#cmdkInput');
  if (inp) inp.value = '';
  cmdkRender();
  setTimeout(() => inp && inp.focus(), 30);
}

function cmdkClose() {
  const mask = $('#cmdkMask');
  if (mask) mask.classList.remove('on');
}

function cmdkMove(d) {
  const n = CMDK.filtered.length;
  if (!n) return;
  CMDK.idx = (CMDK.idx + d + n) % n;
  cmdkRender();
}

function cmdkRun(i) {
  const it = CMDK.filtered[i];
  if (!it) return;
  cmdkClose();
  try {
    const p = it.run();
    if (p && typeof p.catch === 'function') p.catch((e) => toast((e && e.message) || '执行失败', true));
  } catch (e) {
    toast((e && e.message) || '执行失败', true);
  }
}

if ($('#cmdkMask')) {
  $('#cmdkMask').addEventListener('click', (e) => {
    if (e.target === $('#cmdkMask')) cmdkClose();
  });
  $('#cmdkList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-ci]');
    if (t) cmdkRun(Number(t.dataset.ci));
  });
  $('#cmdkInput').addEventListener('input', () => {
    CMDK.idx = 0;
    cmdkRender();
  });
  $('#cmdkInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(CMDK.idx); }
    else if (e.key === 'Escape') { e.preventDefault(); cmdkClose(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if ($('#cmdkMask').classList.contains('on')) cmdkClose();
      else cmdkOpen();
    }
  });
}

// Alt+1…7 直接切页；在输入框里按不触发，避免和输入冲突
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const tag = String((e.target && e.target.tagName) || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.target && e.target.isContentEditable) return;
  if (!/^[1-7]$/.test(e.key)) return;
  const pages = ['overview', 'inventory', 'orders', 'storeNews', 'free', 'accounts', 'library'];
  const page = pages[Number(e.key) - 1];
  if (!page) return;
  e.preventDefault();
  goto(page);
});

/* ------------------------------ 首次使用向导 ------------------------------ */
const WIZ = { step: 0 };
const WIZ_TITLES = ['欢迎使用 SteamDesk', 'Steam 安装目录', '登录账号', '开始使用'];

function wizCurName() {
  const a = (S.accounts || []).find((x) => x.steamId === S.currentSteamId);
  return a ? a.personaName || a.accountName : '';
}

function renderWizard() {
  const body = $('#wizBody');
  if (!body) return;
  const step = WIZ.step;
  const s = S.settings || {};
  $$('#wizDots .wiz-dot').forEach((d, i) => d.classList.toggle('on', i <= step));
  if ($('#wizTitle')) $('#wizTitle').textContent = WIZ_TITLES[step] || '使用向导';
  if ($('#wizPrev')) {
    $('#wizPrev').disabled = step === 0;
    $('#wizPrev').style.opacity = step === 0 ? '.45' : '';
  }
  if ($('#wizNext')) $('#wizNext').textContent = step === WIZ_TITLES.length - 1 ? '开始使用' : '下一步';

  if (step === 0) {
    body.innerHTML =
      '<p class="wiz-p">这个软件做三件事：管多账号、把饰品挂到 Steam 市场、盯着价格与滞销自动处理。第一次用只需要三步。</p>' +
      '<div class="wiz-box"><b>1.</b> 确认 Steam 安装目录，软件靠它读本地账号与库存。<br>' +
      '<b>2.</b> 选一个账号网页登录一次，之后会自动记住登录态。<br>' +
      '<b>3.</b> 到「饰品仓库」拉取库存，就能批量定价、上架、看盈亏。</div>' +
      '<p class="wiz-p" style="margin-top:10px">不确定的先跳过，随时能从「设置 → 重新查看使用向导」再看一遍。</p>';
  } else if (step === 1) {
    const path = s.steamPath || (S.info && S.info.steamPath) || '';
    body.innerHTML =
      '<p class="wiz-p">用于读取 Steam 客户端的账号列表与库存缓存。自动探测不到时，手动选到 Steam.exe 所在目录。</p>' +
      `<div class="wiz-box">当前路径：<b>${esc(path || '未探测到')}</b><br>` +
      `${path ? '已设置，可以进入下一步。' : '建议现在选择一次，否则后面的账号与库存都会读不到。'}</div>` +
      '<div class="wiz-row"><button class="btn s" data-wiz-action="pickPath">选择 Steam 目录</button>' +
      '<button class="btn s" data-wiz-action="rescan">重新探测账号</button></div>';
  } else if (step === 2) {
    const cur = wizCurName();
    body.innerHTML =
      `<p class="wiz-p">已检测到 <b>${(S.accounts || []).length}</b> 个本地账号${cur ? `，当前是 <b>${esc(cur)}</b>` : ''}。</p>` +
      '<div class="wiz-box">在「账号管理」里点「网页登录」，用 Steam 账号登录一次即可。软件会保存登录态，下次打开自动恢复；Steam 手机令牌可以导入，之后上架能自动确认。</div>' +
      '<div class="wiz-row"><button class="btn s" data-wiz-action="goAccounts">去账号管理登录</button>' +
      '<button class="btn s" data-wiz-action="rescan">刷新账号列表</button></div>';
  } else {
    body.innerHTML =
      '<p class="wiz-p">最后两件事建议现在就定：通知渠道和自动化总开关。</p>' +
      '<div class="wiz-box"><b>通知：</b>设置 → 通知外发，支持 Telegram / 企业微信 / 钉钉 / Server酱 / 自定义 Webhook。成交、滞销、账号被限制市场都会推给你。<br>' +
      '<b>自动化：</b>补货、阶梯降价、定时巡检默认关闭，决定用了再到设置或挂单页打开。<br>' +
      '<b>快捷键：</b><span class="wiz-kbd">Ctrl</span> + <span class="wiz-kbd">K</span> 打开命令面板，能搜页面、功能、账号和库存物品。</div>' +
      '<div class="wiz-row"><button class="btn s" data-wiz-action="goNotify">去设置通知</button>' +
      '<button class="btn s" data-wiz-action="goOrders">看一眼挂单页</button></div>';
  }
}

function wizardOpen(step) {
  WIZ.step = Math.max(0, Math.min(WIZ_TITLES.length - 1, Number(step) || 0));
  renderWizard();
  const m = $('#wizardModal');
  if (m) m.classList.add('on');
}

function wizardClose() {
  const m = $('#wizardModal');
  if (m) m.classList.remove('on');
  const s = S.settings || {};
  if (s.wizardDone !== true) {
    call(SD.settings.set({ wizardDone: true }), { silent: true, noLog: true }).then((r) => {
      if (r.ok) S.settings = r.data;
    });
  }
}

if ($('#wizardModal')) {
  if ($('#wizClose')) $('#wizClose').onclick = () => wizardClose();
  if ($('#wizSkip')) $('#wizSkip').onclick = () => wizardClose();
  if ($('#wizPrev')) $('#wizPrev').onclick = () => {
    if (WIZ.step > 0) wizardOpen(WIZ.step - 1);
  };
  if ($('#wizNext')) $('#wizNext').onclick = () => {
    if (WIZ.step < WIZ_TITLES.length - 1) wizardOpen(WIZ.step + 1);
    else wizardClose();
  };
  $('#wizBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-wiz-action]');
    if (!b) return;
    const act = b.dataset.wizAction;
    if (act === 'pickPath') {
      b.disabled = true;
      const r = await call(SD.settings.chooseSteamPath());
      b.disabled = false;
      if (r.ok && r.data) {
        if (!S.settings) S.settings = {};
        S.settings.steamPath = r.data;
        renderRailFooter();
        toast('Steam 路径已更新');
        renderWizard();
        scanAccounts({ quiet: true });
      }
      return;
    }
    if (act === 'rescan') {
      b.disabled = true;
      const r = await call(SD.accounts.list(), { silent: true, noLog: true });
      b.disabled = false;
      if (r.ok) {
        applyAccounts(r.data);
        renderAccounts();
        renderQuickAcc();
        renderCurrentBadge();
        renderWizard();
        toast(`已刷新，检测到 ${(S.accounts || []).length} 个账号`);
      }
      return;
    }
    if (act === 'goAccounts') { wizardClose(); goto('accounts'); return; }
    if (act === 'goNotify') { wizardClose(); openDrawer(); return; }
    if (act === 'goOrders') { wizardClose(); goto('orders'); return; }
  });
  $('#wizardModal').addEventListener('click', (e) => {
    if (e.target === $('#wizardModal')) wizardClose();
  });
}
if ($('#wizOpen')) $('#wizOpen').onclick = () => { closeDrawer(); wizardOpen(0); };

// 多窗口：子窗口通过 ?page=orders 启动后直接切到对应页
const BOOT_PAGE = new URLSearchParams(location.search).get('page') || '';

// 直接启动：loadInfo 内部自己会取一次 app.info，这里不必预调用
boot().then(() => {
  if (BOOT_PAGE) setTimeout(() => goto(BOOT_PAGE), 250);
});
