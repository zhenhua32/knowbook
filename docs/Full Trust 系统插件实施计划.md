# KnowBook Full Trust 系统插件实施计划

> 文档状态：已完成（按用户确认的本次验收范围）
> 适用版本：KnowBook 0.2.x+
> 最后更新：2026-09-10
> 当前验收范围：Windows；按 2026-09-07 用户要求，macOS/Linux 实测不列为本轮或发布阻塞项。按 2026-09-10 用户要求，真实 Windows 登录和系统重启暂不执行，由用户后续手测，不阻塞本次目标完成。已有跨平台实现与单元测试继续保留；暂缓项目不记为测试通过。
> 目标读者：产品、Main/Preload/Renderer 开发、插件作者、安全评审与测试

## 1. 执行摘要

KnowBook 已在现有 Plugin Platform v2 之外新增 **Full Trust / System Plugin v3** 通道。v3 面向用户明确选择并完全信任的本地插件，允许直接使用 Node.js、Electron、文件系统、环境变量、密钥、网络、npm、KnowBook Store、原始 SQLite、宿主 Renderer 和长期后台服务。

Full Trust 不是对 v2 capability 的简单扩容，也不使用沙箱或细粒度权限开关制造虚假的安全承诺。插件一旦在主进程或具有 Node 权限的上下文运行，就能够绕过宿主包装，因此 manifest 中的风险声明只承担告知、确认、审计和变更比较职责，不是可强制执行的权限边界。

现有插件分层保持不变：

- v2 用户/AI 动态插件继续运行在 QuickJS/WASM 无 Node 隔离环境中。
- Full Trust 插件进入独立的 System Plugin v3 安装、确认、运行和恢复通道。
- Legacy v1 继续作为兼容层，不自动升级为 Full Trust，也不获得 v3 安全或能力声明。
- AI 可以生成 Full Trust 插件工程或提出安装请求，但不能代替用户确认、安装、启用或授予系统访问。

长期架构约束由 [ADR-0007](adr/0007-full-trust-system-plugins.md) 固化。本文件定义可直接实施的产品行为、接口、数据流、阶段和验收标准。

## 2. 背景与当前状态

### 2.1 当前插件体系

当前仓库已经具备四类基础：

1. Plugin Platform v2：使用 QuickJS/WASM、不可变 revision、Grant Set、Capability Broker、声明式 ViewSpec 和 sandboxed iframe。
2. Legacy v1：使用现有 `PluginHost` 和 utility process，提供首页卡片、文档动作、设置、事件监听、文档读取和摘要更新等兼容能力。
3. System Plugin v3 核心链路：已加入 v3 manifest 与 artifact 校验、精确 SHA-256 确认、不可变发布、持久化状态、重启激活、Main 生命周期、版本化 service RPC、宿主服务、Renderer registry、插件中心入口、回滚/卸载和启动恢复的首轮实现及自动化测试；受控 Windows Electron E2E 已验证精确确认、离线 npm 依赖准备，以及重启后的 Main、任意 AI 请求、app-lifetime service RPC、Renderer、HTTP/WebSocket Full Trust frame、主进程创建的 Node 特权窗口和最终 `active` 状态。
4. 发布验收进展：同一受控插件十二项能力、各包管理器原生重编译、安装中断/数据库恢复、日志/资源/独立进程状态、数据保留卸载，以及真实 NSIS/更新器升级、回退和卸载均已取得 Windows 证据。本次确认范围内的实现和验收已完成；真实 Windows 登录/系统重启由用户后续手测，macOS/Linux 实测按用户要求不作为门槛。

v2 当前只适合受控的知识库自动化。它不会向插件暴露 Node、Store、SQLite、用户目录、API Key 或宿主 Renderer，这一边界是有意设计，不能为实现 Full Trust 而拆除。

### 2.2 本计划解决的问题

高级本地插件需要完成以下工作：

- 集成本机开发工具、CLI、原生模块和长期服务。
- 直接操作 KnowBook 数据、内部服务和 Electron 桌面能力。
- 使用任意 npm 生态、网络协议和模型供应商。
- 构建与宿主深度集成的 React/DOM 界面。
- 在用户完全知情的前提下读取密钥、用户文件或运行外部程序。

这些需求不能在“不可信代码仍受强隔离”的前提下同时满足。因此 v3 明确采用完全信任模型，并把风险控制重点放在来源、精确 artifact、显式确认、可恢复启动、备份、日志和卸载上。

