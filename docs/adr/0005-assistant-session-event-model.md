# ADR-0005：AI 助手采用 append-only 会话事件模型

- 状态：Implemented
- 实现日期：2026-08-28
- 日期：2026-08-25
- 决策范围：AI 助手、工具调用与插件开发闭环
- 关联：[ADR-0001](0001-plugin-trust-and-dependency-policy.md)、[ADR-0003](0003-plugin-versioning-and-atomic-hot-reload.md)

## 背景

当前 AI 助手以一次 IPC 请求完成“用户问题→单个答案”，renderer 只保存当前 prompt、answer 和 loading 状态。自动摘要是主进程中的固定事件订阅。这个模型无法支持：

- 多轮持久会话。
- 流式回答和取消。
- 一轮内多次工具调用。
- 用户审批和恢复等待状态。
- AI 定义、验证、运行、修复和回滚插件。
- 应用崩溃后的会话恢复。
- 完整审计和问题复现。

如果分别持久化 messages、tool calls、approval state 和 UI 卡片状态，很容易产生多份相互矛盾的权威状态。AI 插件开发还必须把一次批准绑定到准确的 revision 和权限集合，因此需要统一的时间顺序事实来源。

## 决策

AI 助手使用 append-only、强类型、可回放的会话事件日志作为唯一权威记录。消息历史、工具轨迹、审批卡片、插件版本卡片和会话状态均从事件投影得到。

### 会话身份

每个会话具有：

- `sessionId`
- 标题与创建时间
- 所属 workspace
- 可选 active document 上下文
- 创建时的模型和能力配置快照
- 单调递增的事件 `seq`

同一 session 同时最多有一个活动 turn。用户后续消息进入 inbox；可以作为下一 turn 输入，也可以按明确规则 steering 当前 turn。

### Turn 与 Step

- Turn 表示一次用户意图从进入到完成、取消、失败或等待外部决定的完整处理。
- Step 表示一次模型请求，以及该请求产生的工具调用和结果。
- 一个 turn 可以有多个 step：模型调用工具后，工具结果进入下一 step，直到没有后续工作。

### 首批事件

```text
session.created
session.title.updated

turn.started
turn.ended
step.started
step.ended

user.message
assistant.chunk
assistant.message

tool.call
tool.result

approval.requested
approval.resolved

plugin.revision.defined
plugin.validation.completed
plugin.run.requested
plugin.run.started
plugin.run.succeeded
plugin.run.failed
plugin.run.stopped
plugin.rollback.completed

session.cancelled
session.error
```

每个事件包含 `sessionId`、`seq`、时间、类型和经过版本化的 JSON payload。需要关联的事件使用品牌化 ID，例如 `turnId`、`stepId`、`toolCallId`、`approvalId` 和 `runId`，避免把不同领域的普通字符串混用。

### 事件表面

事件声明显示属性：

- `conversation`：投影为用户可见会话内容。
- `trajectory`：显示在工具和执行轨迹中。
- `audit-only`：只用于权限、安全和恢复，不直接进入模型上下文。

模型历史不是原始事件全集。`deriveModelMessages()` 只投影明确允许进入模型上下文的事件，并对工具结果、错误、附件和运行时上下文执行裁剪、脱敏和大小限制。

## 模型适配器

AI 核心依赖 `ModelAdapter` seam，不直接绑定一个 HTTP payload。首个适配器支持 OpenAI-compatible chat completions，并规范化：

- 文本流 chunk。
- tool call 增量和完整参数。
- provider 要求随 tool call 重放的受限推理上下文；该上下文只进入持久化模型投影，不进入会话正文。
- usage。
- finish reason。
- provider/model 身份。
- 可取消请求和结构化错误。

适配器必须声明能力，例如 streaming、native tool calling、JSON schema 和多模态支持。如果模型不能可靠调用工具，助手仍可进行普通问答，但默认不启用自动插件开发工具。

API Key 只由模型适配器和凭证服务读取。会话事件、工具、插件和 renderer 均不能获得明文 Key。

