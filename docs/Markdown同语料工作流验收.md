# Markdown 同语料工作流验收

日期：2026-09-19。使用实际应用与固定文件，记录已完成的操作和未验证范围。本文不是产品综合排名，也不以官网功能列表代替应用实测。

## 固定输入与步骤

输入目录为 `tests/fixtures/markdown-workflows/`，含 `Acceptance.md`、`Target.md` 和本地 `pixel.svg`。`Acceptance.md` 的 SHA-256：`06d5cb9602c323e5f7130e1b53f8c34f8ce5610856c134cd5a1d9a90d03c1433`。每个应用使用独立的测试配置与文件副本。

1. 打开或导入整个目录，检查标题、嵌套列表、编号、引用、表格、任务、脚注、公式、提示块、Mermaid、普通链接、Wiki 链接和本地图片。
2. 从 `First editable` 的 `editable` 起点选到下一段 `Second` 的末尾，执行加粗、撤销、重做，保存并重新打开。两段之间的空行应保持，代码块不应改变。
3. 将表格第一行第一格的 `a|b` 改为 `a|b edited 中文`，保留三列及对齐。代码单元格源文为 `` `c\|d` ``，单独记录呈现的反斜杠与竖线。
4. 勾选 `Pending task`，检查其他任务未被改动。
5. 将 `Target` 改名为 `Renamed`，核对普通链接、Wiki 链接、章节地址及代码围栏内同名的字面内容。
6. 保存／导出 Markdown 与附件，在新文件目录或恢复流程中重新打开，再保存；重复三轮，比较文件内容和链接目标。导入后转换为应用内部附件或笔记 ID 的地址应单独记录。

KnowBook 自动化复现：先运行 `npm run build`，再运行 `npx playwright test e2e-tests/markdown-workflow-corpus.spec.ts --grep "@electron"`。报告与截图输出到 `test-results/markdown-workflow-knowbook.*`，Linux CI 上传 `markdown-workflow-report`。

## 已取得的应用证据

| 应用 | 版本与配置 | 已验证范围 | 仍待验证 |
| --- | --- | --- | --- |
| KnowBook | 当前源码；独立临时数据库 | 固定语料 Electron 回归覆盖完整正文选区、格式和撤销、表格修改、阅读渲染、任务、改名、附件与三轮往返；另检查块 ID 和引用；已增加 800／4000 块源码编辑延迟验收 | 系统输入法候选窗口；与竞品一致的应用性能采样 |
| Obsidian | 1.13.7，Windows x64；无社区插件；允许测试库 Mermaid；启用自动更新内部链接 | 打开原文、跨段部分加粗、撤销／重做、重新载入、表格及高级内容呈现、任务勾选、目标改名 | 表格修改；相同三轮文件往返；与其他应用一致的性能采样 |
| Joplin | 3.7.18，Windows x64；隔离配置，默认 Markdown 选项，无同步目标 | 通过原生 `MD - Markdown (文件目录)` 导入两篇测试笔记和图片；退出后只读检查数据库中的正文 | 编辑与渲染断言、改名、导出和三轮往返 |
| Typora | 1.14.10，Windows x64；隔离配置，中文界面，用户授权本次免费试用 | 已进入编辑器并打开原文；精确跨段部分选区、加粗、撤销和重做，三次保存后逐字核对源码；观察三列表格呈现 | 重新打开；表格修改、任务、目标改名及三轮文件往返 |

Obsidian 的 Electron／Chromium 为 43.3.0／150.0.7871.212，Joplin 为 42.3.0／148.0.7778.180；两者均使用官方发布程序。版本来源：[Obsidian 发布](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.7)、[Joplin 发布](https://github.com/laurent22/joplin/releases/tag/v3.7.18)、[Typora 下载](https://typora.io/)。Typora 已通过原生界面的“以后再说”进入剩余 15 天的试用；此前测试脚本的隐藏启动选项影响编辑器显示，改为可见窗口启动后打开了测试文档。未完成的步骤仍保留为待验收项。

## 此语料中观察到的差异

- Obsidian 与 Typora 本次三列表格中的代码单元格均呈现 `c\|d`，保留反斜杠；KnowBook 的断言要求呈现 `c|d`。普通单元格 `a\|b` 在三者均呈现 `a|b`。这只是当前固定样例的结果。
- Joplin 的普通 Markdown 目录导入把链接和图片转换为 `:/...` 内部地址；本次还改写了代码围栏内 `[link](Target.md)` 的目标。该结果来自导入后的持久化正文，不是仅从预览推断。KnowBook 回归要求代码围栏内的同名链接在导入、改名和往返时保持字面内容。
- Obsidian 在启用内部链接自动更新后，正确更新普通链接与 Wiki 链接，并保留代码围栏中的同名内容。KnowBook 使用默认链接维护流程验证相同性质。
- 不将 Joplin／Typora 尚未执行的步骤标成“不支持”；未进行同机同方法的应用性能采样，不能据此比较速度或宣称整体领先。

可审查记录：[Obsidian 操作与原文](benchmarks/markdown-workflow-obsidian.json)、[Joplin 导入后正文](benchmarks/markdown-workflow-joplin-import.json)、[Typora 原生选区、格式与撤销重做](benchmarks/markdown-workflow-typora-native.json)。Obsidian 记录仅去除与比较无关的 Mermaid CSS 和侧栏文本，保留实际单元格内容、格式后源码与改名后源码。Typora 的格式后源码只改变指定的两个选区，撤销后保存与原始文件一致，重做后保存与第一次加粗一致；这些结果尚不包含冷启动重开。

Obsidian 的编辑／撤销／重载子流程完成后，恢复了原始正文再验证阅读、任务与改名；目前还不是贯穿全部步骤的连续往返验收。后续需用上面的统一步骤补齐这一部分。
