'use strict';

/**
 * 用界面标题栏里的品牌 LOGO（index.html 的 .brand-logo SVG）
 * 渲染出应用图标，保证"桌面图标 / 任务栏 / 托盘 / 界面左上角"是同一个图形。
 *
 * 不手写一份图标位图是有意的：LOGO 以后微调，图标只要重新跑一次这个脚本，
 * 不会出现界面上换了、桌面还是老图标的情况。
 *
 * 用法：electron tools/make-icon.js
 * 产物：icon-src.png（256×256，透明背景）→ 再交给 make-ico 打成多尺寸 .ico
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

app.disableHardwareAcceleration();

function readBrandSvg() {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const m = html.match(/<svg class="brand-logo"[\s\S]*?<\/svg>/);
  if (!m) throw new Error('index.html 里没找到 .brand-logo');
  // 加白底透明：SVG 自带渐变与圆角矩形，直接按 256 铺满即可
  return m[0].replace('<svg class="brand-logo"', '<svg xmlns="http://www.w3.org/2000/svg" class="brand-logo"');
}

app.whenReady().then(async () => {
  try {
    const svg = readBrandSvg();
    const win = new BrowserWindow({
      width: 256,
      height: 256,
      show: false,
      frame: false,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: false },
    });

    const html = `<!doctype html><html><head><meta charset="utf-8">
      <style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden}
        canvas{display:block}
      </style></head><body><canvas id="cv" width="256" height="256"></canvas></body></html>`;

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    // 在渲染层用 canvas 画：能保留透明通道，capturePage 可能把透明区域拍成黑色
    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const cv = document.getElementById('cv');
        const ctx = cv.getContext('2d');
        const img = new Image();
        const svg = ${JSON.stringify(svg)};
        img.onload = () => { ctx.clearRect(0,0,256,256); ctx.drawImage(img, 0, 0, 256, 256); resolve(cv.toDataURL('image/png')); };
        img.onerror = () => reject(new Error('svg load failed'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      })
    `);

    const b64 = String(dataUrl).split(',')[1];
    fs.writeFileSync(path.join(ROOT, 'icon-src.png'), Buffer.from(b64, 'base64'));

    // 32×32 版给界面里的 <img> 和部分系统位置用
    const small = await win.webContents.executeJavaScript(`
      (function(){
        const cv = document.getElementById('cv');
        const c2 = document.createElement('canvas');
        c2.width = 32; c2.height = 32;
        const g = c2.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.clearRect(0,0,32,32);
        g.drawImage(cv, 0, 0, 32, 32);
        return c2.toDataURL('image/png');
      })()
    `);
    fs.writeFileSync(path.join(ROOT, 'icon-src32.png'), Buffer.from(String(small).split(',')[1], 'base64'));

    console.log('OK icon-src.png / icon-src32.png');
  } catch (err) {
    console.error('FAIL', err && err.message);
    process.exitCode = 1;
  }
  app.quit();
});