## 工具注册与执行

工具通过统一 registry 注册，并具有：

- 稳定名称与版本化参数 schema。
- 输出 schema 和用户展示元数据。
- 所属插件和可见 scope。
- 并发安全声明。
- 所需 capability 和审批策略。
- 超时、取消和结果体积限制。

执行顺序固定为：

```text
解析并冻结参数
→ schema 校验
→ scope 与工具可见性校验
→ 单调权限 guard
→ 用户审批
→ 执行与取消
→ 输出 schema 校验
→ 裁剪、脱敏和展示格式化
→ 追加 tool.result
```

后置扩展不得把已经被 guard 拒绝的调用重新允许。审批不可用、已取消、已拒绝或身份不匹配时一律拒绝执行。

### 首批内置工具

- `knowbook.inspect_capabilities`
- `knowbook.inspect_ui_slots`
- `workspace.search`
- `documents.list/get/create/update`
- `plugins.list/inspect`
- `plugins.define_revision`
- `plugins.validate_revision`
- `plugins.preview_revision`
- `plugins.activate_revision`
- `plugins.stop`
- `plugins.rollback`
- `plugins.read_diagnostics`

AI 写插件前必须查询实时 capability、事件、ViewSpec 和 slot catalog，不能依靠提示词中的过期 API 清单猜测接口。

## 审批

审批是独立的安全事件，不是普通确认文案。`approval.requested` 必须记录：

- 精确 tool call。
- Plugin 和 revision hash。
- 权限集合与 scope。
- 操作摘要和风险分类。
- 审批过期条件。

`approval.resolved` 使用封闭结果：

- `allowed-once`
- `rejected`
- `cancelled`
- `unavailable`

AI 生成 revision 默认只接受绑定内容哈希的单次批准。对签名市场插件是否允许信任发布者，应由后续 ADR 决定，不能复用 AI revision 的批准。

等待审批时，agent loop 不占用模型请求或轮询。决定到达后，由事件和 inbox 唤醒后续处理。用户拒绝后，助手不得通过生成等价调用规避决定。

## 插件开发闭环

标准流程是：

```text
inspect
→ define immutable revision
→ validate
→ show code/permission/contribution diff
→ request approval
→ stage and activate
→ observe result
→ repair with a new revision or finish
```

定义 revision 不执行代码。`activate_revision` 返回 awaiting approval 或 starting 时，当前 step 应结束，后续成功、失败和 UI readiness 通过事件唤醒，而不是在一次工具调用里无限等待。

## 持久化与恢复

新增：

- `assistant_sessions`
- `assistant_events`

事件以 `(session_id, seq)` 唯一，并在事务中追加。流式 `assistant.chunk` 可以批量落盘，但最终 `assistant.message` 必须成为本 step 的提交事实。

恢复时：

- 从事件日志重建会话投影和模型历史。
- 未关闭 turn 标记为 interrupted，不伪装为 completed。
- 未完成 tool call 不自动重放有副作用的执行。
- 未完成 approval 标记为 cancelled/unavailable，用户可以重新发起。
- 插件实际运行状态以 Plugin Kernel 为准，再向会话追加恢复/诊断事件。

## 上下文和检索

不再默认把大量文档内容拼入每次 prompt。

- 当前文档摘要作为明确上下文贡献。
- 相关笔记通过 `workspace.search` 工具按需获取。
- 插件可以注册受 scope 限制的 context provider。
- 来自文档、网页和插件的数据标记为不可信内容，不能解释为权限指令。
- 每次模型请求记录 provider、model、可见工具集合和运行时策略摘要，便于复现。

## UI 投影

全局 AI 面板订阅会话事件，投影出：

- 用户和助手消息。
- 流式文本。
- 工具执行轨迹。
- 审批卡片。
- 插件 revision、diff、验证、运行、停止和回滚卡片。
- 可恢复错误和诊断。

Renderer 不是会话状态的权威来源。窗口刷新或重新打开后，UI 从 session snapshot 加增量事件恢复。

