'use strict';

/**
 * 自动化时段
 *
 * 补货、阶梯降价、自动守价这类后台任务，可以只在指定小时段内运行。
 * 支持跨午夜（例如 22 点到次日 7 点）。手动「立即检查」用 force 绕过，
 * 不受这里限制。
 */

const store = require('./store');

function hours() {
  const s = store.getSettings();
  const clamp = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(23, Math.max(0, Math.round(n))) : d;
  };
  return {
    enabled: s.autoWindowEnabled === true,
    start: clamp(s.autoWindowStart, 8),
    end: clamp(s.autoWindowEnd, 23),
  };
}

/** 当前时间是否在允许运行的时段内；未开启时段限制时永远为 true */
function inWindow(now = new Date()) {
  const { enabled, start, end } = hours();
  if (!enabled) return true;
  if (start === end) return true;
  const h = now.getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** 给界面和跳过原因用的可读描述，例如「08:00–23:00」 */
function describe() {
  const { start, end } = hours();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(start)}:00–${p(end)}:00`;
}

module.exports = { inWindow, describe, hours };
