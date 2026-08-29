# ADR-0002：AI/用户动态插件使用无 Node 的隔离运行时

- 状态：Implemented
- 实现日期：2026-08-28
- 日期：2026-08-25
- 决策范围：Plugin Platform v2 动态逻辑代码
- 依赖：[ADR-0001](0001-plugin-trust-and-dependency-policy.md)

## 背景

现有插件在 Electron `utilityProcess` 中运行，并由 `node:vm` 创建不同的 JavaScript context。该设计能把插件崩溃、同步死循环和内存占用从主进程移开，也能通过结构化消息限制正常 API 使用。

但 `utilityProcess` 仍是带 Node 能力的进程，`node:vm` 官方明确不是不可信代码的安全机制。仅隐藏 `require`、`process` 或限制全局对象，不能证明 AI 生成代码无法逃逸并获得文件系统、环境变量或网络能力。

由于用户可能让 AI 读取不可信文档、网页或剪藏内容，动态插件生成还存在间接提示注入风险。运行时必须假定待执行源码是不可信的，权限约束必须由宿主强制，而不是依赖系统提示或插件自律。

## 决策

Plugin Platform v2 的用户/AI 动态逻辑代码不得在具有 Node API 的 JavaScript realm 中直接执行。默认采用无 Node 的可终止隔离引擎，并只通过结构化 capability broker 与 KnowBook 交互。

首选实现方向是 QuickJS/WASM 或具备等价属性的嵌入式运行时。正式选型前必须用原型验证以下硬性要求：

- 运行时中不存在 `process`、`require`、Node builtin、Electron 和宿主函数构造器。
- 可以设置每个插件的内存上限、同步执行预算和墙钟超时。
- 宿主可以无条件终止失控运行实例。
- 宿主和插件之间只传递经过验证的 plain JSON 或受控二进制对象。
- 插件无法直接获得宿主对象引用、函数原型链或数据库连接。
- 在 Windows、macOS 和 Linux 的 Electron 打包产物中可以稳定运行。

如果 QuickJS/WASM 原型不能满足这些要求，应选择另一种无 Node 隔离引擎；不得退回到把 `node:vm` 描述为安全沙箱。

## 运行时结构

每个运行实例具有：

- `pluginId`：稳定插件身份。
- `revisionId`：精确不可变源码版本。
- `runId`：本次激活身份。
- `scope`：session、workspace 或其他明确作用域。
- `grantSetId`：本次调用所依据的权限快照。

基础协议包括：

```text
initialize
activate
event
invoke-handler
capability-call
capability-result
health
dispose
```

所有消息必须携带运行身份。宿主拒绝来自旧 `runId`、已撤销 grant 或已停止 revision 的迟到消息。

## Capability Broker

动态插件不接触真实 Store、SQLite、文件系统、AI Key 或 Electron API。它只能调用经过版本化的 capability，例如：

- `documents.query/read/create/update/delete`
- `databases.query/update`
- `workspace.events.subscribe`
- `plugin.storage.read/write`
- `network.fetch`
- `ai.complete`
- `ui.notify`
- `external.open`
- `clipboard.write`

Broker 对每次调用执行：

```text
身份校验
→ schema 校验
→ scope 校验
→ grant 校验
→ 配额与取消校验
→ 业务调用
→ 结果裁剪与脱敏
→ 审计
```

权限不能由插件自己扩张。插件 manifest 只是权限请求，实际 grant 由用户批准记录决定。

## 数据最小化

停止现有“激活时向每个插件发送完整工作区文档快照”的模式。

- 激活只发送 manifest、插件自有设置、grant 摘要和必要运行上下文。
- 事件使用最小 payload，并携带 `originPluginId`、`correlationId` 和 `causationId`。
- 插件需要正文时通过 `documents.read` 按需查询。
- 查询结果按 scope、字段和数量限制裁剪。
- 事件队列有长度上限和背压策略；持续超限的插件进入 quarantine。

## 资源与故障边界

每个插件必须配置：

- 最大内存。
- 单次 handler CPU/指令预算。
- 单次 capability 调用墙钟超时。
- 最大并发调用数。
- 最大事件队列长度。
- 最大结果与日志体积。
- 速率和 AI token 配额。

