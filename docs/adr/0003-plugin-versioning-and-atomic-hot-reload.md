# ADR-0003：不可变 revision 与原子热更新

- 状态：Implemented
- 实现日期：2026-08-28
- 日期：2026-08-25
- 决策范围：Plugin Platform v2 生命周期与持久化
- 依赖：[ADR-0001](0001-plugin-trust-and-dependency-policy.md)、[ADR-0002](0002-plugin-runtime-isolation.md)

## 背景

用户希望在 AI 实时对话中创建和修改插件，并立即看到 KnowBook 行为发生变化。这要求插件支持高频更新、失败诊断、继续修复、停止和回滚。

现有 v1 `reloadPlugin()` 会先停用当前插件，再从同一目录重新读取 manifest 和入口文件。如果新代码无法启动，旧插件已经退出。目录中的源码也会被覆盖，缺少不可变版本身份，难以将用户批准、日志、故障和运行结果绑定到精确代码。

AI 生成插件尤其需要保留每个版本：模型修复失败不能抹掉上一个可工作的结果，用户也必须在运行前看到准确的代码和权限差异。

## 决策

Plugin Platform v2 使用稳定 Plugin、不可变 Revision 和一次性 Run 三层身份，并通过 staging 与原子注册表切换实现热更新。

### 身份模型

#### Plugin

- 由稳定 `pluginId` 标识。
- 表示用户认知中的一个长期插件，例如“每日回顾”。
- 保存名称、来源、创建会话、持久化范围和生命周期指针。
- 删除 Plugin 才会删除它的所有 revision、grant 和状态。

#### Revision

- 由 `revisionId` 标识，并保存规范化包内容的 SHA-256。
- 包含不可变 manifest、worker 源码、UI 描述、资源索引和生成元数据。
- 创建后不得就地修改；任何修复都产生新 revision。
- 保存所请求权限、API 版本、静态检查结果和前一 revision 关系。

#### Run

- 每次激活尝试都有新的 `runId`。
- 绑定精确 `pluginId + revisionId + scope + grantSetId`。
- 保存启动、审批、健康、停止和失败诊断。
- 同一 revision 的重启也产生新的 runId。

### 关键指针

每个 Plugin 可以保存：

- `currentRevisionId`：最近一次完整成功激活的 revision。
- `pendingRevisionId`：正在审批、staging 或最近失败的目标 revision。
- `activeRunId`：当前真正提供服务的 run；停止时为空。

`currentRevisionId` 只在新 revision 完成全部 Host/UI 激活并原子提交后更新。`pendingRevisionId` 不能被解释为已经生效。

## 定义与运行分离

创建 revision 只做：

- 参数和 manifest 校验。
- 源码规范化与内容哈希。
- 语法和静态 API 检查。
- 保存不可变包。
- 生成代码、权限和贡献点 diff。

定义 revision 不执行插件代码、不写工作区数据，也不隐式申请批准。

运行 revision 才会：

- 解析精确权限请求。
- 获取绑定 revision hash 的用户批准。
- 创建 staging runtime。
- 执行激活、健康和 UI 准备。
- 提交原子切换或返回失败。

## 原子热更新协议

1. 保持旧 run 正常服务。
2. 创建目标 revision 的 staging runtime。
3. staging 使用独立的 `EffectScope` 和临时 contribution namespace。
4. 校验服务依赖、贡献点 ID、命令冲突、UI 描述和 handler readiness。
5. 如果包含 UI，先加载声明式描述或在隔离 frame 中完成预取和 ready handshake。
6. 冻结 staging 的贡献快照，准备新的 revision epoch。
7. 在一个 kernel 临界区内把插件 namespace 从旧 epoch 指向新 epoch。
8. 更新 `currentRevisionId` 和 `activeRunId`。
9. 新请求只路由到新 run；旧 run 进入 draining。
10. 旧 run 在有限时间内完成已开始的调用，然后撤销全部 effect 并终止。

如果第 2–6 步失败，旧 run 完全不变。如果提交后的 UI 最终握手失败，kernel 应撤销新 epoch 并重新指向旧成功 revision，记录自动回滚。

### 迟到消息

