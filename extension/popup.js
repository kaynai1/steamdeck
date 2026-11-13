const input = document.getElementById('token');
const msg = document.getElementById('msg');

chrome.storage.local.get('token').then((r) => {
  if (r && r.token) input.value = r.token;
});

document.getElementById('save').onclick = async () => {
  const token = String(input.value || '').trim();
  if (!token) {
    msg.className = 'err';
    msg.textContent = '令牌不能为空';
    return;
  }
  await chrome.storage.local.set({ token });
  msg.className = 'ok';
  msg.textContent = '已保存。打开 Steam 市场物品页就能看到按钮。';
};
