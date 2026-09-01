# KnowBook 架构决策记录

本目录保存会长期约束 KnowBook 实现方式的架构决策。ADR 只记录已经作出的决策；后续如果改变方向，应新增 ADR 取代旧决策，而不是静默改写历史结论。

## 状态定义

- `Proposed`：提案中，尚不能作为实现依据。
- `Accepted`：已接受，新增实现必须遵守。
- `Implemented`：决策已接受，验收标准已落地并有自动化验证；后续改变仍需新 ADR。
- `Superseded`：已被新的 ADR 取代，保留用于说明历史背景。
- `Deprecated`：不再推荐，但尚未被一个完整的新决策替代。

## 决策索引

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [ADR-0001](0001-plugin-trust-and-dependency-policy.md) | 插件信任分层与依赖策略 | Implemented |
| [ADR-0002](0002-plugin-runtime-isolation.md) | AI/用户动态插件使用无 Node 的隔离运行时 | Implemented |
| [ADR-0003](0003-plugin-versioning-and-atomic-hot-reload.md) | 不可变 revision 与原子热更新 | Implemented |
| [ADR-0004](0004-plugin-ui-extension-isolation.md) | 声明式 UI 优先，隔离 iframe 承载高级 UI | Implemented |
| [ADR-0005](0005-assistant-session-event-model.md) | AI 助手采用 append-only 会话事件模型 | Implemented |
| [ADR-0006](0006-workspace-first-dynamic-plugins.md) | 动态插件采用工作区优先、立即激活模型 | Implemented |
| [ADR-0007](0007-full-trust-system-plugins.md) | Full Trust 系统插件使用独立 v3 通道 | Accepted |

## 决策依赖

ADR-0001 是信任和权限基础。ADR-0002 与 ADR-0004 分别落实逻辑代码和界面代码的隔离边界；ADR-0003 在该边界上定义版本、审批和热更新；ADR-0005 记录 AI 如何调用这些能力，并把审批与插件生命周期操作保存为可恢复、可审计的事件；ADR-0006 将动态插件生命周期统一为工作区优先、立即激活模型。

ADR-0001 至 ADR-0006 共同约束 Plugin Platform v2。ADR-0007 在其旁建立独立的 Full Trust / System Plugin v3 通道：它允许用户明确接受完整本机代码执行风险，但不放宽或取代 ADR-0002、ADR-0004 的 v2 隔离边界。现有 v1 插件宿主在迁移期作为兼容层保留，不因这些决策自动获得 v2 或 v3 的安全声明。

逐项实现证据和发布验证入口见 [Plugin Platform v2 ADR 实现审计](IMPLEMENTATION-AUDIT.md)。
