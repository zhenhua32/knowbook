# System Plugin v3 开发示例

这个目录本身是可安装插件，不需要 npm 安装或构建。

在 KnowBook 插件中心选择本目录，核对插件 ID `system.example.starter`、完整系统访问声明和 SHA-256，再完成确认并重启。主进程会创建一篇“系统插件示例”文档；首页显示卡片；后台服务读取文档目录并把结果写入插件专属 `dataRoot/service.json`。`state.json` 保留文档 ID，因此再次启动不会重复创建。

此示例会修改当前知识库。建议在独立测试工作区安装。停用会清理订阅、卡片、CSS 和应用内服务；卸载会删除 runtime/artifact/log，专属 data 可在卸载对话框中选择保留或删除。保留时重新安装同一 ID 可继续使用 state.json。已创建的知识库文档及通过任意 Settings API 写入的设置仍保留；需要移除它们时，在知识库中删除该文档，并由自己的迁移或清理功能处理设置。

修改源码或 manifest 后重新选择此目录安装，新的 SHA-256 必须重新确认。升级示例时保留 ID 并提高 manifest 版本。不要直接修改已发布的 artifact。对持久数据的迁移应保持兼容：回滚代码不会自动回滚数据库或插件数据。

JSDoc 从仓库的 `src/shared/system-plugin-sdk.ts` 引用类型，仅用于编辑器提示；它们不会在运行时导入宿主源码。将目录复制到外部项目时，可以保留 KnowBook 源码作为类型开发依赖并调整这些相对路径，或移除 JSDoc；三个 `.cjs` 入口无需改动即可运行。

完整说明见 [开发指南](../../docs/system-plugin-v3-development.md)；Yarn 的构建配置见 [Yarn 说明](../../docs/system-plugin-yarn.md)。
