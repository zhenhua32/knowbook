# ADR-0004：声明式 UI 优先，隔离 iframe 承载高级 UI

- 状态：Accepted
- 日期：2026-08-25
- 决策范围：Plugin Platform v2 renderer 扩展
- 依赖：[ADR-0001](0001-plugin-trust-and-dependency-policy.md)、[ADR-0002](0002-plugin-runtime-isolation.md)、[ADR-0003](0003-plugin-versioning-and-atomic-hot-reload.md)

## 背景

要让插件成为一级能力，插件需要扩展导航、独立页面、仪表盘、文档编辑器、数据库视图、设置和 AI 对话界面。现有插件只能贡献固定文本卡片、文档动作和简单设置，无法覆盖这些需求。

让 AI 生成的 JavaScript 直接在 KnowBook renderer 中运行，会获得页面 DOM、React 对象、preload 暴露的 API 和当前页面数据，也可能破坏应用布局或绕过主进程权限设计。React 组件的动态 import 适合随应用签名发布的可信代码，不适合作为不可信插件边界。

完全使用静态表单配置又会限制高级可视化和交互。因此需要安全默认路径与高级隔离路径并存。

## 决策

动态插件 UI 采用双层模型：默认使用声明式 `ViewSpec`，需要自由交互时使用 sandboxed iframe。只有内置可信插件可以在同进程 renderer 中注册 React 组件。

### 声明式 ViewSpec

ViewSpec 是经过版本化、严格 schema 校验的 JSON UI 描述。首批组件建议包括：

- 布局：stack、row、grid、divider、scroll。
- 内容：text、markdown、badge、icon、image、empty-state。
- 输入：button、text-field、textarea、checkbox、select、date。
- 数据：list、table、stat、progress、simple-chart。
- 状态：loading、error、confirmation。

ViewSpec 不能包含 JavaScript 表达式、任意 HTML、内联事件代码或全局 CSS。事件只能引用 worker 已注册的 handler：

```json
{
  "type": "button",
  "label": "生成今日回顾",
  "action": {
    "handler": "generate-review",
    "arguments": { "scope": "today" }
  }
}
```

Renderer 把 action 发送给 Plugin Kernel，由 Kernel 校验 `pluginId + revisionId + runId + epoch` 后调用对应 handler。

### 高级 iframe UI

确实需要画布、复杂图表或自定义交互的动态插件可以声明高级 UI entrypoint，并运行在：

- `sandbox` iframe。
- 无 `allow-same-origin`、无 Node、无 preload。
- 独立、非持久 origin。
- 严格 Content Security Policy，默认禁止外部脚本和网络。
- 不可访问父页面 DOM、localStorage、IndexedDB、service worker 和 Electron API。
- 只通过一次性 MessagePort 与受控 UI broker 通信。

iframe 请求网络、数据、剪贴板或外部跳转时仍必须通过 capability broker，而不能直接获得更宽浏览器权限。

### 内置可信 React 插件

随应用签名发布的内置插件可以注册 React 组件和完整页面。它们使用静态或构建期可分析的 dynamic import，不与 AI 动态插件共享执行通道。

## 扩展槽

UI 只能挂载到稳定、版本化的扩展槽。首批槽位包括：

- `navigation.primary`
- `workspace.dashboard`
- `documents.header.actions`
- `documents.editor.toolbar`
- `documents.block.context-menu`
- `documents.aux-panel`
- `database.view.tabs`
- `database.record.actions`
- `settings.sections`
- `assistant.tools`
- `assistant.message.cards`

每个槽位定义：

- 可接受的贡献类型。
- props 的公开 JSON schema。
- 排序与冲突规则。
- 可见 scope。
- 最大数量和渲染预算。
- 空间、主题和无障碍要求。

插件不能依赖未公开的 React props、CSS class、DOM 结构或组件内部状态。

## 样式和主题

- ViewSpec 使用 KnowBook 主题 token，不允许任意全局 CSS。
- iframe CSS 只作用于自己的文档。
- 插件资源通过受控 scheme 加载，并校验路径、MIME 和 revision 身份。
- 禁止通过 CSS、SVG、URL 或 Markdown 注入脚本。
- 所有可交互元素必须满足键盘操作和基础无障碍要求。

## 热更新

UI 热更新遵循 ADR-0003：

1. ViewSpec 在 staging registry 中完成 schema 和 handler 引用校验。
2. iframe UI 先创建不可见 frame，完成模块载入、guard 和 ready handshake。
3. 新 UI ready 后，renderer 对插件 namespace 进行一次 epoch 切换。
4. 旧 ViewSpec/iframe 停止接收新事件并被销毁。
5. stale frame 的消息因 runId/epoch 不匹配而被拒绝。
6. 新 UI 启动或渲染失败时保留或恢复旧 revision。

默认不承诺保留插件内部临时 React/DOM 状态。需要跨 revision 保留的状态必须写入 `plugin.storage`，由新 revision 显式读取。

## 被否决的方案

### AI 生成代码直接 dynamic import 到主 renderer

否决原因：与应用共享 DOM、React、preload 和页面数据，无法形成权限边界。

### 使用 webview 标签

否决原因：能力面更宽、配置复杂且不需要其完整浏览器嵌入能力；sandboxed iframe 足以承载插件 UI。

### 只支持声明式 UI

否决原因：会阻止画布、复杂可视化和高度定制交互的发展。

### 允许插件覆盖任意 CSS

否决原因：会破坏全局布局、主题、可访问性和插件间隔离。

## 后果

正面后果：

- 大多数 AI 生成界面可以即时、安全、风格一致地呈现。
- 高级插件仍有实现复杂交互的出口。
- 插件不能依赖 KnowBook 私有 DOM 和 React 结构。
- UI contribution 可以与 worker revision 一起原子切换和回滚。

负面后果：

- 需要维护 ViewSpec renderer、组件目录和 slot schema。
- iframe UI 与主应用的交互存在序列化和样式限制。
- 某些插件必须重新设计，不能直接复用任意 React npm 组件。
- 内置可信 UI 与动态 UI 使用两套实现通道。

## 验收标准

- 动态插件不能访问父页面 DOM、preload API 或其他插件 frame。
- ViewSpec 中的未知节点、属性和 handler 引用被拒绝。
- 禁用或更新插件后不残留 DOM、样式、消息监听器或快捷键。
- iframe 的直接网络和外部导航默认被阻止。
- 所有动态 UI 消息校验 revision/run/epoch。
- 一个插件的渲染异常不会卸载应用主页面。
- 主要产品区域都有文档化、版本化、可测试的扩展槽。

## 后续工作

- 定义 ViewSpec v1 schema 和 React renderer。
- 建立 slot catalog 与 AI 可查询的 inspect API。
- 制定 iframe CSP、资源 scheme 和 MessagePort 协议。
- 增加主题 token、可访问性和渲染预算测试。
