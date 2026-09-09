# Windows 插件 v3 统一能力夹具

运行 `npm run test:packaged-system-capabilities`。它要求已生成 Windows unpacked 应用，以及与该应用 Electron ABI 一致的 `better-sqlite3.node`。

测试把这里的文件、`full-trust-acceptance` 的 Main/AI 练习代码、本地 npm 依赖和真实 SQLite addon 放进同一个临时插件包。每次安装先确认该完整 artifact；1.0.0 验证 app-lifetime，2.0.0 在同一插件 ID 和数据目录中验证 detached。

`capabilities-evidence.json` 记录精确 revision、native hash/ABI、受控外部进程回执、各阶段快照和十二项能力矩阵。任何阶段或清理失败都不能作为十二项最终通过的证据。夹具不证明真实系统登录、操作系统重启或 NSIS 安装器行为，这些由其他验收负责。

桌面验证会短暂使用真实剪贴板和托盘、创建隐藏的专属 preload 窗口及一个菜单。停用时恢复本次激活前剪贴板的 Electron 支持格式，并避免覆盖用户在测试期间写入的新文本；验收仅保存原内容的哈希。外部程序通过仅本次 UUID 命名的 HKCU URI scheme 启动，使用隐藏 WScript 包装器运行 Node helper；测试检查 HTTP 回执和全部 helper 进程退出，finally 删除注册项。

资源摘要检查真实 SDK 窗口、菜单、托盘、登记的 frame 与特权 popup 的精确修订归属，并对照插件中心 UI。主动关闭窗口/popup、销毁托盘后摘要必须同步；原始 Electron 窗口不冒充宿主登记资源。最后让实际 popup 的 `beforeunload` 阻止一次关闭，再停用插件，要求宿主销毁 popup 并清空摘要。

Main、Renderer、service 分别对应独立运行记录。验收把宿主 `process.pid`、主窗口 `webContents.getOSProcessId()` 和真实服务 RPC PID 与记录逐一对照，检查激活/停用状态及插件中心展示的精确修订与 PID，并保存激活和停用后的 UI 截图。

Main 输出包含激活、继承异步上下文、分片 stdout Bearer、stderr、deactivate 和 disposable 的固定测试标记；伪凭据使用 `capability-fake-*`。普通 Renderer 新建文档还会触发插件预先登记的事件订阅，检查同步及 Promise 异步回调日志仍归属插件。断言 Main、service、dependency 日志分离，常见凭据及分片文本脱敏，停用日志保留且最终卸载清理原日志目录。验收附件保留已验证日志的副本。

`tls-key.pem` 和 `tls-cert.pem` 是专门为本地测试生成、公开随仓库保存的自签证书材料，不能用于生产。测试仅把该证书传给单次受控 HTTPS 请求，并同时验证没有该信任时的证书拒绝。

v2 比较插件通过 `helpers/prepare-capabilities-v2.ts` 写入已停止的隔离 profile。该准备过程不执行数据库迁移、不伪造运行记录。随后实际打包宿主必须通过 QuickJS、UI readiness handshake 和 `knowbook-plugin-ui://` 文档登记加载它；比较插件不计入 v3 的能力实现。
