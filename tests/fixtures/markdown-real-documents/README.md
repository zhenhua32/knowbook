# 真实文档与目录迁移语料

每组的 `input/` 独立导入。`manifest.json` 固定来源、原始文件哈希和预期诊断；测试不访问网络。

- `readme`：已锁定的 npm `markdown-it@15.0.2` 分发包中的原始 README。保留完整正文；MIT 许可见 `readme/LICENSE.txt`。来源：https://github.com/markdown-it/markdown-it 。npm 包未携带它引用的项目文档，缺失文档须明确报告。
- `technical`：KnowBook 提交 `e2bf868a0d85caf651e4898968554c639c6c7de5` 中实际随项目提供的高级语法技术文档，未经改写。
- `joplin`：此前已完成的 Joplin 3.7.18 原生工作流第一轮真实 Markdown 导出。原路径 `.tmp/markdown-competitors/joplin-native-roundtrip-1/`，包含 `_resources` 图片；正文源自本项目自有语料。完整保留该编辑器的跨段加粗、代码字面链接转换和过期 Wiki 目标，不能把它们写成 KnowBook 新引入的问题。
- `typora`：此前 Typora 原生编辑、保存和改名后留下的真实文件及图片，原路径 `.tmp/markdown-competitors/typora-vault/`，正文源自本项目自有语料。此次直接固定文件，不重新宣称做了竞品界面实测。
- `vault`：本轮编写的多文件迁移回归目录。覆盖中文与空格路径、YAML、附件、HTML 折叠锚点、任务/表格/脚注、缺失资源、目录外资源、外部编辑器嵌入和别名，以及代码中的附件路径。它是合成的回归场景，不冒充第三方真实笔记库。

验收核对导入报告、块级定位、真实附件字节、原始代码/YAML和不可渲染源码、已解析链接目标，以及连续三轮普通 Markdown 和备份恢复。与输入格式规范化相关的差异明确比较；不声称逐字节复原全部排版。
