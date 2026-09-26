# System Plugin v3 开发指南

本指南对应仓库中的 Full Trust / System Plugin v3 实现，面向愿意完全信任插件代码的桌面用户和开发者。v3 在独立通道运行 Node/Electron 代码，不能将风险声明当成沙箱权限；v2 的隔离插件模型保持独立。当前发布验收范围为 Windows，完整进度以[实施计划](Full%20Trust%20系统插件实施计划.md)为准。

## 从可运行示例开始

[`examples/system-plugin-v3-starter`](../examples/system-plugin-v3-starter) 可直接作为插件目录安装，无需下载依赖或构建。插件会创建一篇示例文档、显示首页 React 卡片，并启动只在应用存活期间运行的后台服务。其 README 说明具体副作用和清理范围。

[主题切换](../plugins/theme-switcher/README.md) 是随应用提供并默认启用的内置 v3 插件：Main 校验并持久化主题选择，Renderer 使用消息接口、设置插槽和可清理的 CSS 注册实现六款主题，不改写宿主浅色 / 深色设置。

[文档翻译](../plugins/document-translator/README.md) 同样是随应用提供并默认启用的内置 v3 插件：复用宿主 AI，将已保存文档翻译为简体中文或逐块双语对照，并创建同级副本。示例展示长任务分批、进度查询、取消、格式保护及完成后统一保存。默认启用只提供操作入口，点击翻译后才调用 AI。

内置代码来自宿主编译时的 `builtin-catalog.ts`，仅支持无需依赖安装的 Main/Renderer 包；注册记录标注为系统内置，不生成用户确认记录。内置版本跟随应用内容哈希更新，保留用户停用、主题偏好和安全停用状态。插件可停用，但不能单独卸载、回滚或从外部覆盖。外部 manifest 和安装请求不能加入该目录；下面的安装确认流程适用于外部插件。

1. 在插件中心选择示例目录，核对来源、插件 ID、SHA-256、系统访问与依赖计划。
2. 由用户勾选完整风险确认并输入完整插件 ID。AI 生成工程或提出请求不能替代这一步。
3. 确认后宿主才发布 artifact、安装依赖及构建。状态变为 `pending-restart` 时重启应用。
4. 检查 `active` 状态、首页卡片和示例文档。停用、升级、回滚、卸载均从插件中心操作。

更新代码后重新选择源目录安装。确认绑定完整 artifact 内容，单改版本号不能复用其他内容的确认；同一已确认 revision 的宿主 ABI 重建则沿用原确认。不要编辑 `system-plugins/artifacts` 下的已发布文件。

## 工程与类型入口

根目录 `plugin.json` 使用 `schemaVersion: 3`、`trust: "full"`、`fullAccess: true`，必填 `id`、`name`、语义版本 `version`、`publisher`、`entries` 和 `riskDeclarations`。`entries.main/renderer/service` 至少一个存在，且每个声明入口都必须是包内实际常规文件。后台配置需要 service 入口。可选 `engines.knowbook` 用于声明宿主版本要求。

入口路径必须相对包根目录；构建生成的内容可以由已存在的入口再加载。目录与 ZIP 安装均会检查路径、链接、文件清单和哈希。不要把指向工程外部的 symlink 或本机 `node_modules` 直接提交为安装 artifact。

[`src/shared/system-plugin-sdk.ts`](../src/shared/system-plugin-sdk.ts) 是集中式 **type-only** 作者入口，导出 manifest、完整 Main Context、生命周期、Renderer API 和 service RPC v1 类型。它引用当前宿主的权威类型，避免手抄接口漂移。在本仓库内可以 `import type` 或使用示例中的 JSDoc；外部工程可将对应 KnowBook 源码版本作为开发时类型来源并配置 `@shared/*` 路径。没有发布独立 npm SDK 包，运行时也不能通过这个路径加载宿主实现。

## Main 生命周期与资源

CommonJS 入口导出含 `activate(context)` 的对象；ESM 可导出等价生命周期。已有成功版本切换到新的待激活 revision 时，`migrate(context, fromVersion)` 在目标 revision 的 `activate` 前调用，包括升级、同版本不同内容以及用户手动回滚；不要假定 `fromVersion` 总是更低版本。首次安装、普通重启及失败后的自动 last-known-good fallback 不调用迁移。可选 `healthCheck()` 返回 `{ ok, message? }`；可选 `beforeQuit()` 和 `deactivate()` 用于退出与停用。

