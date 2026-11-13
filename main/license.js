'use strict';

const store = require('./store');

/**
 * 授权层：现在自用阶段完全放行，但接口形态按收费版设计好。
 * 后续接服务端只需替换 verifyRemote()，渲染层不用改。
 *
 * 设计原则：
 *  1. 任何情况下不能因为授权服务不可达就把用户锁死在门外（离线宽限）
 *  2. 授权只控制"功能开关"，不控制本地数据
 */

const PLAN = {
  free: {
    id: 'free',
    name: '自用版',
    maxAccounts: 99,
    canSell: true,
    canBatchQuote: true,
    canExport: true,
    expiresAt: null,
  },
  pro: {
    id: 'pro',
    name: '专业版',
    maxAccounts: 20,
    canSell: true,
    canBatchQuote: true,
    canExport: true,
    expiresAt: null,
  },
};

let state = {
  plan: 'free',
  key: null,
  activatedAt: null,
  expiresAt: null,
  offlineGraceDays: 7,
  lastCheckAt: null,
  source: 'local',
};

function load() {
  const saved = store.readSecret('license');
  if (!saved) return state;
  try {
    const parsed = JSON.parse(saved);
    state = { ...state, ...parsed, source: 'cache' };
  } catch {
    /* 损坏就当作未激活 */
  }
  return state;
}

/** 真实校验：自用版直接通过，收费版接服务端 */
async function verifyRemote(key) {
  // 预留：POST https://your-license-server/api/verify { key, machineId }
  // 返回 { valid, plan, expiresAt }
  if (!key) return { valid: true, plan: 'free', expiresAt: null };
  return { valid: true, plan: 'pro', expiresAt: null, note: '本地校验模式（尚未接入服务端）' };
}

async function activate(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw Object.assign(new Error('授权码不能为空'), { code: 'E_EMPTY_KEY' });

  const res = await verifyRemote(trimmed);
  if (!res.valid) throw Object.assign(new Error('授权码无效或已过期'), { code: 'E_INVALID_KEY' });

  state = {
    ...state,
    plan: res.plan || 'pro',
    key: trimmed,
    activatedAt: Date.now(),
    expiresAt: res.expiresAt || null,
    lastCheckAt: Date.now(),
    source: 'remote',
  };

  try {
    store.saveSecret('license', JSON.stringify(state));
  } catch (err) {
    // 加密不可用时不影响本次会话使用，但要告诉用户
    throw Object.assign(new Error(`授权已生效，但凭证无法加密保存：${err.message}`), {
      code: 'E_NO_ENCRYPT',
    });
  }
  return status();
}

function status() {
  const plan = PLAN[state.plan] || PLAN.free;
  let expired = false;
  if (state.expiresAt) expired = Date.now() > state.expiresAt;
  return {
    ...state,
    planInfo: plan,
    expired,
    features: {
      canSell: plan.canSell && !expired,
      canBatchQuote: plan.canBatchQuote && !expired,
      canExport: plan.canExport && !expired,
      maxAccounts: plan.maxAccounts,
    },
  };
}

function deactivate() {
  state = {
    plan: 'free',
    key: null,
    activatedAt: null,
    expiresAt: null,
    offlineGraceDays: 7,
    lastCheckAt: null,
    source: 'local',
  };
  try {
    store.removeSecret('license');
  } catch {
    /* ignore */
  }
  return status();
}

load();

module.exports = { status, activate, deactivate, PLAN };
