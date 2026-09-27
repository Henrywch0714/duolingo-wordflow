# 词间 · 多邻国核心词单词卡

一个面向 iPhone 的背词网页。词库含 3590 个英文单词及中文释义，按易/中/难和正向/负面/中性分类。

词库整理自[新东方在线多邻国高频核心词](https://liuxue.koolearn.com/duolingo/word/list-1-0/)；难度与情感倾向是个人学习用途的整理结果，不代表网站官方分类。

## 功能

- “认识 / 不认识”判断后显示中文释义
- 每词累计不认识次数，自动汇入错题本
- 新词随机排列并固定顺序；每 10 词为 1 list，每 10 list 为 1 unit
- 全部词表可按 unit/list 浏览或搜索，展示每词学习次数
- 每日目标以 list 为单位设置，最少 1 list；逾期复习优先，其次当天到期复习，再安排新词
- 答对后按 1、2、4、7、15、30 天间隔复习；答错后从短间隔重新开始
- IndexedDB 本地保存，支持导出与导入 JSON 备份
- 可选 MongoDB Atlas 云同步：Vercel Function 保存进度，使用独立同步口令；冲突时明确选择本机或云端
- PWA 支持添加到 iPhone 主屏幕，资源缓存后可离线使用

## 本地运行

使用任意静态文件服务器在本目录启动，不能直接双击 `index.html`，因为词库通过 `fetch` 加载。

例如：`node serve.mjs`

浏览器打开 `http://127.0.0.1:4173`。

## GitHub Pages

将本目录文件上传到公开仓库，在仓库的 Settings → Pages 中选择 **Deploy from a branch**，来源为 `main` 分支的 `/(root)`。网页将位于 `https://用户名.github.io/仓库名/`。

用户进度不会上传到 GitHub。未连接云端时，进度只保存在浏览器中。

## 云同步部署

将同一个仓库导入 Vercel，启用 Node.js Function `api/sync.js`。在项目的 Environment Variables 设置：

- `MONGODB_URI`：Atlas 数据库连接串，使用仅授权 `wordflow.progress` 集合的数据库用户。
- `SYNC_KEY_SHA256`：独立同步口令的 SHA-256 十六进制摘要。口令本身只在客户端输入，不写入仓库。

Atlas 需要允许 Vercel Function 的出站 IP 访问数据库。Vercel Hobby 的出站 IP 不固定；请评估 Atlas 网络访问规则后配置。GitHub Pages 网页使用同仓库对应的 Vercel API，进度经 HTTPS 同步。首次连接若两边都有进度，网页会要求选择保留哪一份。