### 2.3 实施进度矩阵

截至 2026-09-10，阶段 0–5 的实现与本次确认范围内的验收已完成，ADR-0007 更新为 Implemented。下表记录实现、已取得的 Windows 证据与后续手测安排。按用户要求，macOS/Linux 实测不作为本轮门槛，真实 Windows 登录/系统重启由用户后续手测；已有跨平台实现和单测保留。

| 阶段 | 当前实现与已验证行为 | 验收结论与后续安排 |
| --- | --- | --- |
| 0：契约与防回归 | v3 manifest、精确 artifact 确认、独立安装/运行通道；同一打包宿主中真实 v2 QuickJS 与 iframe 默认拒绝控制组 | 673 项完整测试、安全测试及 83 项桌面用例通过；其中两项启动时序问题修复后定向复验通过 |
| 1：安装与插件中心 | schema v12、不可变 artifact、可变 runtime、依赖任务/审计、升级/回滚、保留或删除私有数据、重新安装复用；真实安装中断后保留旧 active、失败任务和日志，同 hash 需再次选择与确认方可重试 | 已通过独立 NSIS/更新器闭环（含两种数据卸载选项） |
| 2：Main 与恢复 | CJS/ESM、生命周期、Context/disposable、crash marker、安全模式、last-known-good；新增 Main stdout/stderr 按 revision 归档，SDK 事件回调保持日志归属 | 已补齐分进程状态、实际 PID、失败阶段与原堆栈；安全启动会退休历史运行记录 |
| 3：数据、AI、桌面 | Documents/Databases/Store/raw SQLite、事件与真实 Renderer 刷新、AI 流式/取消/错误、Settings/Secrets；剪贴板、shell、菜单、托盘、专属 preload 窗口；安装脚本执行前备份、SQLite 恢复维护入口、托管资源摘要 | 已通过独立运行状态/真实 PID 与数据库恢复；最终包 1280/900 宽度排版已无注入实测，字段清楚且无裁切 |
| 4：Renderer 与可信 frame | React 单例、页面/命令/快捷键、DOM/CSS/theme、任意 preload API；远程 HTTP/WebSocket frame、权限/导航/下载与独立 Node 特权窗口；停用清理及阻止关闭时销毁窗口 | 已取得资源摘要、日志和实际 beforeunload 清理证据 |
| 5：依赖与后台服务 | npm、pnpm 11.19.0、Yarn Classic 1.22.22、Yarn 4.9.4；四种管理器的 Electron native rebuild；真实 ABI 133→135→133 重建；RPC、心跳、有限重启、detached 同 PID 接管与显式停止；Windows Run 独立确认及维护卸载 | 本次范围内已通过；真实 Windows 注销/登录和系统重启未执行，由用户后续手测 |

同一个受控插件的十二项核心能力已在 Windows unpacked 完成八阶段统一验收，证据为 `test-results/system-capabilities/**/capabilities-evidence.json`，十二行均 passed 且清理错误为空。新增资源摘要、日志归属与脱敏、宿主事件回调、实际 beforeunload 拦截及停用销毁断言也已通过。可长期保留的证据归档在 `release/acceptance/system-capabilities`。

| 能力 | 已取得的统一验收证据 |
| --- | --- |
| 1–2：文件、系统与进程 | 用户选择目录、私有数据、Node/process/require、环境、真实外部 URI helper 与进程退出 |
| 3：网络 | HTTP、WebSocket、可信本地 TLS、拒绝非可信 TLS、取消及错误 |
| 4：依赖与原生模块 | 同一插件离线 npm 本地依赖与真实 SQLite .node；独立管理器矩阵另验证安装脚本、构建与 C++ ABI 重编译 |
| 5：AI | 宿主配置与密钥、任意消息、SSE/UTF-8、取消、停用断连、HTTP/JSON 错误及原始响应 |
| 6–7：文档与数据库 | 树操作、链接、数据库/列/视图/批量实体、raw SQLite、事件及真实 Renderer 刷新 |
| 8–9：桌面与设置 | 剪贴板所有权、菜单、托盘、外部程序、专属 preload/Node 窗口、设置与主题持久化 |
| 10–11：Renderer 与可信 UI | React/DOM/CSS/页面/命令/快捷键、远程 frame、popup/导航/下载/权限、精确 revision 策略及 v2 拒绝控制组 |
| 12：后台 | app-lifetime、六次受控服务崩溃达到五次重启上限后安全停用、用户恢复、detached 宿主退出仍心跳、原 PID 接管/RPC 重连、显式停止与卸载 |

