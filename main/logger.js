'use strict';

/**
 * 极简日志：按天写文件，方便用户反馈问题时把 logs 目录发回来。
 *
 * 只记"发生了什么"，不记凭据：
 *   - 不打印 Cookie / Token / ssfn / API Key；
 *   - 调用方自己确保 message 里没有这些内容（领取、登录相关代码本来就不落日志）。
 */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
// 单日文件超过 5MB 就切一份，防止一个刷屏的异常把当天日志写成几百 MB
const MAX_FILE_BYTES = 5 * 1024 * 1024;
let dir = null;
let lastPrune = 0;

function init(baseDir) {
  if (!baseDir) return;
  dir = path.join(baseDir, 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    dir = null;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayName(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fileFor(d) {
  return path.join(dir, `${dayName(d)}.log`);
}

/** 超过 5MB 时把当天日志改名留档，后续写入新文件 */
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
    const base = file.replace(/\.log$/, '');
    let n = 1;
    while (fs.existsSync(`${base}.${n}.log`)) n++;
    fs.renameSync(file, `${base}.${n}.log`);
  } catch {
    /* 文件不存在或改名失败都不影响写入 */
  }
}

function prune() {
  if (!dir) return;
  if (Date.now() - lastPrune < 6 * 60 * 60 * 1000) return;
  lastPrune = Date.now();
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f))
      .sort();
    const extra = files.slice(0, Math.max(0, files.length - KEEP_DAYS));
    for (const f of extra) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function write(level, msg, meta) {
  if (!dir) return;
  let line = `[${new Date().toISOString()}] ${String(level).toUpperCase()} ${msg}`;
  if (meta !== undefined) {
    try {
      line += ` ${JSON.stringify(meta)}`;
    } catch {
      /* 忽略无法序列化的附加信息 */
    }
  }
  try {
    const target = fileFor(new Date());
    rotateIfNeeded(target);
    fs.appendFileSync(target, `${line}\n`, 'utf8');
  } catch {
    /* 写日志失败不能影响业务 */
  }
  prune();
}

function info(msg, meta) {
  write('info', msg, meta);
}

function warn(msg, meta) {
  write('warn', msg, meta);
}

function error(msg, meta) {
  write('error', msg, meta);
}

/** 最近 n 个日志文件的全文（默认 3 天），给诊断包用 */
function tail(n = 3) {
  if (!dir) return '';
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f))
      .sort()
      .slice(-n);
    return files
      .map((f) => {
        try {
          return `===== ${f} =====\n${fs.readFileSync(path.join(dir, f), 'utf8')}`;
        } catch {
          return '';
        }
      })
      .join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  init,
  info,
  warn,
  error,
  tail,
  get dir() {
    return dir;
  },
};
