# ADR-0008：移除 v1 插件系统，原生扩展迁移到 v3

- 状态：Implemented
- 日期：2026-09-12
- 取代：ADR-0001、ADR-0002、ADR-0007 中保留 v1 兼容宿主的条款
- 保留：Plugin Platform v2 的隔离运行和 System Plugin v3 的完整信任确认

## 决策

1. 删除 v1 PluginHost、VM/utility-process 运行时、SDK、manifest 校验、专属版本兼容工具和旧安装逻辑，不保留包装或回退执行路径。
2. 删除 v1 Preload/IPC 管理接口、旧插件目录扫描、首页清单字段、设置面板、重扫与重载入口，以及专用整库快照接口。
3. 仓库 `plugins/activity-pulse/` 改为显式 v3 manifest 和 Main/Renderer 入口，保留事件卡片、从首个非空块生成摘要、持久化摘要前缀。Main 与 Renderer 通过绑定精确插件 revision 的 v3 消息接口通信，资源随插件停用清理。
4. v3 安装继续绑定精确 artifact 并要求用户确认，重启后激活。旧代码不自动安装或授予 Full Trust；自定义 v1 插件需要改写为 v3。
5. 不删除用户旧插件源文件、历史设置或事件。历史来源枚举与事件类型仅用于读取记录，不提供 v1 加载能力。Activity Pulse 在用户确认安装 v3 后可读取自身的旧摘要前缀并转存新设置。
6. v2 动态插件、不可变 revision、能力代理、UI 沙箱与工作区生命周期保持独立；ViewSpec、服务 RPC 或市场包自身的协议版本 1 不代表 v1 插件系统。

## 验收

- 生产源码及打包入口不存在 v1 宿主、运行时、SDK、安装和执行路径。
- 旧目录中的插件不会被扫描执行，旧 manifest 不能通过 v3 安装校验。
- Activity Pulse 通过真实 v3 安装、确认、启动、UI 交互、设置保存和停用清理验证。
- 类型检查、单元/集成测试、构建和受影响的 Electron E2E 通过。

历史 ADR 的原始验收记录保留；其中关于继续保留 v1 的描述以本决策为准。

## 实施验证（2026-09-12）

- `npm run typecheck`、`npm run typecheck:system-plugin-examples` 通过。
- `npm run test`：636 项全部通过，无跳过。Windows 进程身份检查在允许本机进程查询的环境中执行。
- `npm run build` 通过，Renderer 包体检查通过；生成的 Main/Preload 不含旧 PluginHost、ElectronPluginRuntime 或 v1 utility-process 入口。
- `tests/project-structure-validation.test.ts` 验证旧源码和管理 API 不存在，Activity Pulse manifest 为 v3。
- 新的 bridge、services、Renderer registry 与 Activity Pulse 测试覆盖真实 Store 写入、事件归属、旧设置转存、重启持久化、精确 revision、停用与未完成请求清理。
- Electron 相关 6 项用例均取得通过结果：`plugins.spec.ts` 的 v2 保留、旧目录/旧 API/旧 manifest 拒绝、Activity Pulse 完整迁移；`plugin-ui-security.spec.ts` 的 v2 UI 隔离；`system-plugins.spec.ts` 的精确确认/重启与升级/回退/卸载。
- Electron 首轮两个失败分别为 Activity Pulse 测试未切换实际页面，以及沙箱拒绝 npm 缓存写入。修正测试导航并增加停用后真实 IPC 拒绝断言后，Activity Pulse 定向复验通过；依赖安装用例在允许 npm 缓存写入的环境中定向复验通过。
