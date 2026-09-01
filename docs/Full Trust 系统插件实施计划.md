# KnowBook Full Trust 系统插件实施计划

> 文档状态：已批准，待实施
> 适用版本：KnowBook 0.2.x+
> 最后更新：2026-09-01
> 目标读者：产品、Main/Preload/Renderer 开发、插件作者、安全评审与测试

## 1. 执行摘要

KnowBook 将在现有 Plugin Platform v2 之外新增 **Full Trust / System Plugin v3** 通道。v3 面向用户明确选择并完全信任的本地插件，允许直接使用 Node.js、Electron、文件系统、环境变量、密钥、网络、npm、KnowBook Store、原始 SQLite、宿主 Renderer 和长期后台服务。

Full Trust 不是对 v2 capability 的简单扩容，也不使用沙箱或细粒度权限开关制造虚假的安全承诺。插件一旦在主进程或具有 Node 权限的上下文运行，就能够绕过宿主包装，因此 manifest 中的风险声明只承担告知、确认、审计和变更比较职责，不是可强制执行的权限边界。

现有插件分层保持不变：

- v2 用户/AI 动态插件继续运行在 QuickJS/WASM 无 Node 隔离环境中。
- Full Trust 插件进入独立的 System Plugin v3 安装、确认、运行和恢复通道。
- Legacy v1 继续作为兼容层，不自动升级为 Full Trust，也不获得 v3 安全或能力声明。
- AI 可以生成 Full Trust 插件工程或提出安装请求，但不能代替用户确认、安装、启用或授予系统访问。

长期架构约束由 [ADR-0007](adr/0007-full-trust-system-plugins.md) 固化。本文件定义可直接实施的产品行为、接口、数据流、阶段和验收标准。

## 2. 背景与当前状态

### 2.1 当前插件体系

当前仓库已经具备三类基础：

1. Plugin Platform v2：使用 QuickJS/WASM、不可变 revision、Grant Set、Capability Broker、声明式 ViewSpec 和 sandboxed iframe。
2. Legacy v1：使用现有 `PluginHost` 和 utility process，提供首页卡片、文档动作、设置、事件监听、文档读取和摘要更新等兼容能力。
3. System 插件请求：数据库和插件中心能够记录、展示、确认或取消系统插件请求，但确认后只进入 `confirmed-restart-required`，尚无 artifact 安装、运行时、生命周期或恢复逻辑。

v2 当前只适合受控的知识库自动化。它不会向插件暴露 Node、Store、SQLite、用户目录、API Key 或宿主 Renderer，这一边界是有意设计，不能为实现 Full Trust 而拆除。

### 2.2 本计划解决的问题

高级本地插件需要完成以下工作：

- 集成本机开发工具、CLI、原生模块和长期服务。
- 直接操作 KnowBook 数据、内部服务和 Electron 桌面能力。
- 使用任意 npm 生态、网络协议和模型供应商。
- 构建与宿主深度集成的 React/DOM 界面。
- 在用户完全知情的前提下读取密钥、用户文件或运行外部程序。

这些需求不能在“不可信代码仍受强隔离”的前提下同时满足。因此 v3 明确采用完全信任模型，并把风险控制重点放在来源、精确 artifact、显式确认、可恢复启动、备份、日志和卸载上。

## 3. 目标与非目标

### 3.1 目标

- 支持用户安装、启用、停用、升级、回滚和卸载 Full Trust 插件。
- 覆盖本文第 9 节列出的十二类系统能力。
- 为 Node 主进程、宿主 Renderer、特权窗口和后台服务提供明确入口。
- 支持插件自有 npm 依赖、生命周期脚本和 Electron 原生模块重建。
- 为 Full Trust 插件提供稳定 SDK，同时保留直接访问底层对象的能力。
- 防止错误插件造成永久启动循环，并为数据库变更提供恢复入口。
- 保持 v2 的隔离、权限、配额和 UI 安全测试全部有效。

### 3.2 非目标

- 不尝试在 Full Trust 运行时强制实现可靠的逐文件、逐域名或逐数据表权限。
- 不承诺阻止已确认插件窃取数据、破坏数据库、退出进程或绕过 SDK。
- 不让 AI 自动确认或静默启用 Full Trust 插件。
- 不把 Legacy v1 重新描述为 v3，也不在本项目中自动迁移第三方 v1 插件。
- 不保证插件直接依赖 KnowBook 私有 DOM、数据库 schema 或内部对象后仍能跨版本兼容；只有公开 SDK 属于稳定契约。

## 4. 信任模型与运行架构

### 4.1 分层模型