Windows Run 命令重放、真实 Electron ABI 切换和统一插件验收是不同证据；它们不能代替真实系统登录/重启，也不等于 NSIS 安装器/更新器验收。当前进度以第 19.4 节为准。

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
6. 确认后将已复核的 staging 内容原子发布到 `userData/system-plugins/artifacts/<pluginId>/<contentHash>`；发布过程排他占用目标、排他复制并重新计算 hash，不替换已经存在的 revision。
7. 在任何依赖安装、脚本、build、native rebuild 或 probe 之前创建 SQLite 安全备份；随后将不可变 artifact 复制到 `userData/system-plugins/runtime/<pluginId>/<contentHash>`；包括无依赖包在内的所有代码都从可变 runtime 执行，依赖安装、生命周期脚本、构建、native rebuild 与 probe 也只修改该副本，并保存完整输出。
8. runtime 准备成功后，installation 指向 pending revision，状态变为 `confirmed-restart-required`。
9. 重启后启动协调器激活 pending revision；健康检查通过后提交为 current revision。
10. 激活失败时清理失败的启动任务，恢复上一个已知可用 revision 或安全停用，并在插件中心显示错误。

依赖安装开始后，插件脚本已经拥有与 Full Trust 代码相同的系统风险，因此确认必须发生在任何 `preinstall`、`install`、`postinstall` 或 build 命令之前。

### 6.2 AI 请求规则

- AI 可以生成插件工程、manifest、风险说明和待安装请求。
- AI 创建的请求必须停在 `awaiting-confirmation`。
- AI 工具不得调用确认、启用、重启安装或 OS persistence 接口。
- 助手当前对 v2 使用的自动 `allowed-once` 路径不得复用于 v3。
- 用户拒绝或请求过期后，staging artifact 可以安全删除，且不得执行其中代码；启动协调器会清扫已结束请求遗留的受管 staging 目录并写入审计记录。

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
- 同步启动失败不会留下伪 `active` 状态；被 reject 的启动 Promise 会从协调器缓存移除，避免后续受控恢复复用永久失败的 Promise。

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
- 已有成功 package 切换到 pending revision 时，先有界执行新 revision 的 `migrate(context, fromVersion)`；首次安装和 last-known-good fallback 不调用，迁移失败按 pending 激活失败处理并回滚。
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
- 同步异常和 rejected promise 写入运行记录并触发回滚或安全停用；失败的启动 Promise 不会永久留在缓存。原生崩溃、死循环、`process.exit()` 和全局 monkey patch 无法隔离。

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
- service 默认使用 Node 子进程，继承 Full Trust 所需环境，并获得插件数据目录。
- service 不能直接持有 Main 内存中的 Store 对象；宿主在执行 entry 前安装只读的 `globalThis.knowbookService`，通过 service RPC v1 调用 Main 白名单 API。
- RPC 请求绑定精确 plugin ID 与 revision，使用闭合 JSON envelope；宿主限制单条消息大小、对象深度/节点数、并发数和执行时间，并只审计 method、request ID、结果和耗时，不记录参数或返回值。
- manager 为 service RPC 建立确定性的本机命名管道（Windows）或 Unix socket（macOS/Linux）；连接使用精确 plugin ID、revision 与 detached launch nonce 完成闭合握手，Unix socket 权限收敛为当前用户。bootstrap 在宿主不可用时采用有界指数退避，并限制帧大小、待处理请求和重连队列；新宿主 adoption 后以持久化 nonce 重新开放端点，原 detached PID 无需重启即可恢复 RPC。未配置本机端点的低层 supervisor 调用仍保留父子进程 IPC 兼容路径。
- service 始终可以自行使用数据库路径和 `better-sqlite3`，但绕过 RPC 后必须自行承担并发写入、事件通知和领域一致性风险。
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

### 10.5 Service RPC v1

service entry 启动前可直接取得以下全局接口：

```ts
interface KnowbookServiceRpcV1 {
  readonly protocolVersion: 1
  readonly pluginId: string
  readonly revisionHash: string
  call(method: string, params?: JsonValue, options?: { timeoutMs?: number }): Promise<JsonValue>
  ready(payload?: JsonValue): void
  heartbeat(payload?: JsonValue): void
  on(event: string, listener: (payload: JsonValue) => void): () => void
  dispose(): void
}

declare const knowbookService: KnowbookServiceRpcV1
```