所有调用、事件、UI 消息和 capability 结果必须携带 `revisionId + runId + epoch`。Kernel 在路由和提交 effect 前再次确认身份，防止旧进程在更新后继续修改数据或恢复已撤销 UI。

## 状态迁移

插件自己的持久状态不存放在源码目录中，而由 `plugin.storage` capability 管理。

- manifest 可以声明 `stateSchemaVersion`。
- revision 更新可以提供受限 `migrateState(previousVersion, nextVersion)`。
- 迁移在临时事务中执行。
- 只有新 revision 成功提交后才提交状态事务。
- 失败时恢复旧状态，旧 run 继续使用原 schema。
- 不支持自动逆向迁移时，回滚前必须使用迁移快照。

## 作用域

动态插件至少支持两种激活范围：

- `session-preview`：只在创建它的 AI 会话和当前窗口中可见，默认不跨应用重启恢复。
- `workspace`：用户显式选择保存后，在工作区中持久启用并在重启后恢复。

未来可以增加 document scope，但不能把 session 插件默认提升到全局 workspace。

## 持久化

新增存储实体：

- `plugin_definitions`
- `plugin_revisions`
- `plugin_installations`
- `plugin_runs`
- `plugin_grants`
- `plugin_state`
- `plugin_logs`

源码以内容哈希存放于 `userData/plugins-v2/objects/<sha256>/`。数据库保存身份、指针、状态和审计。staging 使用独立临时目录；应用启动时可清理无活动 run 引用的过期 staging。

## 被否决的方案

### 直接覆盖插件目录后 reload

否决原因：无法可靠回滚，也不能把批准和日志绑定到精确源码。

### 先停止旧版本，再验证新版本

否决原因：一次语法或启动错误会让正在工作的功能消失。

### 只保留最近一个 revision

否决原因：AI 迭代需要诊断和回滚历史；也会破坏审计。

### 用语义版本号作为唯一身份

否决原因：版本号可能被重复使用或错误填写；权限和审批必须绑定内容哈希。

## 后果

正面后果：

- 更新失败不会破坏当前可用插件。
- AI 可以连续生成修复版本，并准确引用历史版本。
- 用户批准、运行日志和安全审计可以绑定精确代码。
- session preview 与持久插件共享同一生命周期协议。

负面后果：

- 需要管理源码对象、历史 revision 和清理策略。
- 原子切换与跨 Host/UI readiness 比简单 reload 更复杂。
- 插件状态迁移必须具备事务和快照机制。
- 多 revision 会增加磁盘占用，需要保留策略。

## 验收标准

- 新 revision 启动失败时，旧 run 无中断继续服务。
- 成功更新后不再接受旧 run 发起的新 effect。
- 更新时已开始的调用在 drain 期限内完成或被明确取消。
- 用户可以回滚到任意保留的成功 revision。
- 审批记录能验证 revision 内容哈希和权限集合。
- 应用崩溃后能区分最后成功 revision、未完成 run 和 staging 残留。
- session preview 不会在未保存时变成 workspace 持久插件。

## 实现证据

- `revision-package.ts` 与 `revision-store.ts` 实现规范化 SHA-256 revision、不可变对象目录、独立 staging 和原子 rename；`revision-maintenance.ts` 实现保留与垃圾回收。
- `repository.ts` 持久化 definition、revision、installation、run、grant、state、snapshot 和 log，并在事务中维护 current/pending/active 指针与崩溃恢复状态。
- `kernel.ts` 通过 staging `EffectScope`、namespace/epoch 临界区替换、旧 run drain/取消和 stale owner 拒绝实现原子热更新。
- `activation-coordinator.ts` 在提交前完成 runtime、handler、UI asset、state migration 和 renderer iframe readiness；失败保持旧 epoch，提交后故障可由 `platform-service.ts` 自动恢复仍有效的旧成功 revision。
- session-preview 与 workspace 安装分别持久化；workspace 提升必须单独审批，未保存 preview 不会跨重启恢复。
- `tests/main-plugin-platform-revision.test.ts`、`main-plugin-platform-activation-coordinator.test.ts`、`main-plugin-platform-repository.test.ts` 和 `main-plugin-platform-restore.test.ts` 覆盖哈希、故障注入、迁移、回滚、恢复和清理。