| 类型 | 代码来源 | 运行边界 | 权限语义 |
| --- | --- | --- | --- |
| 内置插件 | 随应用构建发布 | 应用内可信代码 | 由 KnowBook 发布流程建立信任 |
| 动态/市场 v2 | AI、用户或签名市场包 | QuickJS/WASM + Capability Broker | manifest 请求、Grant Set 强制授权 |
| Full Trust v3 | 用户选定的本地或签名系统包 | 主进程、Renderer、特权窗口、后台服务 | 一次完整信任确认，风险声明用于告知和审计 |
| Legacy v1 | 工作区或 userData 插件目录 | 兼容 utility process | 固定旧 API，无 v2/v3 安全声明 |

### 4.2 运行拓扑

```text
Full Trust plugin artifact
├─ main entry
│  └─ Electron main process
│     ├─ Node / Electron / process / require
│     ├─ KnowbookStore / raw SQLite / AI / event bus
│     └─ window / menu / tray / clipboard / shell
├─ renderer entry
│  └─ host renderer main world
│     ├─ React registry / DOM / CSS
│     └─ window.knowbook / host UI context
├─ privileged window entry
│  └─ dedicated BrowserWindow or WebContentsView
│     └─ optional nodeIntegration + plugin preload
└─ service entry
   ├─ app-lifetime managed child process
   └─ optional detached or OS-startup service
```

主窗口继续保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。Full Trust 插件需要 Node 和 DOM 位于同一执行环境时，使用专属特权窗口，而不是降低整个 KnowBook Renderer 的安全配置。

### 4.3 权限含义

v3 manifest 必须声明 `fullAccess: true` 和风险类别。安装界面展示这些类别并比较升级前后的变化，但运行时不会声称可以阻止插件使用未声明能力。原因包括：

- Node 代码可以直接导入 `fs`、`net`、`child_process` 和 `electron`。
- 插件获得 Store 或 SQLite 引用后可以绕过高层 API。
- 插件可以读取自身进程可见的环境变量和用户文件。
- Renderer 注入代码可以直接操作 DOM、CSS 和公开 preload API。

## 5. v3 包格式与 Manifest

### 5.1 目录结构

```text
plugin.json
package.json                 # 可选；需要 npm 安装时提供
package-lock.json            # 推荐；也允许 pnpm-lock.yaml / yarn.lock
dist/
  main.cjs                   # 可选
  renderer.iife.js           # 可选
  service.cjs                # 可选
assets/                      # 可选
README.md                    # 推荐
```

插件至少声明一个 `main`、`renderer` 或 `service` entry。最终运行的 entry 必须位于 artifact 根目录内，不能通过相对路径逃逸；这是安装完整性规则，不是运行时文件访问限制。

### 5.2 Manifest 示例

```json
{
  "schemaVersion": 3,
  "trust": "full",
  "id": "example.system-plugin",
  "name": "Example System Plugin",
  "version": "1.0.0",
  "description": "Full Trust integration example",
  "publisher": "Example Publisher",
  "engines": {
    "knowbook": ">=0.2.0"
  },
  "entries": {
    "main": "dist/main.cjs",
    "renderer": "dist/renderer.iife.js",
    "service": "dist/service.cjs"
  },
  "fullAccess": true,
  "riskDeclarations": [
    "filesystem",
    "user-data",
    "environment",
    "secrets",
    "node",
    "electron",
    "shell",
    "subprocess",
    "network",
    "npm",
    "ai",
    "documents",
    "database",
    "raw-sqlite",
    "settings",
    "renderer",
    "unsandboxed-frame",
    "background-service",
    "os-persistence"
  ],
  "dependencies": {
    "packageManager": "npm",
    "install": "ci",
    "allowScripts": true,
    "buildCommand": ["npm", "run", "build"],
    "rebuildNativeModules": true
  },
  "background": {
    "mode": "app-lifetime",
    "autoStart": true
  }
}
```

### 5.3 校验规则

- `schemaVersion` 必须为 `3`，`trust` 必须为 `full`，`fullAccess` 必须显式为 `true`。
- `id`、语义化版本和 `engines.knowbook` 沿用现有插件命名与兼容性规则。
- entry 路径必须为 artifact 内的普通文件，拒绝路径逃逸和符号链接替换。
- `riskDeclarations` 只接受版本化目录中的已知值，未知值导致安装失败，避免风险信息被旧客户端忽略。
- 包必须包含锁文件，或在确认页明确标记为“非锁定依赖安装”。
- 安装器记录源 artifact SHA-256、manifest 快照、文件清单和最终运行时指纹。
- 更新后的 hash、entry、依赖计划或风险声明发生变化时，必须重新确认。

## 6. 安装、升级与恢复流程

### 6.1 安装流程

