# Plugin Platform v2 ADR 实现审计

- 审计日期：2026-08-29
- 范围：ADR-0001 至 ADR-0005
- 结论：全部验收条款已实现，ADR 状态为 `Implemented`

## 验收矩阵

| ADR | 已实现的关键边界 | 主要自动化证据 |
| --- | --- | --- |
| 0001 信任与依赖 | 分层信任、自包含 revision、审核标准模块、市场签名/哈希/SBOM/扫描、系统插件强确认、Legacy 标识 | revision、marketplace、repository、PluginHost 测试 |
| 0002 运行时隔离 | QuickJS/WASM 无 Node realm、独立 utility process、capability broker、配额/取消/审计、事件背压、quarantine、退出确认 | QuickJS realm、broker、isolation、安全矩阵、utility-process 生命周期测试与两级 runtime smoke |
| 0003 版本与热更新 | 不可变对象、definition/revision/run/grant/state/log、staging、epoch 原子切换、drain、迁移快照、回滚、崩溃恢复、GC | revision、kernel、coordinator 故障注入、repository、restore 与提交后 UI 自动回滚集成测试 |
| 0004 UI 隔离 | ViewSpec v1、11 个 slot、预算/无障碍、opaque 自定义协议 iframe/CSP、受限 MessagePort、隐藏 frame ready 握手、失败不提交、提交后自动恢复 | main/renderer UI、frame protocol、activation coordinator、真实 Electron 导航/弹窗隔离 E2E |
| 0005 助手事件 | append-only 强类型事件、投影/回放、流式 adapter、多 step agent、工具 guard、精确审批与拒绝防重放、inbox、插件闭环、恢复、事件化自动摘要 | assistant session/agent/tool/plugin-authoring、renderer conversation、Activity Pulse v2 测试 |

## 发布路径验证

本地和 CI 使用以下分层验证：

```text
npm run typecheck
npm test
npm run build
npm run test:runtime-smoke
npm run pack
npm run test:packaged-runtime-smoke
```

`.github/workflows/ci.yml` 在 Windows、macOS、Linux 上执行插件安全测试、未打包构建和打包态 QuickJS 探针。打包态探针会启动隔离用户目录中的真实应用，激活内置 v2 插件，并以结果文件和退出码确认主入口、标准模块加载、utility process 与 QuickJS/WASM 均可工作。

2026-08-29 最终复核结果：

- `npm run typecheck`、`npm run build` 通过。
- `npm test`：435/435 通过。
- Electron E2E：79/79 场景逐项通过；构建入口检查已改为 `out/main/index.cjs`，不再因错误检查 `.js` 而静默跳过。
- 未打包 QuickJS utility-process smoke 通过。
- Windows unpacked 打包态 smoke 通过，应用在插件激活后正常退出；runtime disposal 会等待 utility process 的 `exit` 确认，避免 Electron/V8 退出竞态。
- 本机 Windows 未启用创建符号链接权限，因此本轮 unpacked 验证跳过了可执行文件资源编辑/签名；应用内容、asar、主入口与 runtime 均按生产配置构建。CI 仍执行完整 `npm run pack`。

## 兼容边界

`plugins/` 下的 v1 插件宿主仍作为迁移期兼容层保留，并在 UI 中标记为 `Legacy v1`。它不获得 v2 的安全声明，也不是 AI 新建插件的目标。Activity Pulse v2 和自动摘要自动化已经通过 v2 runtime/capability/event/UI 路径运行。
