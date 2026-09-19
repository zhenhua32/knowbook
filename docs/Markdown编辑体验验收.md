# Markdown 编辑体验验收

第三阶段把已支持的 Markdown 语法接入可操作的编辑界面。实现继续使用文档的 Markdown 源码和现有草稿历史，不另存一份表格或任务状态。

## 操作与实现

| 能力 | 行为 |
| --- | --- |
| 表格单元格 | 点击、Enter 或 F2 编辑；未编辑的单元格显示文档级预览，支持样式、公式和脚注。源码可展开修改。 |
| 表格结构 | 在选中位置增删行列、修改整列对齐；保留至少一列表头，支持无表体。 |
| 表格键盘 | Tab / Shift+Tab 切换单元格，末格 Tab 新增行；Enter / Shift+Enter 下移／上移；边界方向键移动；Esc 退出编辑后，Tab 可离开表格。 |
| 电子表格粘贴 | 解析制表符、行分隔、引号和双引号转义，自动扩展目标范围；单元格内部的换行与制表符保存为字符实体。 |
| 文本格式 | 粗体、斜体、删除线、高亮、行内代码、链接，支持按钮和 Ctrl/⌘ 快捷键；Alt+F10 进入工具栏，方向键切换、Esc 返回编辑；保留中文与 Emoji 选区，代码内容选择合适的反引号围栏。 |
| 跨段源码格式 | 同一个源码编辑区内跨段选区按解析区域处理，保留列表、引用等前缀和整块代码／公式；混合样式先统一添加，再次操作统一移除。跨段链接分别创建并选中首个地址。文档菜单中的“编辑 Markdown 源码”提供完整正文的连续文字选区，可跨多个独立块操作。 |
| 任务交互 | 正文、复杂列表、引用、提示块和脚注共用文档级源码位置；勾选只修改对应任务标记，代码中的字面标记保持不变。 |
| 阅读列表 | 使用语义化的 ul / ol / li，保留重启编号、嵌套、紧凑／松散列表及各块的定位、折叠与高亮。 |
| 快捷插入 | `/table`、`/mermaid`、`/callout`、`/toc`；精确命令优先，已有文字保留。 |
| 历史与保存 | 结构和格式操作建立历史边界；阅读模式可撤销／重做本次阅读中的任务操作，不会跨过模式切换点撤销或重做此前的源码编辑；所有变更沿用草稿自动保存、文件导出和备份流程。 |

## 固定检查

- `tests/shared-markdown-editing.test.ts`：表格转义、引用定义、多余单元格保留，行列变换和空表体，带引号的粘贴，复杂任务的精确位置，列表分组，格式切换与选区。
- `e2e-tests/markdown-editing.spec.ts`：真实点击和输入，表格内格式与输入法，Tab 新增行，退出表格及跨块焦点，撤销／重做，保存重载，文件导出再导入，阅读任务交互、列表折叠、格式工具栏键盘导航及快捷插入。
- `e2e-tests/markdown-source-editor.spec.ts` 与 `e2e-tests/markdown-workflow-corpus.spec.ts`：整篇源码编辑、跨块部分选区、重复段落身份、块引用、应用后撤销重做、输入法提交、保存重载和固定文件三轮往返。单元回归另覆盖分段／合并、重建嵌套关系、未修改多段块、标签与高亮，以及拒绝粘贴元数据指定外部块 ID。
- 相关回归还包括原有编辑器快捷键、高级语法、GFM 扩展、链接、长文档和输入法用例。
- CommonMark 与 GFM 的 1329 条固定样本继续执行三轮往返，保持既有显式产品差异，不放宽校验。

## 本地验证（2026-09-18）

- `npm run build`：三个 TypeScript 配置检查、生产构建及包体积检查通过。入口 JavaScript 为 440.69 KiB，CSS 为 95.73 KiB；保持原有的 450 / 96 KiB 上限。
- `npm run typecheck:system-plugin-examples`：通过。
- `npm test`：722 个用例全部通过，无跳过。
- `npm run test:markdown-spec`：1329 条官方样本完成三轮往返，无新增失败；明确的产品差异不变。
- 编辑快捷键、长文档、高级语法、GFM 扩展及本阶段编辑体验的 25 项 Electron 用例全部通过，包括模式切换前后的撤销／重做边界。
- 用 `PLAYWRIGHT_ELECTRON_LOCALE=zh-CN` 重新执行本阶段的 4 项交互验收，全部通过。

## 复现命令

```text
npm run typecheck
npm run typecheck:system-plugin-examples
npm test
npm run test:markdown-spec
npm run build
npx playwright test --grep @electron
```

提交版本必须检查对应 CI 的 Linux 全量回归和 Windows 打包验收。界面示例由 Electron 测试保存至 `test-results/markdown-table-editing.png` 和 `test-results/markdown-interactive-tasks.png`。

## 后续范围

表格单元格遵循 GFM 行内语法，合并单元格及单元格内块级内容不在该语法范围。文档与章节改名后的链接更新，以及最终性能、异常输入和竞品对照，继续按 [提升计划](Markdown提升计划.md) 推进。