1. 用户从插件中心选择目录或压缩包；Renderer 不直接提交任意路径，由主进程文件选择器返回目标。
2. 主进程将 artifact 复制到 `userData/system-plugins/staging/<requestId>`，不执行其中任何代码。
3. 安装器校验 manifest、路径、文件类型和体积，计算 SHA-256 与文件清单。
4. 插件中心展示插件 ID、版本、发布者、精确 hash、entry、依赖命令、安装脚本、风险类别和是否包含 native module。
5. 用户勾选完整系统访问确认，并确认精确插件 ID；只有用户发起的 IPC 可以完成确认。
6. 确认后在 staging 目录运行依赖安装、生命周期脚本、构建和 native rebuild，并保存完整输出。
7. 成功后将 artifact 原子移动到 `userData/system-plugins/artifacts/<pluginId>/<contentHash>`。
8. installation 指向 pending revision，状态变为 `confirmed-restart-required`。
9. 重启后启动协调器激活 pending revision；健康检查通过后提交为 current revision。
10. 激活失败时恢复上一个已知可用 revision，并在插件中心显示错误。

依赖安装开始后，插件脚本已经拥有与 Full Trust 代码相同的系统风险，因此确认必须发生在任何 `preinstall`、`install`、`postinstall` 或 build 命令之前。

### 6.2 AI 请求规则

- AI 可以生成插件工程、manifest、风险说明和待安装请求。
- AI 创建的请求必须停在 `awaiting-confirmation`。
- AI 工具不得调用确认、启用、重启安装或 OS persistence 接口。
- 助手当前对 v2 使用的自动 `allowed-once` 路径不得复用于 v3。
- 用户拒绝或请求过期后，staging artifact 可以安全删除，且不得执行其中代码。

### 6.3 升级、回滚和卸载

- 每次升级创建新的不可变 artifact revision，至少保留前一个成功 revision。
- 升级需要重新展示 hash、依赖计划和风险差异；确认后在重启时切换。
- 回滚只恢复代码和由宿主托管的插件状态快照，不承诺撤销 raw SQLite、文件系统或外部服务副作用。
- 停用首先调用插件生命周期清理并移除已登记 UI；涉及 native module、preload 或特权窗口配置时要求重启。
- 卸载先停止已登记进程、窗口和 OS 启动项，再移除 installation；artifact 与插件数据分别提供“保留数据”和“同时删除”选择。

### 6.4 启动保护

- 激活前写入 crash marker，记录 pluginId、revision、启动阶段和时间。
- `activate` 与首次 `healthCheck` 成功后将运行标记为 ready。
- 应用异常退出且存在未 ready marker 时，下次启动自动跳过该 revision，并恢复上一个已知可用版本或停用插件。
- 提供全局安全模式：本次启动不加载任何 Full Trust 插件。
- 用户解除安全停用前，失败 revision 不得自动重试。

## 7. Full Trust SDK 与生命周期

### 7.1 主进程 Context

```ts
export interface FullTrustPluginContext {
  plugin: {
    id: string
    version: string
    root: string
    dataRoot: string
    revisionHash: string
  }
  paths: {
    userData: string
    appData: string
    documents: string
    downloads: string
    temp: string
  }
  store: KnowbookStore
  sqlite: import('better-sqlite3').Database
  ai: FullTrustAiApi
  events: WorkspaceEventBus
  settings: FullTrustSettingsApi
  renderer: FullTrustRendererController
  electron: typeof import('electron')
  mainWindow: Electron.BrowserWindow | null
  require: NodeRequire
  process: NodeJS.Process
  notifyWorkspaceMutation(): void
  registerDisposable(disposable: () => void | Promise<void>): void
}
```

`store`、`sqlite`、`electron`、`require` 和 `process` 是明确标记为 Full Trust 的直接引用。插件也可以绕过 Context 自行导入 Node/Electron 模块。

### 7.2 生命周期导出

```ts
export async function activate(context: FullTrustPluginContext): Promise<void> {}
export async function deactivate(): Promise<void> {}
export async function migrate(context: FullTrustPluginContext, fromVersion: string): Promise<void> {}
export async function healthCheck(): Promise<{ ok: boolean; message?: string }> {}
export async function beforeQuit(): Promise<void> {}
```

- `activate` 每次应用进程只调用一次，成功后才加载 Renderer entry 和自动启动 service。
- `registerDisposable` 采用后进先出顺序清理宿主管理的监听器、命令、窗口、菜单、托盘和子进程。
- `deactivate`、`beforeQuit` 和清理函数使用有界等待；超时后宿主继续退出，但记录未完成清理。
- 插件绕过 SDK 创建的全局副作用由插件自行负责，宿主只做尽力清理。

### 7.3 稳定 API 与不稳定对象