v1 白名单覆盖：

- `system.ping`、`paths.get`。
- `documents.list/get/create/update/move/delete`。
- `databases.list/create/update-metadata/delete`，以及 column、view、entity 和 document value 的完整 CRUD/批量入口。
- `settings.get/list/set/delete/get-appearance-theme/set-appearance-theme/get-ai-config`。
- `secrets.get-ai-api-key/get-environment-variable/get-environment-snapshot`。
- `ai.get-config/complete/raw-request`；流式或非 JSON 场景仍可由 Full Trust service 直接发起网络请求。
- `events.emit`、`workspace.notify-mutation`、`os-persistence.request`。
- `desktop.clipboard.*` 与 `desktop.shell.open-external/open-path/show-item-in-folder`。

未知方法返回 `method-not-found`，身份不匹配返回 `identity-mismatch`，超时、取消、拥塞、无效请求和 handler 失败均返回无堆栈的结构化错误。RPC 是稳定集成接口，不改变 Full Trust 插件可以绕过它的事实。

## 11. npm、构建与原生模块

### 11.1 包管理器

- 支持 npm、pnpm 和 yarn；默认按锁文件选择，并允许 manifest 显式指定。
- 当前 Windows 打包态依赖安装/build 与 native rebuild 均已覆盖 npm、pnpm 11.19.0、Yarn Classic 1.22.22 和现代 Yarn 4.9.4。现代 Yarn 通过 `yarnMode: "modern"` 显式选择，宿主强制使用 `node_modules` 布局，不在共享 Main 中注册全局 PnP loader；省略该字段仍使用 Classic 行为。各管理器的安装、脚本策略、重编译命令和真实 ABI 验收说明见 [Yarn 与原生重建说明](system-plugin-yarn.md)。
- `install: ci` 要求锁文件，`install: install` 允许更新依赖解析结果并在确认页突出显示。
- 逻辑命令始终以可审计的参数数组保存并执行；常规命令保持 `shell: false`。Windows 的 npm/pnpm/yarn 是 `.cmd` shim，宿主仅对这三类已知入口通过 `%ComSpec% /d /s /c` 适配，并拒绝含空白或 shell 元字符的参数，避免把 manifest 变成自由格式命令行。
- 包管理器不可用、网络失败或脚本失败时保留安装日志，artifact 不进入 active 目录。
- timeout 或用户取消会先请求优雅终止，再强制终止整个进程树；runner 等待进程实际关闭后才返回，避免仍在运行的脚本与 runtime 清理竞争。

### 11.2 生命周期与构建

允许依赖和插件自身的 `preinstall`、`install`、`postinstall`、prepare 和 build 脚本。安装确认必须展示实际命令与 `allowScripts` 状态。宿主先保留已确认、不可变的 artifact 基线，再将所有包复制到可变 runtime；构建和探测不修改该基线，runtime entry 在激活前重新校验。

### 11.3 Native module

- 根据当前 Electron version、ABI、平台和架构执行 rebuild。
- 保存锁文件 hash、平台、架构、Electron ABI 和 rebuild 结果作为运行时指纹。
- 平台或 Electron ABI 改变后，在插件激活前重新 rebuild；失败则停用该 revision。
- probe 扫描完整 runtime，而不只扫描 `node_modules`，因此也覆盖插件自带的 `build/Release/*.node` 与包管理器的展开目录；发现与逐模块加载均支持取消，并受总时间预算和单模块 timeout 约束。
- native probe timeout/cancel 与依赖命令采用相同的进程树终止和关闭等待语义；指纹记录过 native module 的包在 ABI 变化后必须重新准备并探测，即使 manifest 没有声明 rebuild 计划。
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

