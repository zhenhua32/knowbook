# ADR-0007：Full Trust 系统插件使用独立 v3 通道

- 状态：Implemented
- 日期：2026-09-01
- 实施验收日期：2026-09-10（按用户确认的本次范围）
- 决策范围：System Plugin v3
- 依赖：[ADR-0001](0001-plugin-trust-and-dependency-policy.md)
- 相关决策：[ADR-0002](0002-plugin-runtime-isolation.md)、[ADR-0004](0004-plugin-ui-extension-isolation.md)

> 后续变更：[ADR-0008](0008-remove-v1-plugins.md) 已取代保留 v1 的兼容条款，仓库旧插件迁为 v3；本决策的 Full Trust 确认和运行边界继续有效。

## 背景

部分插件需要文件系统、原始数据库、Node.js、Electron、网络、任意 npm 依赖、宿主 Renderer 和常驻后台服务等完整本机能力。这些能力无法在 Plugin Platform v2 的 QuickJS/WASM、Capability Broker 和隔离 UI 边界内完整提供，也无法在授予后继续声称插件受到细粒度权限强制。

直接放宽 v2 会使现有 AI/用户动态插件自动获得本机任意代码执行能力，并破坏 ADR-0002 和 ADR-0004 已建立的安全保证。因此，完整本机能力必须进入独立、明确标识的信任通道。

## 决策

KnowBook 新增独立的 `Full Trust / System Plugin v3` 通道，同时保留现有 v2 动态插件模型：

1. v2 插件继续运行在无 Node 的 QuickJS/WASM 隔离运行时中，通过 Capability Broker 和沙箱 UI 使用受控能力；ADR-0002 与 ADR-0004 的边界保持不变。
2. Full Trust 插件可以使用文件系统、用户目录、Store、原始 SQLite、Node.js、Electron、`process`、`require`、shell、子进程、环境变量、API Key、网络、任意 npm 包、任意 AI 请求、完整文档和数据库操作、剪贴板、外部程序、窗口/菜单/托盘、应用设置、宿主 React/DOM/CSS、可联网及弹窗的无沙箱界面，以及应用生命周期或独立常驻的后台服务。
3. Full Trust manifest 中的风险声明用于安装前告知、版本比较和审计，不构成可强制的运行时安全边界。获得 Full Trust 后，插件可以绕过宿主 SDK 和权限包装。
4. 安装和启用必须绑定精确的插件 ID、版本和 artifact 内容哈希。artifact、哈希或风险声明发生变化时，必须重新确认。
5. AI 可以生成插件工程、准备 artifact 和发起安装请求，但不能代表用户确认、执行静默安装、启用插件或授予 Full Trust。
6. Full Trust 使用独立的安装、运行、审计、故障恢复和插件中心入口，不复用 v2 Grant Set 来暗示不存在的强制隔离。
7. Full Trust 运行时必须提供安全模式和启动崩溃保护；这些机制用于恢复可用性，不能阻止已运行插件读取、修改或泄露数据。

完整接口、安装流程、实施阶段和验收标准见 [Full Trust 系统插件实施计划](<../Full Trust 系统插件实施计划.md>)。

## 实施验收

2026-09-12 补充：按用户要求，主题切换作为应用内置 v3 插件随包提供并默认启用。内置信任来自宿主编译时的封闭代码目录，不来自插件 manifest、外部目录或 AI 安装请求；注册使用 system 审计，不伪造用户确认。执行前仍校验应用提供的精确内容哈希，不能回退到同 ID 的外部代码；保留停用、安全模式和崩溃保护。内置版本跟随应用更新，不提供独立卸载、回滚或覆盖入口。上述外部 Full Trust 插件的精确确认要求继续有效。

阶段 0–5 已实现，并在本次确认的 Windows 范围内完成验收：同一受控插件十二项能力、依赖与原生重编译、宿主 ABI 升级/回退、启动与数据库恢复、Main/Renderer/后台服务、插件中心和独立 NSIS/更新器闭环均已有证据。673 项完整测试、18 项安全测试、类型/示例检查、构建和打包 smoke 通过；83 项桌面用例取得通过结果，其中两项启动时序问题在修复后定向复验通过。详细结果及证据归档见实施计划第 19.4 节；作者入口见 [开发指南](../system-plugin-v3-development.md)。

按用户 2026-09-07 的要求，macOS/Linux 实测不列为本轮或发布阻塞项。按用户 2026-09-10 的要求，真实 Windows 登录和系统重启暂不执行，由用户后续手测，不阻塞本次目标完成；它们仍记录为未执行，步骤见 [会话验收说明](../system-plugin-windows-session-acceptance.md)。本次状态更新依据已完成的实现、自动化证据和明确调整后的验收范围，不以 Run 命令重放代替真实会话验收。

## 后果

正面后果：

- 系统级插件可以使用完整的 Node、Electron、npm、数据库、Renderer 和操作系统生态。
- v2 的默认安全边界和既有插件兼容性不受影响。
- 产品能够准确区分“受控能力授权”和“用户明确接受任意本机代码执行风险”。

负面后果：

- Full Trust 插件可以泄露数据、损坏数据库、执行任意程序、持久驻留或导致 Electron 主进程崩溃。
- 细粒度权限、审计日志和生命周期清理无法成为恶意 Full Trust 代码的可靠安全边界。
- 安装、升级、原生模块构建、跨平台兼容和故障恢复需要独立维护。

## 实施约束

- 在完整实施和自动化验收前，本 ADR 保持 `Accepted`，不得标记为 `Implemented`。
- Full Trust 能力只能进入 System Plugin v3，不得以隐藏开关、额外标准模块或新增 v2 capability 的方式绕过用户强确认。
- Legacy v1 的兼容行为不因本决策获得 Full Trust 声明，也不得作为 v3 的替代安装通道。
- 任何安装界面必须明确提示插件可读取密钥和任意文件、修改数据库、联网并运行任意程序。