文档、数据库、AI、设置、事件、Renderer contribution 和生命周期 helper 属于版本化 SDK。`store`、raw SQLite、Electron 实例、DOM 和 React 内部结构属于 unsafe escape hatch，不保证跨 KnowBook 版本稳定。

## 8. 运行时设计

### 8.1 Main entry

- `SystemPluginHost` 在 Electron 主进程中加载 CJS 或 ESM entry。
- CJS 使用以插件 entry 为根的 `createRequire`，ESM 使用本地文件 URL dynamic import。
- 插件自己的 `node_modules` 参与正常 Node 模块解析。
- 主进程向 Context 注入 Store、原始 SQLite、AI、event bus、当前窗口和 mutation notifier。
- 同步异常和 rejected promise 写入运行记录；原生崩溃、死循环、`process.exit()` 和全局 monkey patch 无法隔离。

### 8.2 Renderer entry

- Renderer 启动时建立 `FullTrustPluginRegistry`，提供 React、slot registry、路由、命令、页面上下文和 CSS 管理。
- 主进程在 Renderer ready handshake 后执行已确认 revision 的 IIFE bundle。
- 插件可以注册宿主 React 组件、创建独立 React root/portal、访问 `window.knowbook`、操作 DOM、注册全局事件和注入 CSS。
- 禁用或切换 revision 时调用 renderer cleanup，并移除通过 Registry 登记的组件、节点和样式。
- 直接依赖宿主私有 DOM/CSS class 的插件可能随版本失效，不纳入兼容承诺。

### 8.3 特权窗口

需要 Node 与页面脚本处于同一上下文的插件通过 Context 创建专属 `BrowserWindow` 或 `WebContentsView`。每个窗口可按插件声明启用：

- `sandbox: false`
- `nodeIntegration: true`
- 自定义 preload
- `contextIsolation` 开关
- 导航、下载、权限请求和 popup policy

这些设置只作用于插件专属 WebContents，不改变 KnowBook 主窗口和 v2 iframe。

### 8.4 Service entry

- `app-lifetime` 服务随 KnowBook 启停，由宿主跟踪 PID、退出码、日志和重启次数。
- service 默认使用 Node 子进程，继承 Full Trust 所需环境，并获得插件数据目录和主进程 RPC 地址。
- service 不能直接持有 Main 内存中的 Store 对象；可通过 Full Trust RPC 调用稳定 API，或自行使用数据库路径和 `better-sqlite3`。
- detached/OS-startup 服务使用单独的持久化安装步骤，见第 13 节。

## 9. 十二类能力映射与验收

| 编号 | 能力 | 实现入口 | 最终验收 |
| --- | --- | --- | --- |
| 1 | 直接访问文件系统、SQLite、Store 和用户目录 | Main Context 暴露 `paths`、`store`、`sqlite`；插件可直接导入 `fs`、`os`、`better-sqlite3` | 验收插件读写临时目录和用户选择目录，读取 Store 文档并在事务中执行 raw SQL |
| 2 | Node.js、Electron、`process`、`require`、shell 和子进程 | Main entry 原生 Node CJS/ESM；Context 暴露 Electron、require、process；允许 `child_process` | 验收插件读取 Node/Electron 版本、执行测试子进程并创建 Electron 窗口 |
| 3 | HTTP、WebSocket 和任意外部网络 | Node `fetch/http/https`、`undici`、第三方包；Full Trust frame 可登记远程 origin | 本地测试服务器验证 HTTP、WebSocket、取消、TLS/错误处理和远程 frame |
| 4 | 任意安装或导入 npm 包 | staging 中运行 npm/pnpm/yarn、生命周期脚本和 build；按 Electron ABI rebuild native module | 安装纯 JS 包和一个测试 native module，在打包应用中成功 require/import |
| 5 | 任意大模型提示词 | `ai.complete`、`ai.stream`、`ai.rawRequest`；允许读取 AI 配置和 API Key 后自行请求 | mock OpenAI-compatible 服务验证任意 messages、流式输出、取消和原始响应 |
| 6 | 删除或移动文档 | 稳定 Documents API 包装 Store 的 create/read/update/delete/move，并发送 workspace event | 创建文档树后移动和递归删除，验证路径、链接、事件和 Renderer 刷新 |
| 7 | 操作数据库记录 | 稳定 Databases API 覆盖数据库、字段、视图、实体和值 CRUD；另暴露 raw SQLite | 创建数据库、字段、视图和记录，批量更新/删除并验证 raw SQL 与 UI 一致 |
| 8 | 剪贴板、外部程序、窗口、菜单和托盘 | 直接 Electron API；SDK helper 登记 clipboard、shell、BrowserWindow、Menu、Tray | 验收插件复制文本、打开受控测试 URL、创建窗口/菜单/托盘并在停用时清理 |
| 9 | 修改主题以外的应用设置 | Settings API 提供 get/set/delete/list；直接 Store 可访问全部设置和 AI 配置 | 修改普通设置、主题和测试 AI 配置，重启后恢复并触发 UI 更新 |
| 10 | 注入 React、读取 preload、操作 DOM 和全局 CSS | Renderer IIFE + FullTrustPluginRegistry；直接访问 `window.knowbook`、DOM 和 style | 在稳定 slot 注入 React 组件，调用 preload API，修改 DOM/CSS，停用后清理 |
| 11 | iframe 弹窗、联网和逃离 v2 sandbox | Full Trust frame registry 放行无 sandbox frame、origin、导航和 popup；可使用特权窗口 | 远程 frame 成功联网和打开登记 popup，同时证明 v2 iframe 仍被拦截 |
| 12 | 无限期后台守护进程 | app-lifetime service、detached service 和可选 OS 登录启动项 | 长时运行、应用重启恢复、异常重启限制、显式停止和卸载清理均通过 |