默认预算：迁移与激活各 30 秒、健康检查 10 秒、退出前回调/停用/全部 disposable 各 5 秒。异步超时会触发失败处理；主进程同步死循环、直接 `process.exit()` 和原生崩溃无法由普通 Promise 超时阻止。昂贵计算应放在 service/子进程，激活只完成有界初始化。

`context.plugin` 含 `id/version/revisionHash/root/dataRoot`。`root` 是当前可变运行副本；持久业务数据应写 `dataRoot`，因为重新准备依赖可替换整个 runtime。`context.require` 以插件根目录解析依赖；`context.process` 是宿主进程对象。

`registerDisposable(() => ..., label)` 登记监听器、定时器和自建资源的撤销函数，宿主按注册逆序清理。通过 `desktop.createWindow/createTray`、`background.spawn` 等 helper 创建的资源会登记生命周期；自行 `require('electron')` 或 `spawn` 的副作用须自行清理。`background.daemon` 会脱离应用生命周期；需要跨宿主监督、接管和可卸载身份时，应使用声明式 `entries.service` 与 `background`。

插件中心的资源摘要按 revision 展示 SDK 创建的窗口、菜单、托盘，以及已登记的 frame 策略和特权弹窗。frame 条目代表策略登记，不等于正在显示的原生窗口；菜单条目代表宿主登记，不表示菜单此刻展开。主动关闭/销毁、停用和激活回退会移除登记；停用时窗口中的 `beforeunload` 不能阻止宿主销毁窗口。直接通过原始 Electron 创建的对象不在这份摘要中。

Main 的普通 `console`、`process.stdout/stderr.write` 输出记录在插件日志目录中的 `<revisionHash>-main.log`，插件中心展示路径和所属修订。模块加载、生命周期、由它们创建的异步任务及 SDK 事件订阅回调保持归属；后台服务和依赖任务使用独立日志。写入有行长、队列和轮转上限，常见凭据格式会脱敏，包括分次输出的同一行；关闭时日志刷盘有界，失败不会阻断资源清理。原始文件描述符、自建 worker、绕过 SDK 注册的外部回调不保证被捕获或正确归属，勿依赖日志脱敏代替主动保护密钥。

插件中心分别展示 Main、Renderer 和后台服务的运行状态、精确 revision 与各自 PID。Renderer 的 `ready` 表示界面发布已确认；界面崩溃或重载会更新它的独立状态，重新连接后更新 PID。生命周期错误保留失败阶段，包括迁移、激活、健康检查和资源清理；清理有多处异常时可同时显示多个阶段。

## 数据、事件、设置与 AI

`documents` 提供 `list/get/create/update/move/delete`；`databases` 提供数据库、列、视图和实体 API。完整参数取自 SDK 和 [`contracts.ts`](../src/shared/contracts.ts)。文档写入包装会发出带宿主归属元数据的事件并刷新 Renderer；事件订阅返回撤销函数。注意 `documents.delete` 遵循当前 Store 的删除语义，不要假定等于递归删除所有后代。

```js
const note = await context.documents.create({ title: '导入结果', summary: '插件生成的摘要' })
const unsubscribe = context.events.subscribe((event) => {
  if ('documentId' in event && event.documentId === note.id) {
    // 处理事件时检查 originPluginId，避免自动写回形成循环。
  }
})
context.registerDisposable(unsubscribe, 'note subscription')
context.settings.set(`${context.plugin.id}.lastDocumentId`, note.id)
```

Settings 的任意值是字符串，复杂值自行 JSON 编码并给 key 加插件 ID 前缀。插件私有文件、任意设置和知识库文档属于不同存储范围，卸载专属插件目录不会撤销所有业务写入。

卸载确认框默认选择“保留数据，重新安装时继续使用”，也可选择“同时删除插件专属数据”。选择会持久保存，重启后删除代码、依赖运行副本和插件日志，并按选择保留或删除 `dataRoot`；保留的数据会在同一插件 ID 重新安装时复用。无论选择哪项，已创建的知识库文档、任意设置、插件自行写入的外部文件和数据库安全备份都不会因此自动撤销或删除。插件作者应把可复用的私有文件放在 `dataRoot`，对数据格式变更提供兼容或迁移逻辑。

`ai.complete(input)` 返回 JSON 响应，`ai.stream(input)` 返回可读取流的 `Response`，`ai.rawRequest(input)` 支持任意路径/URL、方法、headers 和 body。Main 输入接受 `AbortSignal`，并随插件停用取消请求。使用宿主 AI 需要已启用配置及密钥；`secrets` 可直接读取 AI key/环境变量，勿将这些值写入日志。`extra` 用于 OpenAI-compatible 扩展参数；非兼容协议可使用 Node 网络能力自行实现。

