# ADR-0001：插件信任分层与依赖策略

- 状态：Implemented
- 实现日期：2026-08-28
- 日期：2026-08-25
- 决策范围：Plugin Platform v2

## 背景

KnowBook 希望把插件作为一级能力：用户可以在 AI 对话中生成插件，实时改变文档、数据库、AI 工作流和界面。同时，插件生态需要继续使用 npm 中成熟的纯 JavaScript/TypeScript 库。

如果允许 AI 在运行中的 KnowBook 内任意执行 `npm install`，安装过程可能执行生命周期脚本、编译原生模块、修改依赖树并下载随时间变化的代码。这会让一次对话直接变成未受控的供应链代码执行，也破坏插件版本的可复现性和热更新回滚。

完全禁止 npm 生态则会迫使插件重复实现常见能力，限制插件质量和发展速度。因此需要区分“使用 npm 依赖”和“在用户机器的实时运行路径中安装 npm 依赖”。

## 决策

KnowBook 采用分层信任模型，并只禁止 AI/动态插件在运行时自行安装依赖；不禁止开发、构建和受控发布阶段使用 npm。

### 信任层

#### 内置可信插件

- 随 KnowBook 构建、签名和发布。
- 可以实现或替换核心服务，并在同进程 renderer 中注册 React 组件。
- 可以使用仓库依赖，但仍通过统一插件生命周期注册，以确保功能可启停、可观测。
- 其信任来源是 KnowBook 发布流程，而不是运行时用户批准。

#### 用户/AI 动态插件

- 运行在 ADR-0002 定义的无 Node 隔离运行时中。
- 默认只能调用显式授予的 KnowBook capability。
- 不允许运行 `npm`、包管理器、shell、生命周期脚本或原生模块安装程序。
- 可以使用自包含 bundle、KnowBook Plugin SDK 和审核过的共享标准模块。
- 每个新 revision 的代码、权限与内容哈希都进入审批和审计。

#### 市场插件

- 安装经过签名、哈希校验、manifest 校验和安全扫描的构建产物。
- 纯 JS 插件沿用动态插件运行时和权限模型。
- 安装器不得默认执行包内生命周期脚本。
- 发布包必须包含确定的构建产物、依赖锁定信息与软件物料清单（SBOM）。

#### 高级系统插件

- 仅用于确实依赖 native module、操作系统能力或独立本地服务的场景。
- 使用单独的显式安装通道，展示系统权限并要求更强确认。
- 不属于 AI 对话内的即时热加载路径，通常允许要求应用重启。
- AI 可以生成工程或建议安装，但不能静默安装、启用或授予系统权限。

#### Legacy v1 插件

- 迁移期继续由现有 `PluginHost` 兼容运行。
- UI 必须标记其为 Legacy，不能宣称具有 v2 的强隔离保证。
- AI 不得生成新的 v1 插件，也不得自动把动态插件降级到 v1 运行。

### 依赖获取规则

1. 普通插件开发者可以在开发环境中正常使用 npm。
2. 发布前必须使用 Vite、Rollup、esbuild 或等价工具，把允许的纯 JS 依赖打进插件产物。
3. 插件安装的是不可变构建产物，不在用户机器上重新解析任意依赖树。
4. `@knowbook/plugin-sdk` 作为版本化宿主接口，可以声明为 host-provided dependency。
5. React、主题 token、Markdown 渲染等宿主能力优先以稳定 capability 提供，而不是向插件暴露宿主模块对象。
6. KnowBook 可以维护 `@knowbook/std/*` 审核模块目录，供 AI 动态插件按 manifest 版本声明使用。
7. 原生依赖只能进入高级系统插件通道。

### AI 动态插件的允许产物

AI 创建的 revision 必须是自包含、可哈希、可静态检查的文件集合，例如：

```text
plugin.json
worker.js
views.json
assets/
```

AI 可以选择已审核模块，但不能请求运行时下载新的第三方包。若需求超出审核模块能力，助手应生成普通插件工程或提出新增标准 capability，而不是绕过安装策略。

## 被否决的方案

### 允许 AI 直接执行 npm install

否决原因：生命周期脚本、依赖混淆、原生代码、网络变化和不可复现构建使其无法进入默认热加载信任边界。

### 完全禁止 npm 依赖

否决原因：会显著限制插件生态；纯 JS 依赖可以在构建时打包，并不要求运行时安装。

### 直接把宿主 node_modules 暴露给插件

否决原因：插件将依赖 KnowBook 内部实现细节，宿主升级会造成隐式破坏，也扩大可访问能力。

## 后果

正面后果：

- AI 插件生成与启用保持确定性、可审计和可回滚。
- 普通开发者仍能利用 npm 生态。
- 原生和系统能力有明确但更高信任的出口。
- KnowBook 可以对共享模块和 capability 做版本兼容管理。

负面后果：

- 插件作者需要增加构建步骤。
- bundle 可能重复包含依赖，增加包体。
- 高级系统插件不能达到与纯 JS 动态插件相同的即时热加载体验。
- KnowBook 需要维护 SDK、标准模块目录和市场扫描流程。

## 实现约束

- Plugin Platform v2 的安装 API 不提供通用 shell 或包管理器执行入口。
- 动态插件 manifest 不接受任意 npm spec；只接受自包含代码或审核模块标识。
- 安装器必须拒绝符号链接、路径逃逸、超限包体和未声明的原生二进制。
- API Key、凭证和用户秘密不得被打包、写入插件日志或作为环境变量传给插件。
- 对依赖策略的放宽必须通过新的 ADR，不得仅靠增加一个隐藏设置实现。

## 实现证据

- `src/main/plugin-platform/revision-package.ts` 与 `revision-store.ts` 实现规范化、自包含 revision、内容哈希、路径/符号链接/包体/原生文件限制和原子对象发布。
- `src/main/plugin-platform/standard-modules.ts` 提供首个版本锁定的 `@knowbook/std/plugin@1.0.0`；动态插件 manifest 只能声明已审核标准模块。
- `src/main/plugin-platform/marketplace-package.ts` 与 `marketplace-installer.ts` 实现发布者签名、artifact 哈希、锁定依赖、SBOM、安全扫描和“安装但不自动启用”。
- `plugin_trust` 持久化与主进程 IPC 实现高级系统插件的独立请求、风险确认和不可静默安装语义。
- v1 `PluginHost` 继续作为兼容层，renderer 在插件管理界面明确显示 `Legacy v1`；AI 工具只创建 v2 revision。
- `tests/main-plugin-platform-revision.test.ts`、`main-plugin-marketplace-package.test.ts`、`main-plugin-platform-repository.test.ts` 和 `main-plugin-host.test.ts` 覆盖上述边界。