## 10. 稳定宿主 API

### 10.1 文档 API

稳定接口覆盖目录查询、详情读取、创建、更新、摘要更新、块标签/高亮、移动和删除。写操作必须复用 Store 领域逻辑，并统一执行：

1. Store mutation。
2. workspace event，携带 `originPluginId`、correlation/causation 信息。
3. plugin/AI 自动化需要的事件通知。
4. Renderer mutation notification。

### 10.2 数据库 API

稳定接口覆盖：

- 数据库创建、读取、元数据更新和删除。
- 字段创建、改名、重排、选项更新和值写入。
- 保存视图创建、更新、重排和删除。
- 实体/记录创建、更新、批量更新、删除、批量删除和查询。
- 受宿主事务管理的批量操作。

raw SQLite handle 是 escape hatch，不自动补发事件或修复领域不变量。

### 10.3 AI 与 Secrets API

- `ai.complete`：接受任意 system/user/assistant/tool messages、model、temperature、tools 和 abort signal。
- `ai.stream`：返回异步增量流并支持取消。
- `ai.rawRequest`：使用当前 Base URL 和认证执行任意 OpenAI-compatible 路径请求。
- `secrets.getAiApiKey` 与 `settings.getAiConfig({ includeSecret: true })` 明确返回敏感信息。
- 插件也可读取环境变量或自行管理其他供应商密钥。

宿主日志对常见 token 形态做尽力脱敏，但不能阻止 Full Trust 插件自行保存或发送密钥。

### 10.4 Desktop 与设置 API

SDK helper 为常用 Electron 资源返回 disposable，以便停用时清理；直接 Electron 模块始终可用。Settings API 支持任意 key 的 get/set/delete/list，并在已知设置改变时触发相应宿主刷新。

## 11. npm、构建与原生模块

### 11.1 包管理器

- 支持 npm、pnpm 和 yarn；默认按锁文件选择，并允许 manifest 显式指定。
- `install: ci` 要求锁文件，`install: install` 允许更新依赖解析结果并在确认页突出显示。
- 命令使用参数数组执行；只有 manifest 明确要求时才使用 shell。
- 包管理器不可用、网络失败或脚本失败时保留安装日志，artifact 不进入 active 目录。

### 11.2 生命周期与构建

允许依赖和插件自身的 `preinstall`、`install`、`postinstall`、prepare 和 build 脚本。安装确认必须展示实际命令与 `allowScripts` 状态。构建产物在 staging 中重新校验 entry 存在性后才能发布。

### 11.3 Native module

- 根据当前 Electron version、ABI、平台和架构执行 rebuild。
- 保存锁文件 hash、平台、架构、Electron ABI 和 rebuild 结果作为运行时指纹。
- 平台或 Electron ABI 改变后，在插件激活前重新 rebuild；失败则停用该 revision。
- native module 无法热卸载，相关升级、回滚和删除统一在重启后完成。

## 12. Renderer、iframe 与窗口策略

### 12.1 React Registry

Registry 至少支持：

- 现有 11 个公开 UI slot。
- 完整页面和路由。
- 命令、快捷键和上下文动作。
- 独立 root/portal。
- 全局样式和主题监听。
- 页面上下文与 workspace mutation 订阅。

React 及 ReactDOM 由宿主提供，插件 renderer bundle 将其视为 external，避免重复 React 导致 hooks 失效。插件可选择自行挂载独立 React root，但此时自己负责版本和清理。

### 12.2 Full Trust frame registry

Full Trust iframe 必须登记 pluginId、frameId、目标 URL或 origin、是否允许 popup/导航/下载以及可选权限。主进程只对当前启用且 revision 匹配的登记放行。插件停用或 revision 切换时立即撤销登记。

