/* 在 Steam 市场物品页注入「记到 SteamDesk」按钮。
   只发送物品名、appId、价格和令牌，目标固定为本机 127.0.0.1。 */
(function () {
  if (window.__sdInjected) return;
  window.__sdInjected = true;

  const m = location.pathname.match(/\/market\/listings\/(\d+)\/([^/?#]+)/);
  if (!m) return;
  const appId = Number(m[1]) || 753;
  let hashName = m[2];
  try {
    hashName = decodeURIComponent(hashName);
  } catch (e) {
    /* 保留原样 */
  }

  const btn = document.createElement('button');
  btn.textContent = '记到 SteamDesk';
  btn.title = '把当前价格记到本机 SteamDesk';
  btn.style.cssText =
    'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 14px;' +
    'border:0;border-radius:8px;background:#2f81f7;color:#fff;font-size:13px;' +
    'font-weight:600;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)';

  function detectPrice() {
    const sels = ['.market_listing_lowest_price', '#market_median_price', '.market_listing_price'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const mm = String(el.textContent || '').match(/(\d[\d,]*\.\d{2})/);
      if (mm) return Number(mm[1].replace(/,/g, ''));
    }
    return 0;
  }

  btn.onclick = async () => {
    const guess = detectPrice();
    const input = window.prompt('确认要记录的价格（元）', guess ? guess.toFixed(2) : '');
    if (input == null) return;
    const price = Number(String(input).replace(/[^\d.]/g, ''));
    if (!(price > 0)) {
      window.alert('价格不正确');
      return;
    }
    let token = '';
    try {
      token = (await chrome.storage.local.get('token')).token || '';
    } catch (e) {
      /* ignore */
    }
    if (!token) {
      window.alert('先在扩展弹窗里填入 SteamDesk 设置中的令牌');
      return;
    }
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const res = await fetch('http://127.0.0.1:37421/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, appId, marketHashName: hashName, price, source: 'steam' }),
      });
      const json = await res.json().catch(() => ({}));
      btn.textContent = json && json.ok ? `已记录 ¥${price.toFixed(2)}` : `失败：${(json && json.error) || res.status}`;
    } catch (e) {
      btn.textContent = '连接失败，SteamDesk 是否在运行？';
    }
    setTimeout(() => {
      btn.textContent = '记到 SteamDesk';
      btn.disabled = false;
    }, 2600);
  };

  document.body.appendChild(btn);
})();
