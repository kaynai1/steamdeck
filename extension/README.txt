SteamDesk 浏览器扩展（可选）

作用：在 Steam 社区市场的物品页右下角加一个「记到 SteamDesk」按钮，
把当前价格记到本机 SteamDesk 的物品详情里，方便和 Steam / BUFF 对照。

安装（Chrome / Edge）：
1. 打开 SteamDesk → 设置 → 浏览器扩展，打开「允许网页采集」并复制令牌。
2. 浏览器地址栏输入 chrome://extensions（Edge 为 edge://extensions），
   打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择 SteamDesk 安装目录下的 extension 文件夹。
4. 点扩展图标，把令牌粘贴进去并保存。
5. 打开任意 Steam 市场物品页，右下角会出现「记到 SteamDesk」按钮。

安全边界：
- 只连接 127.0.0.1:37421，不向公网开放；
- 写入需要令牌，令牌只保存在本机；
- 只发送物品名、appId 和价格，不读取 Cookie、不代替你登录。