## 被否决的方案

### 继续使用单次 ask API

否决原因：无法表示工具循环、审批等待、流式事件和插件生命周期。

### 单独保存 messages 和 tool state

否决原因：会产生多个权威来源，崩溃恢复时难以确定真实顺序。

### 把所有事件原样发送给模型

否决原因：审计信息、内部错误和大体积流式数据不应自动进入模型上下文。

### 用自然语言要求模型自行遵守权限

否决原因：权限必须由工具管线和 capability broker 强制。

## 后果

正面后果：

- 会话、工具、审批和插件操作具有统一的时间顺序与审计。
- 可以可靠恢复、回放和定位失败。
- AI 助手、插件和 UI 通过稳定事件/工具 seam 解耦。
- 后续可增加会话分支、压缩、后台任务和多模型适配器。

负面后果：

- 需要实现事件存储、投影、压缩和 schema 迁移。
- 流式事件会增加写入量，需要批处理和保留策略。
- Agent loop、工具管线和 UI 比当前单次请求复杂。
- 每个模型适配器必须处理工具调用兼容性差异。

## 验收标准

- 多 step turn 的消息、工具调用和结果顺序可稳定回放。
- 关闭并重新打开应用后，会话文本和插件卡片一致恢复。
- 取消模型请求或工具调用后不会继续产生未授权 effect。
- 审批与精确 tool call、revision hash 和权限集合绑定。
- provider 不支持工具调用时，插件开发能力明确禁用而不是静默降级。
- 未关闭 turn 在崩溃恢复后显示 interrupted。
- 会话事件中不出现明文 API Key 或插件私密凭证。
- Renderer 丢失本地 React 状态后仍可从事件重建完整界面。

## 实现证据

- `src/shared/assistant-session.ts` 定义品牌化 ID 与事件 discriminated union；`session-repository.ts` 以 `(session_id, seq)` 事务追加并实现 session/turn/step/approval 的恢复约束。
- `projection.ts` 分别投影会话、轨迹和模型上下文，裁剪 chunk/工具数据并排除 audit-only 事实；renderer 的 `AssistantConversation.tsx` 完全从事件重建消息、审批、工具和插件卡片。
- `model-adapter.ts` 实现 OpenAI-compatible SSE 文本、增量 tool call、usage、取消和结构化错误，并显式声明 provider 能力；兼容流中的 `tool_calls: null` 以及增量 `function`/`name`/`arguments` 的显式 `null`，保留 MiMo 等 provider 要求的 `reasoning_content`，回放工具调用时保持空 `content` 字段而不改写为 `null`，并依赖协议默认的自动工具选择以避免向不支持 `tool_choice` 的兼容端点发送该字段。
- `tool-registry.ts` 与 `agent-service.ts` 实现封闭 schema、scope/capability/单调 guard、审批、超时、取消、并发、结果限制、多 step loop、inbox steering/next-turn 和启动恢复。
- `plugin-authoring-service.ts` 实现 inspect→define→validate→diff→approval→activate/rollback/stop/diagnostics 的完整闭环；审批绑定精确 tool call、revision hash、权限和 scope。同一 turn 中被拒绝的等价 activation（即使更换 toolCallId 或改写摘要）会按语义目标指纹阻断，必须由新的用户 turn 重新发起。
- 自动摘要的事件触发已迁入 `builtin-activity-pulse.ts`；主进程只通过 `ai.automation.summarize-document` capability 保留凭证、并发去重和 source-version 提交保护。
- `tests/main-assistant-*.test.ts`、`renderer-assistant-conversation.test.ts`、`main-plugin-builtin-activity-pulse.test.ts` 和 IPC 契约测试覆盖回放、恢复、审批、取消、provider 降级、插件闭环与 UI 重建；主题插件端到端用例以九次 MiMo 风格 SSE 补全覆盖 capability/module/slot/plugin inspect、revision 创建/校验/预览、审批、QuickJS 激活、handler 调用和深浅色持久化。