Full Trust iframe 必须登记 pluginId、精确 revision、不可猜测的 frameName/popupName、允许的 origin，以及是否允许 popup、导航、下载和权限请求。主进程只对当前启用且 revision 匹配的登记放行。由于 Electron 不允许沙箱 opener 将原生子窗口提权，匹配 popup token 时由主进程独立创建 `nodeIntegration: true`、`sandbox: false` 的特权 `BrowserWindow`，原始 `window.open` 仍返回 deny。插件停用或 revision 切换时立即撤销登记并关闭所属窗口。

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
- detached adoption 不只按 PID 认领进程，还核对可执行文件、OS process start token、revision、service entry 和 launch nonce，拒绝 PID 复用或旧 revision 冒充。停止时先发送优雅终止，超时后升级为强制终止，并再次确认目标已经退出。
- detached service 的 RPC 使用确定性本机端点和持久化 launch nonce；KnowBook 退出时关闭端点但保留进程，服务持续退避重连，新宿主完成复合身份校验后重新开放同一端点。手动启动也会捕获身份；安全模式、停用、升级、回滚和卸载会在发信号前再次核对 PID、start token 与可执行文件，无法核验时拒绝误杀并保留错误记录。
- 当前宿主管理实现使用 Windows/macOS Electron login item 与 Linux XDG autostart desktop file；登记命令启动 KnowBook，再由已确认 installation 恢复 detached service。
- macOS 的 `mainAppService` 是应用级全局单例；manager 对多个插件请求做唯一归属协调，避免后启动插件静默覆盖另一个插件的登记。
- 登记前先持久化可执行文件、参数、service id、revision 和清理描述，只有用户再次核对并确认后才写入系统；AI 和插件自身只能创建待确认请求。
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
| `system_plugin_os_persistence` | 登录启动的精确命令、revision、service id、平台清理描述、确认状态和错误 |

现有 `system_plugin_install_requests` 增加 staged artifact、真实 hash、manifest snapshot、依赖计划、确认版本、最终 installation 和错误信息。请求中的 hash 必须由主进程对本地 artifact 计算，不能信任 Renderer 或 AI 传入的声明值。

## 15. 数据一致性与备份

- 推荐 SDK 写操作复用 Store，确保路径、链接、字段约束、FTS、事件和 UI 刷新一致。
- raw SQLite 写入不保证领域不变量。执行后插件必须主动调用 `notifyWorkspaceMutation`，必要时补发事件。
- Full Trust 插件在任何依赖脚本/build/native 运行前、首次启用、升级/回滚及 ABI 重新准备前创建数据库安全备份，并在 installation 或失败请求中记录备份路径。
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
- 插件 stdout/stderr 写入按插件和 revision 分隔的滚动日志；单文件与保留总量都有上限。
- dependency、native probe、service、RPC 日志和持久化错误详情限制单条大小，并对常见 Authorization/Bearer、API key、token、secret、password 形态做尽力脱敏。
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
- 确定 Windows 的安装、native rebuild 和安全模式验证矩阵。

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
- 完成 Windows 打包态集成和升级/回滚测试。

依赖：阶段 1–3；特权后台管理界面依赖阶段 4。

完成标准：验收插件通过能力 4 和 12，纯 JS/native 依赖及两类后台服务在打包应用中可安装、运行和移除。

当前证据：Windows unpacked 的纯 JS、四种包管理器 native rebuild、真实 SQLite、宿主 ABI 133→135→133、app-lifetime/detached、Run 注册/命令重放和统一十二项核心能力均已有实测。NSIS/更新器闭环亦已通过；真实 OS 登录/重启按 2026-09-10 用户要求留待其后续手测，不阻塞本次完成。命令与精确结果见第 19.4 节。

## 19. 测试计划

第 19.1–19.3 节描述最终需要具备的完整测试矩阵，不代表其中每一项已经完成。当前已经取得的证据单列在第 19.4 节。

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
- Full Trust iframe 可联网、请求登记权限并触发主进程创建 Node 特权窗口，v2 iframe 仍不能联网、逃逸或弹窗。
- 菜单、托盘、剪贴板、窗口和外部程序测试资源可创建并清理。
- Windows 打包应用执行 runtime smoke。
- 安全模式能在坏插件或主进程启动失败后进入应用。

### 19.4 自动化验收证据与后续手测

下表记录实际执行结果；脚本存在、CI 已接线或代码通过单测不等同于打包态验收通过。各 runner 将证据写入 `test-results/<场景>`，包含阶段、版本/ABI、失败原因和清理结果；收尾证据归档在 `release/acceptance`，避免后续运行覆盖。真实 Windows 登录/重启仍记为未执行，按用户要求由其后续手测，不属于本次完成门槛。

