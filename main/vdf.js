'use strict';

/**
 * 极简 VDF（Valve Data Format）解析器。
 * 支持 Qt 风格的嵌套键值 + 条件标签 [key=value]。
 * 只做读取用途，够解析 loginusers.vdf / config.vdf / libraryfolders.vdf / localconfig.vdf。
 */

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{' || ch === '}') { tokens.push(ch); i++; continue; }
    if (ch === '"') {
      i++;
      let buf = '';
      while (i < n) {
        const c = text[i];
        if (c === '\\' && i + 1 < n) {
          const next = text[i + 1];
          if (next === 'n') buf += '\n';
          else if (next === 't') buf += '\t';
          else if (next === '\\') buf += '\\';
          else if (next === '"') buf += '"';
          else buf += next;
          i += 2;
          continue;
        }
        if (c === '"') { i++; break; }
        buf += c;
        i++;
      }
      tokens.push({ str: buf });
      continue;
    }
    // 未加引号的 token（罕见，但条件块里会出现）
    let buf = '';
    while (i < n && !/\s/.test(text[i]) && text[i] !== '{' && text[i] !== '}' && text[i] !== '"') {
      buf += text[i];
      i++;
    }
    if (buf) tokens.push({ str: buf });
    else i++;
  }
  return tokens;
}

function parse(text) {
  const tokens = tokenize(text);
  let pos = 0;

  function parseBlock() {
    const obj = {};
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t === '}') { pos++; return obj; }
      if (t === '{') { pos++; continue; }
      if (typeof t === 'object' && t.str !== undefined) {
        const key = t.str;
        const next = tokens[pos + 1];
        if (next === '{') {
          pos += 2;
          obj[key] = parseBlock();
        } else if (next && typeof next === 'object' && next.str !== undefined) {
          obj[key] = next.str;
          pos += 2;
        } else {
          pos += 1;
        }
        continue;
      }
      pos++;
    }
    return obj;
  }

  return parseBlock();
}

/** 递归查找所有满足谓词的键值（返回 {path, value} 列表） */
function findEntries(obj, predicate, pathStr = '') {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = pathStr ? `${pathStr}/${k}` : k;
    if (v && typeof v === 'object') out.push(...findEntries(v, predicate, p));
    else if (predicate(k, v, p)) out.push({ path: p, key: k, value: v });
  }
  return out;
}

/** 按路径取值，路径用 / 分隔 */
function get(obj, pathStr) {
  return pathStr.split('/').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

/** 深度合并写入，返回是否改动 */
function setDeep(obj, pathStr, value) {
  const parts = pathStr.split('/');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (cur[last] === value) return false;
  cur[last] = value;
  return true;
}

/** 序列化为 VDF 文本（保留缩进层级，Steam 能正常读取） */
function stringify(obj, indent = 0) {
  const pad = '\t'.repeat(indent);
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      out += `${pad}"${k}"\n${pad}{\n${stringify(v, indent + 1)}${pad}}\n`;
    } else {
      out += `${pad}"${k}"\t\t"${String(v)}"\n`;
    }
  }
  return out;
}

module.exports = { parse, stringify, findEntries, get, setDeep };