主窗口 CSP 可加入 Full Trust frame 所需协议或受控网络 scheme，但 v2 继续只使用 `knowbook-plugin-ui:` 和严格 sandbox。现有 v2 frame 导航与 popup 安全测试不得放宽预期。

## 13. 后台与系统持久化

### 13.1 App-lifetime

- 随应用启动并在 workspace 服务就绪后激活。
- 支持永久定时器、文件 watcher、WebSocket、队列消费者和托管子进程。
- 宿主记录 PID、启动时间、心跳、退出码、重启次数和日志路径。
- 意外退出采用有界指数退避；达到阈值后停用并要求用户恢复。

### 13.2 Detached 与 OS-startup

- `background.mode: detached` 允许 KnowBook 退出后继续运行。
- `os-persistence` 允许安装登录启动项或系统服务，必须在安装确认中单独突出显示。
- 宿主记录安装方法、命令、PID/service id 和卸载步骤。
- 插件中心必须提供停止与移除入口；应用卸载流程对已登记服务做尽力清理。
- 插件绕过 SDK 创建的计划任务、服务或启动项无法保证自动发现和清理。

## 14. 持久化模型

v3 不复用 v2 Grant Set 作为权限依据。新增独立记录：

| 表 | 用途 |
| --- | --- |
| `system_plugin_packages` | artifact、manifest、content hash、文件清单、运行时指纹和安装结果 |
| `system_plugin_installations` | current/pending revision、启停、安全模式、自动启动和最近错误 |
| `system_plugin_runs` | main/renderer/service 生命周期、ready 状态、PID、退出和健康信息 |
| `system_plugin_audit` | 安装、确认、升级、回滚、启停、外部命令和恢复操作 |
| `system_plugin_dependency_jobs` | 包管理器、build、native rebuild 命令与日志 |
| `system_plugin_crash_markers` | 启动阶段、失败 revision 和自动恢复依据 |

现有 `system_plugin_install_requests` 增加 staged artifact、真实 hash、manifest snapshot、依赖计划、确认版本、最终 installation 和错误信息。请求中的 hash 必须由主进程对本地 artifact 计算，不能信任 Renderer 或 AI 传入的声明值。

## 15. 数据一致性与备份

- 推荐 SDK 写操作复用 Store，确保路径、链接、字段约束、FTS、事件和 UI 刷新一致。
- raw SQLite 写入不保证领域不变量。执行后插件必须主动调用 `notifyWorkspaceMutation`，必要时补发事件。
- Full Trust 插件首次启用和升级前自动创建数据库安全备份，并在 installation 中记录备份路径。
- raw SQL 破坏 schema、外键、FTS 或应用设置时，恢复方案是停用插件并还原备份；权限系统不能阻止此类破坏。
- 插件状态保存在独立 `data/<pluginId>` 目录；代码 revision 回滚默认不删除数据。

## 16. 插件中心

新增独立的 **Full Trust / 系统插件** 区域，不能与 v2 权限卡片混用。界面提供：

- artifact 选择、风险确认、依赖/build 日志和重启提示。
- 当前/待激活 revision、版本、hash、发布者和风险声明。
- main、renderer、service、detached service 的实时状态。
- 安装、升级、回滚、启用、停用、卸载和打开数据/日志目录。
- crash guard、安全停用和“安全模式重启”。
- 后台 PID、心跳、最近退出、重启次数和强制停止。
- 已登记窗口、菜单、托盘、frame 和 OS persistence 摘要。

风险确认文案必须明确说明：插件可以读取和修改全部本地文件、KnowBook 数据库与密钥，可以联网、运行任意程序、改变界面并使应用崩溃。

## 17. 日志、审计与故障处理

- 宿主记录安装、确认、依赖命令、激活、停用、升级、回滚、崩溃恢复和 OS persistence 操作。
- 插件 stdout/stderr 写入按插件和 revision 分隔的滚动日志。
- 日志和错误详情限制单条大小并做常见密钥形态的尽力脱敏。
- Full Trust 运行时不使用 v2 的 capability 违规和三次 quarantine 语义。
- 普通异常进入 failed 状态；主进程崩溃依赖 crash marker；后台进程崩溃依赖 restart policy。
- 插件中心展示最后错误、失败阶段、日志路径和可执行恢复动作。

## 18. 实施阶段

### 阶段 0：ADR、契约与防回归基线

目标：先固定 Full Trust 的信任含义和 v2 不回退要求。

工作项：

- 接受 ADR-0007，定义 v3 manifest、风险目录、共享类型、生命周期和目录布局。
- 为现有 v2 QuickJS、Capability Broker 和 iframe 安全行为建立防回归测试清单。
- 定义一个只使用临时目录和 mock 服务的 Full Trust 验收插件工程。
- 确定 Windows、macOS、Linux 的安装、native rebuild 和安全模式验证矩阵。