| 验收 | 当前结果 | 入口或证据 |
| --- | --- | --- |
| 同一插件十二项核心能力 | 已通过，八阶段、十二行 passed、cleanupErrors 为空；含资源/UI、日志归属/脱敏与真实 beforeunload 清理 | `test:packaged-system-capabilities`；`capabilities-evidence.json` |
| npm 与 SQLite native | 已通过；真实 .node 查询、坏二进制拒绝、插件升级/回滚、私有数据保持与卸载 | `test:packaged-system-plugins` |
| 安装脚本与显式 build | 已通过；确认前不执行，allowScripts 开关、阶段顺序、失败后续任务 cancelled、旧 active 保留 | `test:packaged-dependency-scripts` |
| pnpm / Yarn Classic 纯 JS | 已通过，两项合计 1.3 分钟；离线锁文件、脚本/build、重启加载、失败保护与卸载 | `test:packaged-package-managers` |
| Yarn 4.9.4 纯 JS | 已通过，41.9 秒；immutable、node_modules 布局、脚本/build 与重启加载 | `test:packaged-modern-yarn` |
| pnpm / Classic / Modern 原生重编译 | 全部通过，分别约 1.5 / 1.1 / 1.5 分钟；真实 Node ABI 127→Electron ABI 133、不可变 artifact、编译失败保护与卸载 | `test:packaged-native-package-managers`；`native-rebuild-evidence.json` |
| 真实宿主 ABI 升级/回退 | 最终源复验通过，3.8 分钟；Electron 35.7.5/133→36.0.0/135→35.7.5/133；相同确认、数据保持、兼容重启不重复编译 | `test:packaged-host-upgrade`；`host-upgrade-evidence.json` |
| Windows Run 与 detached | 已通过，1.3 分钟；独立确认、真实注册/移除、命令重放、同 PID 接管及 RPC、停止重启和卸载 | `test:packaged-windows-startup`；不含真实注销或重启 |
| 卸载私有数据选择与重装 | 已通过，44.2 秒；真实 UI 默认保留、取消、删除、重启后选择持久化、同 ID 复用数据 | `test:packaged-data-retention`；`data-retention-evidence.json` |
| 安装中断与同 hash 重试 | 已通过，58.5 秒；真实 npm/build 中断、旧 active 保留、任务失败/取消、精确临时目录清理、再次用户确认 | `test:packaged-install-interruption`；`install-interruption-evidence.json` |
| 应用卸载维护 CLI | 已通过，55.4 秒；精确托管 Run/StartupApproved/服务清理、无关同 exe 项保留、幂等、保留 DB 且插件不激活 | `test:packaged-uninstall-cleanup` |
| Main 异常退出与启动恢复 | 五场景全部通过，3.1 分钟；throw、process.exit、同步死循环、process.crash、首次激活失败 | `test:packaged-activation-recovery` |
| SQLite 备份恢复维护入口 | 已通过，最终 1.4 分钟；含损坏 DB、真实服务停止、源 hash 不变、安全停用、Main/Renderer 历史状态退休及失败诊断保留 | `test:packaged-database-restore`；[恢复指南](system-plugin-database-recovery.md) |
| 独立 NSIS / electron-updater | 全部通过，4.7 分钟；真实 0.1.2→0.1.3→0.1.2、旧服务退出/新 PID、Run 与数据保留、两种卸载及无残留 | `prepare:windows-installer`、`test:packaged-windows-installer` |
| 真实 Windows 登录 / 重启 | 未执行；2026-09-10 用户明确暂缓，由其后续手测，不阻塞本次完成 | [会话验收说明](system-plugin-windows-session-acceptance.md) |
| 类型、完整测试、安全、构建与 smoke | 673 项完整测试、类型/示例检查、构建、18 项安全测试及 smoke 通过；83 项桌面用例首次 81 通过（11.8 分钟），另两项修复测试 PID 读取时序后复验通过（19 秒） | `typecheck`、`test`、`test:plugin-security`、`build`、`test:packaged-runtime-smoke` |

实施中发现并修复的问题包括：Windows GUI 依赖进程输出丢失；Electron 35/36 文件设备编号表示差异；pnpm build 隐式重装和可变 runtime 迁移后的内部链接；不同管理器的 rebuild 命令与 node-gyp Electron target 传递；安装任务中断遗留状态；Windows MSIX 路径重定向；中文可执行文件路径经 PowerShell 非 UTF-8 管道损坏、Electron 登录启动 setter/query 边界未给含空格 exe 路径加引号。相应修复均有定向回归。

