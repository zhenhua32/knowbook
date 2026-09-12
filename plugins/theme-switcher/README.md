# 主题切换（System Plugin v3）

KnowBook 内置的 v3 插件，随应用提供并默认启用，无需单独安装。在“配置中心”的主题卡片中点击即可应用六款主题，选择会自动保存并在下次启动恢复。插件 ID 为 `theme-switcher`。

| 主题 | 类型 | 配色 |
| --- | --- | --- |
| 云白 | 浅色 | 清爽白与靛蓝 |
| 暖纸 | 浅色 | 米白纸色与暖棕 |
| 青苔 | 浅色 | 柔和灰绿与森林绿 |
| 海湾 | 深色 | 深海蓝与青色 |
| 午夜 | 深色 | 深灰蓝与明亮蓝 |
| 紫夜 | 深色 | 深紫与淡紫 |

## 使用

1. 启动 KnowBook，在“配置中心”找到主题切换区域。
2. 点击主题卡片应用配色。选择“跟随 KnowBook”可恢复应用自身的浅色 / 深色设置。
3. 在插件中心可查看“来源：内置”及运行状态，或停用插件；重新启用后按提示重启应用。

首次使用默认跟随 KnowBook。主题卡片支持键盘 Tab 聚焦和 Enter / Space 选择，保存失败时保留当前配色并显示错误。预览卡片展示侧栏、内容区和强调色。

插件不改写应用的 `appearance.theme`，因此停用时会立即移除配色覆盖、界面和订阅，恢复当前宿主外观；再次启用并重启仍保留上次选择。在自定义主题生效时，宿主的浅色 / 深色设置会保留，选择“跟随 KnowBook”后生效。

## 实现

- `plugin.json`：v3 Full Trust 声明和 Main / Renderer 入口。
- `main.cjs`：通过 v3 消息接口返回主题目录，校验并保存 `theme-switcher.selected-theme`。
- `themes.cjs`：六款预设及语义颜色。
- `theme-css.cjs`：生成主题样式，覆盖应用外壳、文档、配置中心、插件中心与数据库等区域。
- `renderer.cjs`：注册 `settings.sections`，注入样式并管理根节点专属 `data-knowbook-theme-switcher` 属性。首次应用在 Renderer revision 提交后执行，停用自动清理。

无需 npm 依赖、构建或后台服务。配色不修改文档内容和用户已设置的块颜色；第三方插件自带的独立 iframe、Shadow DOM 或硬编码样式可能保留各自外观。

代码由 `src/main/system-plugin/builtin-catalog.ts` 编译进主进程包，打包后无需仓库目录。修改源码后重新构建并启动应用，宿主按内容哈希更新内置版本。已有手动安装会迁移到内置代码，并保留主题选择、停用和安全停用状态。安全模式不加载主题插件。

内置插件随应用更新，不能单独卸载、回滚或从外部目录覆盖。普通外部 v3 插件仍需确认精确安装内容；manifest 无法将插件声明为内置。

## 验证

在仓库根目录执行：

```powershell
npm run typecheck
npm run typecheck:system-plugin-examples
npm run test
npm run build
npx playwright test e2e-tests/theme-switcher.spec.ts --grep '@electron'
```

测试覆盖内置注册、升级、停用保留、安全模式、持久化、输入校验、宿主外观保留、保存失败与停用清理；Electron 用例覆盖首次启动自动启用、六款配色切换、重启恢复和重新启用。
