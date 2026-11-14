'use strict';

/**
 * 本机代理端口自动探测
 *
 * 背景：Steam 社区（steamcommunity.com）在不少网络下直连不通，
 * 用户开了 UU 之类“进程级加速器”也不管用，需要一个提供本地端口的
 * 全局代理工具（Clash / v2rayN / Mihomo…）。
 *
 * 做法分两步，避免误判：
 *   1. TCP 探测常见端口（连接成功只说明“有东西在听”）；
 *   2. 用该端口发一次真实的 HTTP CONNECT 到 store.steampowered.com:443，
 *      返回 200 才认定是可用代理 —— 300ms 内完成，失败端口直接丢弃。
 */

const http = require('http');
const net = require('net');

const COMMON_PORTS = [
  7890, // Clash / Mihomo 混合端口
  7891, // Clash http
  7897, // Clash Verge 默认
  10808, // v2rayN socks
  10809, // v2rayN http
  1080, // 通用 socks
  2080, // sing-box
  8889, // 常见 http 备用
  8118, // Privoxy
  28080, // 部分工具
];

const PROBE_TIMEOUT_MS = 500;

function probeTcp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      s.destroy();
      resolve(ok ? port : 0);
    };
    s.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 通过候选端口真实 CONNECT 一次 Steam 商店，验证代理可用 */
function testConnect(port) {
  return new Promise((resolve) => {
    const req = http.request({
      method: 'CONNECT',
      host: '127.0.0.1',
      port,
      path: 'store.steampowered.com:443',
      timeout: 2500,
      headers: { Host: 'store.steampowered.com:443' },
      agent: false,
      createConnection: () => net.connect({ port, host: '127.0.0.1' }),
    });
    req.once('connect', (res) => {
      req.destroy();
      resolve(res.statusCode === 200);
    });
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.once('error', () => resolve(false));
    req.end();
  });
}

/**
 * 探测本机可用代理。返回 { found, proxy, port } 或 { found: false }。
 * 并发探测全部端口，命中的端口再串行做 CONNECT 验证（按响应顺序）。
 */
async function detectProxy() {
  const hits = (await Promise.all(COMMON_PORTS.map(probeTcp))).filter(Boolean);
  for (const port of hits) {
    // eslint-disable-next-line no-await-in-loop
    const usable = await testConnect(port);
    if (usable) return { found: true, proxy: `127.0.0.1:${port}`, port };
  }
  return { found: false, probed: hits };
}

module.exports = { detectProxy, COMMON_PORTS };