超限、崩溃或协议违规只停止当前 run，不影响主进程或其他插件。重复违规会把插件标记为 quarantined，必须由用户显式恢复。

插件停止时应先拒绝新调用、取消可取消任务、等待有限 drain 时间，再强制终止运行实例。

## 被否决的方案

### 继续强化 node:vm

否决原因：可以改善 API 形状和正常错误隔离，但不能建立不可信代码安全边界。

### 只依赖 utilityProcess

否决原因：utility process 仍具有 Node 环境；独立进程本身不等于最小权限。

### 每个插件使用普通 Node 子进程并清空环境变量

否决原因：清空环境变量不能阻止文件、网络、进程和系统 API 访问。

### 仅使用系统提示约束 AI

否决原因：提示是行为引导，不是权限强制；无法抵抗错误生成或间接提示注入。

## 后果

正面后果：

- 权限模型可以由宿主实际强制。
- AI 生成代码不会天然获得用户进程权限。
- 热停止、资源配额和故障隔离具有可验证语义。
- 插件不再接收与自身能力无关的完整工作区数据。

负面后果：

- 不能直接运行任意现有 Node 插件代码。
- 异步 broker 和序列化增加实现复杂度与少量延迟。
- 需要维护隔离引擎的跨平台构建与安全更新。
- 部分 npm 库需要 bundle、polyfill 或标准能力替代。

## 迁移

- v1 插件继续使用现有运行时，但标记 Legacy。
- 新 AI 插件只能创建 v2 revision。
- 先迁移现有 `activity-pulse`，验证设置、事件、卡片和文档动作的 capability 等价实现。
- 在安全运行时稳定前，不开放 AI 自动激活带写权限的动态插件。

## 验收标准

- 恶意测试插件不能读取环境变量、任意文件或启动进程。
- 插件不能绕过 broker 访问未授权文档或数据库。
- 死循环和内存超限能被宿主终止，主应用保持可用。
- 旧 `runId` 的消息和撤销后的 grant 均被拒绝。
- 所有跨边界输入输出均有 schema、大小和深度限制。
- 安全测试覆盖 Windows、macOS 和 Linux 打包运行时。

## 实现证据

- `src/main/plugin-platform/quickjs-realm.ts` 使用 QuickJS/WASM 执行不可信源码；插件 realm 不暴露 Node、Electron、网络、宿主对象或 `WebAssembly`。
- `quickjs-runtime-process.ts`、`quickjs-runtime-client.ts` 和 `quickjs-runtime-protocol.ts` 实现独立 utility process、严格身份协议、健康检查、可终止运行、消息大小/深度限制和 fatal 故障上报。
- `quickjs-runtime-client.ts` 的销毁流程为幂等 single-flight；发送 dispose、终止 utility process 后必须等待 Electron 的 `exit` 确认才允许主进程退出，避免打包态 Electron/V8 退出竞态。
- `capability-broker.ts` 对每次调用执行 schema、scope、grant、epoch、并发、速率、token、超时、取消、结果裁剪与审计校验；`platform-service.ts` 实现有界事件队列、背压、违规计数和 quarantine/recover。
- `core-capabilities.ts` 只向已授权 owner 提供最小数据能力；API Key 从不进入插件包、事件或 utility-process 环境。
- `builtin-activity-pulse.ts` 是通过 capability、事件、设置、ViewSpec 和文档动作运行的 v2 迁移参考插件。
- `.github/workflows/ci.yml` 在 Windows、macOS、Linux 上执行隔离安全测试、构建未打包应用并运行打包态 runtime probe；`scripts/quickjs-runtime-smoke.mjs` 和 `packaged-runtime-smoke.mjs` 验证真实 Electron utility process。
- `tests/main-plugin-platform-quickjs-realm.test.ts`、`main-plugin-platform-capability-broker.test.ts`、`main-plugin-isolation.test.ts`、`main-plugin-platform-quickjs-runtime-client.test.ts` 和两级 runtime smoke 覆盖验收标准、退出等待、有界超时和真实打包应用的正常关闭。