`store`、`sqlite`、原始 Electron 对象、私有 DOM/数据库 schema 属于直接底层访问，不承诺随 SDK 稳定。直接 SQLite 写入须自行维护 Store 不变量、事件和 UI 刷新，`notifyWorkspaceMutation()` 只触发刷新，不会补建丢失的业务事件。

## Renderer 与窗口

Renderer `.cjs` 导出 `(api) => ...` 初始化函数。使用 `api.React/ReactDOM/ReactDOMClient` 的宿主单例，避免随插件打包另一份 React。`registerSlotContribution`、`registerCommand`、`registerPage`、`injectCss`、DOM/theme helper 和注册的 disposable 随 revision 激活/撤销；自建副作用仍须自行登记。

`documents.header.menu` 位于文档右上角“…”更多操作菜单内，接收当前 `documentId`；使用 `context-menu-item` 样式的按钮执行后自动关闭菜单。该插槽只在菜单打开时挂载，异步任务及需要跨开关保留的状态应放在 Main 或 Renderer 初始化作用域中。`documents.header.actions` 仍是文档页面顶部的独立区域。

`api.showNotification({ title, message, level, progress, progressLabel, actions, persistent })` 使用宿主右下角的应用内通知，返回 `update(input)` 和 `dismiss()` 句柄。`update` 替换同一通知，不重复堆叠，也不会重新弹出已关闭的通知。`level: 'progress'` 的任务通知持续显示，`progress` 为 0–100 百分比，省略时显示不确定进度。操作可用 `{ label, run }` 执行回调，或 `{ label, documentId }` 经宿主正常导航流程打开文档。错误、任务和带操作的通知不自动消失；普通提示在 6 秒后关闭，悬停或键盘聚焦时暂停。通知在 revision 提交后显示，停用、替换或激活失败时自动清理。需要保留任务结果时设置 `persistent: true`；应用退出后通知不持久化。

Main 可用 `context.renderer.handle(method, handler)` 注册插件自己的 JSON 方法，Renderer 用 `await api.invokeMain(method, input)` 调用。例如 Main 注册 `get-state` 返回插件设置，Renderer 挂载时读取，保存表单时调用另一个写入方法。宿主绑定插件 ID 和精确 revision，支持 Main 已就绪后的 Renderer 初始化调用，停用时自动撤销方法并拒绝未完成请求；旧 revision 的调用和返回值不再交付。参数及结果必须为纯 JSON（省略输入时为 `null`），默认每次请求上限 1 MiB、32 个并发请求、15 秒超时。超时不能中止 Full Trust 代码已开始的副作用，耗时任务需由插件自行取消。不要通过此桥返回函数、Store、Electron 对象或流。

从 v1 迁移的完整例子见 [Activity Pulse](../plugins/activity-pulse/README.md)。v1 宿主和 SDK 已删除；需要将旧回调改为上述 Main 服务和 Renderer 插槽，再通过 v3 安装流程确认新 artifact。

`createUnsandboxedFrame` 接收 URL、允许 origin 及导航/popup/下载/permission 策略；`openPrivilegedPopup` 用于宿主管理的窗口。Main 也可用 `desktop.createWindow({ webPreferences: { preload: ... } })` 创建带专属 preload 的窗口。不要把 Main 的 Node Context 当作 Renderer 全局变量使用；Renderer 的宿主桥是 `window.knowbook`，独立 preload 应显式设计自己的通信契约。

## Service SDK 与登录启动

声明 `entries.service` 和 `background: { mode: "app-lifetime", autoStart: true }` 可使用随应用退出的监督服务；`detached` 模式允许服务跨宿主运行，并接受身份核验、重连与接管。服务入口运行时已经具有 `globalThis.knowbookService`，当前 `protocolVersion` 为 `1`。

```js
const api = globalThis.knowbookService
const paths = await api.call('paths.get', {}, { timeoutMs: 5000 })
const note = await api.call('documents.create', { title: '后台导入' })
api.ready({ imported: true })
const timer = setInterval(() => api.heartbeat(), 1000)
```