恢复与可观测性新增覆盖：任意依赖代码执行前备份；按 revision 的 Main/service/dependency 日志、分片凭据脱敏与有界写入；SDK 事件回调的日志归属；托管窗口/菜单/托盘与 frame 策略摘要；beforeunload 不能阻止停用清理；SQLite 损坏备份拒绝、原始 DB/WAL/SHM 保留、替换失败/中断回退、候选数据库损坏时回退、后台进程身份核验与首次安全启动。

[Windows CI](../.github/workflows/ci.yml) 已接入所有独立 runner 并上传 `test-results/**` 与 `release/acceptance/**`；真实系统登录/重启仍需独立会话验收，不由 CI 中的命令重放替代。固定工具链只安装在 release 下的测试目录，详见 [Yarn 与原生重建说明](system-plugin-yarn.md)。

最终界面验收使用真实 Windows 包，不注入 CSS；1280/900 两个宽度的字段、hash、日志路径均无溢出，状态字段间距为 6px。证据与原始截图在 `release/acceptance/plugin-ui-layout-final`。

推荐执行顺序：

```sh
npm run build
npm run pack
npm run test:packaged-runtime-smoke
npm run test:packaged-system-plugins
npm run test:packaged-dependency-scripts
npm run prepare:package-managers
npm run prepare:modern-yarn
npm run prepare:native-package-managers
npm run test:packaged-package-managers
npm run test:packaged-modern-yarn
npm run test:packaged-native-package-managers
npm run test:packaged-system-capabilities
npm run test:packaged-activation-recovery
npm run test:packaged-data-retention
npm run test:packaged-database-restore
npm run test:packaged-install-interruption
npm run test:packaged-windows-startup
npm run test:packaged-uninstall-cleanup
npm run prepare:host-upgrade
npm run test:packaged-host-upgrade
npm run prepare:windows-installer
npm run test:packaged-windows-installer
```

所有 E2E 使用隔离 userData；独立 NSIS 夹具另随机化 appId、GUID、产品/包名及可执行文件，使用本地更新服务，不发布安装包。源码 native 验收需要 Python、C++ 工具链、对应 Node/Electron headers；首次准备工具链可能访问 registry。显式 `KNOWBOOK_E2E_EXECUTABLE` 必须指向存在的真实打包文件。

本机签名工具解压需要的符号链接权限不可用，因此本地 unpacked 验收使用下述命令；它仅影响当前打包命令。独立 NSIS 夹具亦不作为正式发行签名证据。

```powershell
npx electron-builder --dir --publish never '--config.win.signAndEditExecutable=false'
```

## 20. 最终验收标准

截至 2026-09-10，本次确认范围内的最终验收已完成，ADR-0007 更新为 Implemented。实际功能、恢复、依赖、分进程状态和 NSIS/更新器的 Windows 验收均已取得通过证据，类型/构建/673 项测试通过；83 项桌面用例均取得通过结果（含两项时序修复后的复验）；排版收尾结果见第 19.4 节。真实 Windows 注销/登录和系统重启未执行，由用户后续手测；macOS/Linux 实测亦按此前要求不列为本次门槛。

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
- Windows 打包态 runtime smoke 通过。
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
6. 文档、SDK 类型、示例插件和 Windows 测试能够支持第三方开发者独立实现插件。

完成结论（2026-09-10）：上述六项已在本次确认范围内满足。实现与自动化证据见第 2.3、19.4 节；第三方开发入口为 [开发指南](system-plugin-v3-development.md)、[SDK 类型](../src/shared/system-plugin-sdk.ts) 与 [示例插件](../examples/system-plugin-v3-starter)。真实 Windows 登录/重启保留为用户后续手测，macOS/Linux 实测按用户要求排除；这些范围调整不改变测试记录，不表示相关真实系统场景已经通过，也不改变下列架构决策。

已经确定且实现时不得重新解释的决策：

- Full Trust 使用独立 System Plugin v3，不拆除 v2 沙箱。
- `fullAccess` 是一次完整信任确认，风险类别不是运行时强制权限。
- 主窗口不为 Full Trust 全局开启 Node；Node + DOM 使用专属特权窗口。
- Main entry 可以直接获得 Store 和 raw SQLite，稳定 API 与 unsafe escape hatch 并存。
- 任意 npm 与生命周期脚本只在用户确认精确 artifact 后运行。
- Full Trust 更新和涉及 native/preload 的状态变更允许要求重启。
- AI 可以生成或请求，但不能确认、安装、启用或持久化 Full Trust 插件。
