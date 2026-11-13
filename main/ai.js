'use strict';

/**
 * AI 助手（可选）
 *
 * 兼容 OpenAI 的 /chat/completions 接口：用户可以填自己的接口地址、Key 和模型。
 * 只把本地汇总后的经营数据发出去，不发账号名、Cookie、库存明细。
 * 不配置就完全不会联网调用。
 */

const store = require('./store');
const logger = require('./logger');
const reports = require('./reports');

function options() {
  const s = store.getSettings();
  const base = String(s.aiBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return {
    enabled: s.aiEnabled === true,
    base,
    key: String(s.aiApiKey || '').trim(),
    model: String(s.aiModel || 'gpt-4o-mini').trim(),
  };
}

function ensure() {
  const o = options();
  if (!o.enabled) {
    throw Object.assign(new Error('AI 助手未开启：请到「设置 → AI 助手」打开并填写接口信息'), {
      code: 'E_AI_OFF',
    });
  }
  if (!o.key) {
    throw Object.assign(new Error('还没有填写 AI 接口 Key'), { code: 'E_AI_KEY' });
  }
  return o;
}

function timeout(ms, label) {
  let t = null;
  const p = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(Object.assign(new Error(`${label}超时（网络或代理问题）`), { code: 'E_TIMEOUT' })),
      ms
    );
  });
  return { promise: p, clear: () => clearTimeout(t) };
}

async function chat(messages, opts = {}) {
  const o = ensure();
  const guard = timeout(opts.timeoutMs || 90000, 'AI 接口');
  try {
    const res = await Promise.race([
      fetch(`${o.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${o.key}`,
        },
        body: JSON.stringify({
          model: o.model,
          temperature: 0.3,
          messages,
        }),
      }),
      guard.promise,
    ]);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 下面统一报错 */
    }
    if (!res.ok) {
      const msg =
        (json && json.error && (json.error.message || json.error.code)) ||
        `HTTP ${res.status}：${String(text).slice(0, 200)}`;
      throw Object.assign(new Error(`AI 接口返回错误：${msg}`), { code: 'E_AI_HTTP' });
    }
    const content =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content
        : '';
    if (!content) {
      throw Object.assign(new Error('AI 接口没有返回内容'), { code: 'E_AI_EMPTY' });
    }
    return String(content).trim();
  } finally {
    guard.clear();
  }
}

/** 把报表压成模型容易读的摘要，避免把整份原始数据发出去 */
function compact(report) {
  const t = report.totals || {};
  const week = report.week || {};
  const prev = report.prevWeek || {};
  const apps = (report.byApp || []).slice(0, 8).map((a) => ({
    appId: a.appId,
    sellN: a.sellN,
    received: a.received,
    realized: a.realized,
  }));
  return {
    days: report.days,
    currency: report.currency,
    sym: report.sym,
    totals: {
      sellN: t.sellN,
      gross: t.gross,
      received: t.received,
      fee: t.fee,
      spend: t.spend,
      realized: t.realized,
      net: t.net,
    },
    week: { sellN: week.sellN, received: week.received, realized: week.realized },
    prevWeek: { sellN: prev.sellN, received: prev.received, realized: prev.realized },
    holdDays: report.holdDays,
    holdSamples: report.holdSamples,
    topApps: apps,
  };
}

async function weeklyReport(days) {
  const report = await reports.build(Math.min(30, Math.max(7, Number(days) || 14)));
  const data = compact(report);
  const text = await chat([
    {
      role: 'system',
      content:
        '你是一个 Steam 饰品小生意的经营顾问。只根据用户给出的数据回答，不要编造不存在的数据；' +
        '用简体中文，给出结论、风险与 3 条具体可执行建议，控制在 350 字以内。',
    },
    {
      role: 'user',
      content:
        `这是我最近 ${data.days} 天的经营数据（金额单位：元，币种 ${data.currency}）：\n` +
        JSON.stringify(data, null, 2) +
        '\n请写一份简短的经营周报：本周表现、与上周对比、主要问题、下一步 3 条建议。',
    },
  ]);
  logger.info('AI 周报已生成', { days: data.days });
  return { text, at: Date.now(), days: data.days };
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q) throw Object.assign(new Error('先输入要问的问题'), { code: 'E_AI_QUESTION' });
  let data = null;
  try {
    data = compact(await reports.build(14));
  } catch (err) {
    data = { error: (err && err.message) || '读取报表失败' };
  }
  const text = await chat([
    {
      role: 'system',
      content:
        '你是 SteamDesk 的助手。只能依据给出的本地经营数据回答，数据里没有的就说不知道，' +
        '不要编造。回答用简体中文，尽量简短、可执行。',
    },
    {
      role: 'user',
      content: `本地经营摘要：\n${JSON.stringify(data, null, 2)}\n\n我的问题：${q}`,
    },
  ]);
  logger.info('AI 问答已回复', { chars: q.length });
  return { text, at: Date.now() };
}

async function test() {
  const o = ensure();
  const text = await chat(
    [{ role: 'user', content: '只回复两个字：可用' }],
    { timeoutMs: 30000 }
  );
  return { text, model: o.model, base: o.base };
}

module.exports = { options, weeklyReport, ask, test };