`call` 使用 JSON 参数/结果，方法名来自 [`createKnowbookFullTrustServiceRpcMethods`](../src/main/system-plugin/knowbook-services.ts)：包括 `documents.*`、`databases.*`、`settings.*`、`ai.complete`、`ai.raw-request`、`secrets.*`、`desktop.*` 等。Main 的 stream `Response` 不会原样跨 service RPC 传输。全局 `call` 仅暴露超时选项；不要传函数、数据库对象或 `AbortSignal` 作为 JSON 参数。服务的 `dataRoot` 来自 `KNOWBOOK_SYSTEM_PLUGIN_DATA_ROOT`。

初始化成功后发送 `ready`，运行期间发送 heartbeat；停止时清理定时器、调用 `dispose` 并退出。宿主提供有限重启和日志。插件可以申请 `osPersistence.request()`（service 使用 `os-persistence.request`），但登录启动项需用户另行核对并确认，不因 Full Trust 安装而自动获批。OS 项删除与 detached 停止状态应在插件中心检查。

## 依赖、构建与原生模块

`dependencies` 声明 `packageManager`、`install`、`allowScripts`、可选字符串数组 `buildCommand`、`rebuildNativeModules`。`ci` 要求 npm/pnpm/yarn 对应 lock 文件；显式 build 在安装后、native rebuild 前运行，每步都有状态、退出码和日志。禁止安装生命周期不代表禁止另行声明的 build 或 native rebuild。

| 管理器 | 冻结安装 | 原生重建 |
| --- | --- | --- |
| npm | `npm ci` | `npm rebuild`，显式 Electron flags |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm rebuild`，Electron 环境变量 |
| Yarn Classic | `yarn install --frozen-lockfile` | `yarn install --force --frozen-lockfile`，会重新执行安装构建脚本 |
| 现代 Yarn | `yarn install --immutable` | `yarn rebuild`，会重新执行构建脚本 |

现代 Yarn 须声明 `yarnMode: "modern"`，使用宿主强制的 `node_modules` 布局；详情见 [Yarn 说明](system-plugin-yarn.md)。pnpm `run/exec` 构建命令会禁用自动再次安装，避免覆盖已确认安装任务的脚本策略。

native rebuild 设置实际 Electron 版本、架构、平台和 headers 地址，并向不同工具透传 `npm_config_*` 与 `npm_package_config_node_gyp_*`。Windows 通常需要匹配的 Python/MSVC 和对应包的 node-gyp；宿主设置 target 不会替作者补齐编译工具或解决依赖自身的构建批准规则。随后在隔离 Electron Node 进程中探测 `.node`；失败会阻止候选版本发布，保留当前 active revision 和构建诊断。应用 Electron ABI 变化会触发重新准备。

## 失败、回滚与验证

安装/build/native 失败时检查 dependency job 日志，未运行的后续任务会取消。激活失败会清理已登记资源并尝试 last-known-good revision；无可恢复版本时安全停用。必要时从插件中心“安全模式重启”，或在启动前设置 `KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE=1` 以跳过 Full Trust 激活，再排查插件。

首次安装、升级及宿主 ABI 重新准备会在依赖脚本/build/native 运行前创建数据库备份，启用和代码回滚也会保留安全备份路径；失败安装请求附带可恢复路径。**回滚代码不会自动恢复数据**。插件迁移必须可重试，尽量保持旧版本可读；SQLite 安全备份使用退出应用后的 `--knowbook-restore-database=<绝对备份路径>` 维护入口，具体命令、后台进程检查、原文件保留和安全启动见[数据库恢复指南](system-plugin-database-recovery.md)。崩溃导致的未完成启动记录会在下次启动参与恢复，不能视为插件已成功运行。

依赖执行中宿主异常退出后，下一次启动会把中断任务标记为 failed，并取消尚未执行的后续任务，不会自动续跑脚本。只有确认相关进程已退出后才清理精确归属的临时目录；无法核验的进程会阻止清理和重试。重新选择同一个 artifact 并完成新的精确确认后可以重试，原 active revision 和诊断日志保留。

作者提交前应实际验证：首次安装、相同工作区重启、停用清理、版本升级、失败候选保留旧版本、代码回滚和卸载。仓库 `tests/main-system-plugin-example.test.ts` 使用真实 Store 与 Main Host 验证示例安装入口、文档幂等创建、事件清理及迁移。Windows 打包态的独立能力/依赖/原生验收仍由各 E2E 命令提供；示例单测不替代整个 v3 发布验收。

`npm run typecheck:system-plugin-examples` 会用集中 SDK 类型检查三个实际 `.cjs` 示例入口。新增接口或修改调用参数后应运行此检查，并继续运行仓库要求的 `npm run typecheck` 与 `npm run test`。