依赖：无。

完成标准：公共契约和安全边界均有类型或测试说明，实施者不需要再决定 v2 是否放宽。

### 阶段 1：安装、持久化与插件中心骨架

目标：让 System 请求从“确认记录”演进为真实、可恢复的 artifact 安装流程。

工作项：

- 实现 staging、manifest 校验、hash、文件清单、不可变 artifact 发布和数据库记录。
- 实现用户文件选择、风险确认、pending restart、启停、卸载和安装日志 UI。
- 增加 current/pending revision、dependency job、audit 和 crash marker 持久化。
- 确保 AI 请求只能到达 awaiting-confirmation。

依赖：阶段 0。

完成标准：不执行插件代码也能完成请求、确认、artifact 发布、取消和重启待处理的完整状态机。

### 阶段 2：Main Runtime 与基础系统能力

目标：建立真正可运行的 Full Trust 主进程通道。

工作项：

- 实现 `SystemPluginHost`、CJS/ESM 加载、Context、生命周期和 disposable 管理。
- 开放 Node、Electron、process、require、文件、环境变量、网络、shell 和子进程。
- 注入 Store、raw SQLite、路径、事件与 mutation notifier。
- 实现启动 marker、ready health check、失败回滚和安全模式。

依赖：阶段 1。

完成标准：验收插件完成能力 1–3，并且错误 revision 不会造成永久启动循环。

### 阶段 3：稳定数据、AI 与桌面 API

目标：在 raw escape hatch 之外提供可维护的宿主集成。

工作项：

- 实现完整 Documents 和 Databases API，统一事件与 Renderer 刷新。
- 实现任意 AI complete、stream、raw request、Secrets 和 Settings API。
- 实现 Electron 窗口、菜单、托盘、剪贴板、shell 等 disposable helper。
- 在首次启用和升级前创建数据库安全备份。

依赖：阶段 2。

完成标准：验收插件通过能力 5–9，推荐 API 写入后的数据、事件和 UI 保持一致。

### 阶段 4：Renderer、React 与 Full Trust Frame

目标：开放宿主界面和不受 v2 sandbox 限制的可信 Web UI。

工作项：

- 实现 Renderer ready handshake、IIFE loader 和 `FullTrustPluginRegistry`。
- 支持 React slot/page/route、独立 root、DOM、全局 CSS 和 `window.knowbook`。
- 实现 Full Trust frame 登记、远程 origin、popup、导航、下载和专属特权窗口。
- 实现 revision 切换与停用时的 UI 清理。

依赖：阶段 2；稳定 UI action 可以使用阶段 3 API。

完成标准：验收插件通过能力 10–11，同时现有 v2 iframe 安全测试保持原结论。

### 阶段 5：npm、Native Module 与后台服务

目标：完成任意依赖和长期系统集成。

工作项：

- 实现 npm/pnpm/yarn、生命周期脚本、build 和 Electron native rebuild。
- 实现 app-lifetime service、RPC、心跳、日志、重启策略和强制停止。
- 实现 detached service 和 OS-startup 的登记、确认、状态与卸载清理。
- 完成三平台打包态集成和升级/回滚测试。

依赖：阶段 1–3；特权后台管理界面依赖阶段 4。

完成标准：验收插件通过能力 4 和 12，纯 JS/native 依赖及两类后台服务在打包应用中可安装、运行和移除。

## 19. 测试计划

### 19.1 单元测试

- v3 manifest、风险目录、entry 路径、hash 和兼容版本校验。
- System installation、revision、dependency job、run、audit 和 crash marker repository。
- 安装/升级/回滚/取消/卸载状态机和过期确认。
- AI 发起请求不能调用确认或启用接口。
- SDK lifecycle、disposable 顺序、超时和重复调用幂等性。
- 文档/数据库稳定 API 的事件和 mutation notification。
- Full Trust frame 登记、revision 撤销和 v2 frame 互不影响。

### 19.2 集成测试

- 临时 userData 下从目录安装验收插件，重启后激活并停用。
- 纯 JS npm 安装、脚本失败、网络失败、构建失败和日志保留。
- native module 针对当前 Electron ABI rebuild 并成功加载。
- mock OpenAI-compatible 服务验证任意消息、流式响应和取消。
- Store 与 raw SQLite 写入、数据库备份和恢复。
- main、renderer、特权窗口、app-lifetime service 的生命周期协同。
- crash marker 模拟异常退出，下次启动自动回滚或安全停用。

### 19.3 E2E 与打包验证

