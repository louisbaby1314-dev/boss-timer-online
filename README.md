# Boss 计时器在线共享版（Cloudflare Pages + JSONBin）

本项目包含：

- `public/index.html`：管理员的原版风格计时器（微信文字解析、Boss/地区管理、倒计时）。
- `public/viewer.html`：好友只读页面，每 30 秒重新读取云端记录。
- `functions/api/boss.js`：Cloudflare Pages Functions 后端，把 JSONBin API Key 留在服务端。`GET` 允许只读，`PUT` 需要管理员密码。

## 首次部署（不需要新建 JSONBin 数据库）

1. 将**整个文件夹**上传至一个 GitHub **Private Repository**（包含 `functions/` 目录）；不要只上传 HTML。
2. 在 Cloudflare Dashboard -> **Workers & Pages** -> **Create** -> **Pages** -> **Connect to Git**，绑定这个仓库。
3. 构建设置：**Framework preset: None**；**Build command 留空**；**Build output directory: `public`**。`functions/` 留在仓库根目录。
4. Pages 项目 -> Settings -> Variables and Secrets，添加下面四个**生产环境**变量（建议 Secret；**不要提交至 GitHub**）：
   - `JSONBIN_MASTER_KEY`：你新 JSONBin 账号的 Master Key。
   - `JSONBIN_NEW_BIN_ID`：迁移后的新区 Bin ID。
   - `JSONBIN_OLD_BIN_ID`：迁移后的老区 Bin ID。
   - `ADMIN_PASSWORD`：新设置的、足够长的管理员密码（与 JSONBin 账号密码**不是同一个概念**）。
5. 保存变量后重新部署，使 Pages Functions 能读取变量。
6. 先打开 `https://你的项目.pages.dev/viewer.html`，确认新区/老区可读；再打开 `/`，进入「更多 -> 管理员授权」输入 `ADMIN_PASSWORD`。管理员先「从云端下载」核对，再开启上传模式。
7. 将 **`/viewer.html`** 的网址发给朋友。管理员网址不是保密机制：知道管理员页面地址也不能写入，写入仍需密码。

## 后续更新

- 修改 Boss 时间：管理员点击云端同步；朋友网页最多约 30 秒自动刷新（网络/浏览器后台限制可能导致更晚）。
- 修改 Boss/地区配置：在管理员网页中调整，再分别同步新区、老区，确保两边都更新同一套 `_catalog`。配置修改会先保存在管理员当前浏览器本地。
- 修改网页代码：向 GitHub 提交并推送，Cloudflare Pages 自动部署新版本。朋友下次刷新网页获得新 UI 和功能；若使用浏览器缓存，可能需强制刷新。

## 安全与局限

- 朋友无需填写任何 API Key，也不需要 JSONBin 账户。任何能访问 `/viewer.html` 或 `/api/boss` 的人都能**读取**数据，因此此版本适合仅包含非敏感游戏信息的共享；若需要仅指定好友可读，下一步应添加 Cloudflare Access 或其他身份验证。
- `ADMIN_PASSWORD` 在 HTTPS 请求里发给服务端做校验，本页只保存在本次打开的页面内存中，不写入 HTML，也不写入 localStorage。请不要给朋友管理员密码。
- 旧 HTML 中曾包含 JSONBin Master Key；建议在 JSONBin 里轮换旧 Key。
- 管理员的本地配置和云端配置不是双向实时合并：需要点击云端同步才发布；不同设备同时修改可能互相覆盖。保留 JSONBin 历史版本或先备份很重要。
- Cloudflare / JSONBin 的服务限制、计费规则、部署 UI 可能变化，实际以官网界面为准。本包尚未在你的 Cloudflare 和 JSONBin 账号上端到端验证。
