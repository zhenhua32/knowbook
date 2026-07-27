# KnowBook

KnowBook 是一款本地优先的知识管理桌面应用，使用 Electron、React、TypeScript 和 SQLite 构建。当前核心形态包括文档树、块编辑器、双向链接、结构化 Database、AI 辅助、Markdown 备份恢复、网页剪藏和本地插件。

## 当前能力

- 文档树：创建、重命名、移动、删除、收藏、全局搜索。
- 块编辑器：标题、段落、待办、引用、列表、代码、公式、分割线，以及嵌套、拖拽、多块操作、撤销和重做。
- 文档关系：`[[文档名]]`、`[[路径]]`、块引用、出链和反向链接。
- 文档目录：自定义字段、Table 和 Board 视图。
- 独立 Database：字段、实体、Cards / Table、过滤、排序、保存视图和批量编辑。
- AI：OpenAI-compatible Chat Completions、文档问答、选区改写、自动摘要和本地关键词相关笔记检索。
- 备份恢复：SQLite 为主存储，Markdown 快照用于备份、审阅和恢复。
- 网页剪藏：应用内 URL 剪藏，以及通过本机桥接接收浏览器扩展内容。
- 插件：本地 JavaScript 插件、工作区事件、Dashboard 卡片、文档操作和持久化设置。
- 发布：electron-builder 跨平台打包、GitHub Releases 和应用内更新检查。

> “相关笔记”当前使用本地关键词匹配，不包含 Embedding、向量数据库或后台向量回填。

## 快速开始

要求 Node.js 22，以及能够编译或安装 `better-sqlite3` 的本机环境。

```bash
npm install
npm run dev
```

常用验证命令：

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

`npm run test:e2e` 会先构建应用，再运行 Electron Playwright 用例。

本地打包与发布预检：

```bash
npm run dist
npm run release:preflight
npm run release:verify-local
```

## 架构

```text
src/
  main/       Electron 主进程、SQLite、备份、插件、剪藏、更新与 IPC
  preload/    受限的 window.knowbook API
  renderer/   React 界面与领域状态
  shared/     跨进程类型、契约和纯函数
```

主要入口：

- `src/main/index.ts`：主进程启动、服务编排和 IPC。
- `src/main/database/store.ts`：SQLite 数据访问和领域操作。
- `src/shared/contracts.ts`：Renderer、Preload、Main 共用的 API 契约。
- `src/preload/index.ts`：向 Renderer 暴露最小 IPC API。
- `src/renderer/src/App.tsx`：Renderer 组合入口。

SQLite 是唯一事实源。默认数据库位于 Electron `app.getPath('userData')/storage/knowbook.db`；Markdown 快照位于同一 userData 目录下的 `backups/markdown`。应用内“总览”会显示实际路径。

## 数据与恢复

Markdown 备份是完整快照，不是增量同步。恢复会在识别出的恢复范围内创建、更新和删除内容；恢复独立 Database 时，带 manifest 的快照也会删除快照中不存在的独立 Database。

恢复前应：

1. 退出正在写入同一数据目录的其他 KnowBook 实例。
2. 复制 `knowbook.db`、`knowbook.db-wal` 和 `knowbook.db-shm`（若存在）。
3. 确认选择的是 KnowBook 生成的完整 Markdown 备份目录。
4. 不要把任意 Markdown 文件夹当作“导入”目录；当前恢复动作按快照语义处理。

详细操作见 [使用文档.md](使用文档.md)。

## 插件边界

插件来自工作区 `plugins/` 或 Electron userData 下的 `plugins/`。当前插件宿主适合可信的本地扩展；插件市场、远程安装和独立发布的 TypeScript SDK 尚未提供。

仓库内的 `plugins/activity-pulse/` 是最小示例。插件开发说明见 [使用文档.md](使用文档.md#插件开发)。

## 网页剪藏

应用内剪藏会主动抓取网页并阻止本地/私有网络目标；浏览器扩展则把当前页面内容提交给仅监听 `127.0.0.1` 的本机桥接服务。扩展安装与配置见 [web-clip-extension/README.md](web-clip-extension/README.md)。

## 发布

- 通用发版步骤：[发版流程.md](发版流程.md)
- 证书和 GitHub Secrets：[发布与签名说明.md](发布与签名说明.md)

正式 tag 必须使用 `v<package.json version>` 格式。发布前至少运行类型检查、测试和发布预检；涉及 Electron 壳、IPC、Renderer 主流程、插件、更新或打包配置时，还应运行 E2E。

## 当前已知边界

- 相关笔记检索为关键词匹配，不是向量检索。
- 独立 Database 暂无专属 Board 视图。
- 插件仅支持本地安装，尚无远程市场。
- 自动化目前主要覆盖文档摘要。
- Markdown 恢复采用快照语义，选择目录前必须先做数据库级备份。