- 插件中心完成选择、风险确认、重启提示、启停、回滚和卸载。
- React/DOM/CSS 注入可见且停用后清理。
- Full Trust iframe 可联网和打开 popup，v2 iframe 仍不能联网、逃逸或弹窗。
- 菜单、托盘、剪贴板、窗口和外部程序测试资源可创建并清理。
- Windows、macOS、Linux 打包应用执行 runtime smoke。
- 安全模式能在坏插件或主进程启动失败后进入应用。

## 20. 最终验收标准

### 20.1 功能验收

- 第 9 节十二项能力均由同一个受控验收插件提供自动化或可重复的 E2E 证据。
- Full Trust 插件可以安装、确认、重启激活、停用、升级、回滚和卸载。
- 插件中心能展示精确 artifact、风险、依赖任务、运行状态和恢复动作。
- app-lifetime 与 detached 服务都能启动、恢复、停止和清理。

### 20.2 安全与恢复验收

- v2 QuickJS、Grant Set、Capability Broker、ViewSpec 和 sandboxed iframe 的既有边界不回退。
- AI 无法完成 Full Trust 确认、启用或 OS persistence。
- 任何代码执行、npm script 和 build 都发生在用户确认精确 artifact 之后。
- 失败 revision 不会造成无限启动循环；安全模式无需加载 Full Trust 插件即可进入。
- 首次启用和升级前的数据库安全备份可恢复。

### 20.3 工程验收

- Shared contract、Main、Preload 和 Renderer 类型一致。
- 新表迁移、备份与恢复有自动化覆盖。
- `npm run typecheck`、`npm run test`、插件安全测试和相关 Electron E2E 全部通过。
- 三平台打包态 runtime smoke 通过。
- Full Trust 尚未完成的阶段不会在 UI 或文档中标记为已实现。

## 21. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 插件读取文件、密钥并通过网络外传 | 用户隐私和凭证泄露 | 精确 artifact 确认、来源/签名/hash 展示、醒目风险文案和审计；不宣称可技术阻止 |
| raw Store/SQLite 写入破坏领域不变量或 schema | 数据损坏、应用无法启动 | 推荐稳定 API、启用/升级前备份、安全模式和恢复入口 |
| 插件死循环、调用 `process.exit()` 或 native module 崩溃 | 主进程退出或启动循环 | crash marker、last-known-good revision、安全模式；Full Trust 本身不承诺进程隔离 |
| npm 生命周期脚本执行恶意代码 | 安装阶段即获得系统访问 | 所有命令在用户确认后执行，展示命令/锁文件/脚本，保留日志 |
| native module ABI 或签名不兼容 | 插件无法加载、三平台差异 | Electron ABI 指纹、安装时 rebuild、升级后重建、打包态矩阵测试 |
| Renderer 插件破坏布局、捕获输入或覆盖全局 CSS | 主界面不可用 | UI 登记清理、安全模式、插件停用；不把 DOM/React 暴露描述为可隔离能力 |
| detached 服务或 OS 启动项残留 | 卸载后仍运行 | 记录 PID/service id/安装步骤，提供显式停止和尽力清理，并明确绕过 SDK 无法保证 |
| 插件依赖 KnowBook 私有 Store/DOM/schema | 应用升级后插件失效 | 版本化稳定 SDK、`engines.knowbook` 检查，将直接对象标记为 unsafe escape hatch |
| AI 诱导用户确认恶意插件 | 任意代码执行 | AI 只能生成请求，确认 UI 不接受 AI 工具调用，并展示精确 artifact 和完整系统风险 |

## 22. 完成定义与已确定决策

本计划全部完成需同时满足：

1. Full Trust v3 的安装、运行、UI、依赖和后台通道均有打包态实现。
2. 十二项能力全部通过验收矩阵，不以“可通过 raw Node 自行实现”替代应提供的宿主集成测试。
3. v2 安全边界和 Legacy v1 兼容行为无回退。
4. 用户始终在任何代码执行前确认精确 artifact；AI 始终不能代替确认。
5. 错误插件可以通过自动回滚、安全停用或安全模式恢复。
6. 文档、SDK 类型、示例插件和三平台测试能够支持第三方开发者独立实现插件。

已经确定且实现时不得重新解释的决策：

- Full Trust 使用独立 System Plugin v3，不拆除 v2 沙箱。
- `fullAccess` 是一次完整信任确认，风险类别不是运行时强制权限。
- 主窗口不为 Full Trust 全局开启 Node；Node + DOM 使用专属特权窗口。
- Main entry 可以直接获得 Store 和 raw SQLite，稳定 API 与 unsafe escape hatch 并存。
- 任意 npm 与生命周期脚本只在用户确认精确 artifact 后运行。
- Full Trust 更新和涉及 native/preload 的状态变更允许要求重启。
- AI 可以生成或请求，但不能确认、安装、启用或持久化 Full Trust 插件。
