# Markdown 同语料工作流验收

首次验收于 2026-09-20。记录实际应用对固定文件的操作结果，后续性能采样单独注明运行环境与日期。

## 固定输入与步骤

输入目录为 `tests/fixtures/markdown-workflows/`，含 `Acceptance.md`、`Target.md` 和本地 `pixel.svg`。`Acceptance.md` 的 SHA-256：`06d5cb9602c323e5f7130e1b53f8c34f8ce5610856c134cd5a1d9a90d03c1433`。每个应用使用独立的测试配置与文件副本。

1. 打开或导入整个目录，检查标题、嵌套列表、编号、引用、表格、任务、脚注、公式、提示块、Mermaid、普通链接、Wiki 链接和本地图片。
2. 从 `First editable` 的 `editable` 起点选到下一段 `Second` 的末尾，执行加粗、撤销、重做，保存并重新打开。两段之间的空行应保持，代码块不应改变。
3. 将表格第一行第一格的 `a|b` 改为 `a|b edited 中文`，保留三列及对齐。代码单元格源文为 `` `c\|d` ``，单独记录呈现的反斜杠与竖线。
4. 勾选 `Pending task`，检查其他任务未被改动。
5. 将 `Target` 改名为 `Renamed`，核对普通链接、Wiki 链接、章节地址及代码围栏内同名的字面内容。
6. 保存／导出 Markdown 与附件，在新文件目录或恢复流程中重新打开，再保存；重复三轮，比较文件内容和链接目标。导入后转换为应用内部附件或笔记 ID 的地址应单独记录。

KnowBook 自动化复现：先运行 `npm run build`，再运行 `npx playwright test e2e-tests/markdown-workflow-corpus.spec.ts --grep "@electron"`。报告与截图输出到 `test-results/markdown-workflow-knowbook.*`，Linux CI 上传 `markdown-workflow-report`。

## 2026-09-20 已取得的应用证据

| 应用 | 版本与配置 | 已验证范围 | 仍待验证 |
| --- | --- | --- | --- |
| KnowBook | `c8ecaa5`；独立临时数据库 | 固定语料 Electron 回归覆盖完整正文选区、格式和撤销、表格修改、阅读渲染、任务、改名、附件与三轮往返；另检查块 ID 和引用；800／4000 块源码编辑延迟验收及原生单字符输入采样；Windows 中文输入法真实候选、提交、取消、撤销重做和保存重开 | 原生输入速度差距的定位与改善；更多操作的竞品性能采样 |
| Obsidian | 1.13.7，Windows x64；无社区插件；启用自动更新内部链接 | 同一正文上的连续原生加粗、撤销／重做、保存重开、表格修改、任务、改名和阅读；三轮复制到独立新库后重开、保存，正文／图片与目标核对通过；800／4000 块原生源码输入采样 | 新库 Mermaid 信任提示待用户处理；更多操作的性能采样 |
| Joplin | 3.7.18，Windows x64；隔离配置，默认 Markdown 选项，无同步目标 | 原生目录导入、跨段格式与撤销／重做、冷启动重开、表格修改、任务、阅读和改名；三轮重新导入、打开并再次导出，核对正文、目标和图片；800／4000 块原生源码输入采样 | 更多操作的性能采样；统一附加渲染参数 |
| Typora | 1.14.10，Windows x64；隔离配置，中文界面，用户授权本次免费试用 | 跨段部分选区、加粗、撤销／重做、保存及冷启动重开；表格修改、任务勾选、目标改名；三轮另存、关闭窗口、重开并保存，正文逐字一致，图片未随另存复制；800／4000 块原生源码输入、保存及全文核对 | 可比的帧计时；当前发行版拒绝调试启动参数 |

Obsidian 的 Electron／Chromium 为 43.3.0／150.0.7871.212，Joplin 为 42.3.0／148.0.7778.180；两者均使用官方发布程序。版本来源：[Obsidian 发布](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.7)、[Joplin 发布](https://github.com/laurent22/joplin/releases/tag/v3.7.18)、[Typora 下载](https://typora.io/)。Typora 已通过原生界面的“以后再说”进入授权的免费试用；此前测试脚本的隐藏启动选项影响编辑器显示，改为可见窗口启动后打开了测试文档。未完成的步骤仍保留为待验收项。

## 此语料中观察到的差异

- Obsidian 与 Typora 本次三列表格中的代码单元格均呈现 `c\|d`，保留反斜杠；KnowBook 的断言要求呈现 `c|d`。普通单元格 `a\|b` 在三者均呈现 `a|b`。这只是当前固定样例的结果。
- Joplin 的普通 Markdown 目录导入把链接和图片转换为 `:/...` 内部地址；本次还改写了代码围栏内 `[link](Target.md)` 的目标。该结果来自导入后的持久化正文，不是仅从预览推断。KnowBook 回归要求代码围栏内的同名链接在导入、改名和往返时保持字面内容。
- Joplin 的跨段部分选区加粗在整个选区两端插入一对 `**`，中间空行保留，阅读视图仍显示字面标记。撤销恢复原文，`Ctrl+Y` 重做及冷启动后保存结果一致。表格单元格修改保留三列与对齐，并重新排齐表格源码空白；表格外正文保持不变，代码单元格呈现 `c|d`。任务勾选只改变目标任务。
- Joplin 改名后通过内部 ID 打开 `Renamed`，普通链接仍可用；本次默认配置将 `[[Target]]` 作为字面文本、`[!tip]` 作为普通引用。脚注与两处回链、行内／块公式、高亮、Mermaid 和本地图片均有原生阅读证据。
- Joplin 三轮均从上一轮导出的笔记目录重新导入为新笔记本，再打开正文并导出到新目录。每次导出包含两篇 Markdown 和同字节图片；仅映射笔记／附件 ID 与文件路径后，正文逐字一致，导出的目标和图片路径均能解析。相同配置中保留各轮笔记本会产生重名后缀，因此原始正文哈希不同；这不是字节完全相同的往返。代码围栏内的同名链接也跟随这些地址转换，字面内容不保真。
- Obsidian 在启用内部链接自动更新后，正确更新普通链接与 Wiki 链接，并保留代码围栏中的同名内容。KnowBook 使用默认链接维护流程验证相同性质。
- Obsidian 连续原生流程中，跨段部分加粗分别为两段添加标记；撤销恢复原文，重做及关闭笔记标签页后重开保持一致。表格修改只改变目标内容及表格排齐空白，保留三列和对齐；任务只改变指定复选框。三轮均显式复制上轮保存的两篇 Markdown 和 SVG 到独立新库，再通过原生界面打开、保存和点击章节目标；全部文件字节一致，最终轮 Wiki 跳转也通过。这是文件夹迁移流程，不是 Obsidian 的 Markdown 导出命令。
- Obsidian 在原库子目录内保留同名副本时，短地址 `Renamed.md` 曾跳到根目录的目标；该诊断没有计入独立库往返通过。新库 Mermaid 会显示信任提示，本轮没有代点安全权限按钮；此前已有允许图表的库中取得渲染证据，新库结果明确保留此边界。
- Typora 通过“文件 → 移动到”将 `Target.md` 改为 `Renamed.md` 后，正文中的普通链接与 Wiki 链接仍指向旧名称，代码字面内容保持不变。这是本次隔离默认配置的观察；未出现自动更新链接的提示。表格和任务的修改均只改变目标位置。
- Typora 的普通“另存为”流程连续三轮在新的空目录中只产生 `Acceptance.md`。每轮关闭文档窗口、通过原生文件对话框重开并保存，正文 SHA-256 均为 `2ef691aaf0b3970c93f39d4b07bde5281114c19d96b0e8d874c66762d62bf364`，与编辑后的源文件逐字一致。`pixel.svg` 未随文件复制，相对图片引用保持原文，重开后显示缺失占位。因此正文往返稳定，正文与附件整体迁移未保留。测试使用普通另存为流程，未手动补入附件或更改图片复制设置。
- 未执行的步骤不标成“不支持”。下述同机采样只覆盖单字符输入，未统一所有运行环境，也不能据此宣称整体领先。

可审查记录：[Obsidian 操作与原文](benchmarks/markdown-workflow-obsidian.json)、[Joplin 初始导入正文](benchmarks/markdown-workflow-joplin-import.json)、[Joplin 连续原生工作流及三轮往返](benchmarks/markdown-workflow-joplin-native.json)、[Typora 原生操作与文件核对](benchmarks/markdown-workflow-typora-native.json)。Obsidian 记录仅去除与比较无关的 Mermaid CSS 和侧栏文本，保留实际单元格内容、格式后源码与改名后源码。Typora 的格式后源码只改变指定的两个选区，撤销后保存与原始文件一致，重做后保存与第一次加粗一致；冷启动后确认编辑结果保留。

早期 Obsidian 记录在格式子流程后曾恢复原文；后续补充的 [连续原生流程与三轮独立库迁移记录](benchmarks/markdown-workflow-obsidian-native.json) 保留同一正文从格式到文件往返的完整修改，没有中途恢复原始内容。

## 800／4000 块原生源码输入

在同一台 Windows x64、i7-9750H（12 个逻辑处理器）电脑上，使用 `tests/fixtures/markdown-source-performance.ts` 的完整源码。800 块为 101769 字符，SHA-256 为 `4157a1436f0f232418b1697c1de63a38f9f988dc653b1473ac1ea180e384eaab`；4000 块为 512089 字符，SHA-256 为 `3439c0ef175632fe2b6416435a96f07dc0e84406e7b78568fc93e3649bece823`。KnowBook 受测代码为 `c8ecaa528ceabe8f28902e50ec8cc701db11b461`，该提交的 [Linux／Windows 全量 CI](https://github.com/zhenhua32/knowbook/actions/runs/35449686566) 已通过。

操作均由 Windows 原生按键完成：最大化窗口，在整篇源码首部按 `7`，观察完成后再输入下一次。每种规模预热 2 次、测量 7 次；监听可信、非组合输入的 `insertText` 事件，记录到第二次 `requestAnimationFrame` 的耗时。全文读取在计时结束之后，六组数据均确认结果恰好为九个 `7` 加原文。测试应用逐个运行，采样期间没有并行构建或测试。

| 应用 | 800 块中位数／p95 | 4000 块中位数／p95 |
| --- | ---: | ---: |
| KnowBook 0.1.2 | 51.5／70.6 ms | 52.9／70.0 ms |
| Obsidian 1.13.7 | 4.5／6.7 ms | 4.4／6.9 ms |
| Joplin 3.7.18 | 32.5／42.2 ms | 34.6／49.2 ms |
| Typora 1.14.10 | 未取得可比计时 | 未取得可比计时 |

KnowBook 在这批记录的指标上慢于 Obsidian 和 Joplin。此处测量的是渲染机会，不是物理屏幕呈现或操作系统按键到画面的完整延迟。每组只有 7 个测量样本，p95 即最大值；开文档、批量格式化、粘贴、保存以及文档中部／尾部操作均不在本次竞品采样内。

所有应用使用 `--disable-gpu`。KnowBook、Obsidian 和 Typora 另有 `--disable-software-rasterizer --in-process-gpu`，KnowBook 还使用测试启动器的 `--no-sandbox`。Joplin 拒绝前一参数，因此记录的启动未传这两个附加参数；其仅编辑器布局仍保留默认源码样式。KnowBook 的 Electron／Chromium 为 35.7.5／134.0.6998.205，与前述竞品版本不同。窗口宽度均为 1920、DPR 为 2；KnowBook／Joplin 高度为 984，Obsidian 为 1032。编辑区宽度、字体、样式及运行时版本未全部统一，这些数据不足以确定性能差异的具体原因。

Typora 拒绝 `--remote-debugging-port=0`，显示“Arguments not allowed debug in production main thread”。移除调试参数后，通过原生界面在两种规模的源码首部各输入一次 `7` 并保存；两份文件均严格等于一个 `7` 加原文。此项只有输入与保存的一致性证据，不提供延迟数字。

另对 KnowBook 4000 块执行一次输入追踪，输入到第二帧为 22.11 ms，其中布局 2.663 ms、提交 4.963 ms；该次没有复现 70 ms 样本，不能单凭一次追踪归因。诊断、窗口未最大化时的样本以及输入法／粘贴校准均未混入上表。

证据：[全部原始样本、摘要及限制](benchmarks/markdown-native-source-input.json)，以及 4000 块截图：[KnowBook](benchmarks/markdown-native-source-knowbook-4000.png)、[Obsidian](benchmarks/markdown-native-source-obsidian-4000.png)、[Joplin](benchmarks/markdown-native-source-joplin-4000.png)、[Typora](benchmarks/markdown-native-source-typora-4000.png)。KnowBook 的计时稿未应用保存，其保存与往返保证来自独立的功能验收。

### 复现采集

[采集工具](../scripts/markdown-native-input.mjs) 只生成测试输入和安装只读计时监听，不启动应用、不模拟按键、不修改文档。先使用新目录生成输入：

```powershell
node --import tsx scripts/markdown-native-input.mjs prepare .tmp/native-input-fixtures
```

在应用的独立测试配置中打开对应文件并进入完整源码模式。KnowBook 本次通过 `e2e-tests/helpers/electron.ts` 启动隔离实例，用 `sourceEditingBlocks(800)`／`sourceEditingBlocks(4000)` 创建文档，再从“编辑 Markdown 源码”进入。不同文档的块 ID 需加不同前缀，避免测试数据发生 ID 冲突。调试地址必须来自该测试实例的本机 CDP 端点。

```powershell
node scripts/markdown-native-input.mjs collect --app knowbook --endpoint http://127.0.0.1:PORT --fixtures .tmp/native-input-fixtures --output .tmp/native-input-results/knowbook-800.json --blocks 800 --mode "Full Markdown source; maximized" --launch-flags="--no-sandbox --disable-gpu --disable-software-rasterizer --in-process-gpu"
```

替换 `PORT`、应用、规模和实际启动参数；每次使用新输出路径。看到 `Armed` 后聚焦源码并按 `Ctrl+Home`，逐次手动或通过原生界面按 `7`，每次等到 `Recorded` 再继续。工具要求初始全文与固定输入一致，拒绝覆盖已有报告，最后检查全文和重叠输入。关闭当前应用后再测另一应用。工具另经独立 Electron 协议自检验证采样、全文校验与清理；自检使用模拟输入，未计入原生实测证据。

## 私有虚拟显示的工作流采样

2026-11-21 采样沿用上述 800／4000 块全文，在同一个私有 Xvfb 屏幕中操作各应用的源码编辑器。环境为 i9-12900K、Ubuntu 22.04 WSL2、1600×900 像素、96 DPI，禁用硬件加速。采样程序使用 X11 XTest 发出按键或点击，按 5 毫秒间隔读取虚拟屏幕。连续三次命中已通过全文校验的目标画面区域时，取第一次命中的时间。每组预热两次、保留七个样本，因此 p95 取最大值。硬件、操作系统和计时边界都有变化，先前的 Windows 数据单独解读。

- 打开从运行中的应用开始，记录打开动作到目标源码首屏出现。表内是预热后的切换，首次打开和进程冷启动需要独立采样。
- 输入在全文首部插入一个 `7`。批量格式化先选定全文，再应用粗体。粘贴在全文首部插入同一份 20 段纯文本。每次测量后校验完整源码，再撤销并确认原文恢复。
- 保存等待独立文件或 SQLite 连接读取预期正文。自动保存从编辑动作开始计时，显式保存从保存或应用动作开始计时，两类计时的起点在报告中注明。

| 应用和规模 | 打开 p95 | 输入 p95 | 全篇加粗 p95 | 粘贴 p95 | 保存读回 p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Joplin 3.7.18，800 块 | 61.2 ms | 21.2 ms | 21.3 ms | 21.2 ms | 384.4 ms（自动） |
| Joplin 3.7.18，4000 块 | 63.2 ms | 21.4 ms | 42.0 ms | 161.4 ms | 555.3 ms（自动） |
| KnowBook 0.2.0，800 块 | 89.5 ms | 21.3 ms | 50.5 ms | 26.4 ms | 919.4 ms（显式） |
| KnowBook 0.2.0，4000 块 | 356.4 ms | 58.3 ms | 132.9 ms | 73.5 ms | 1,521.9 ms（显式） |
| Obsidian 1.13.7，800 块 | 42.3 ms | 10.9 ms | 21.2 ms | 15.9 ms | 2,009.9 ms（自动） |
| Obsidian 1.13.7，4000 块 | 36.8 ms | 10.9 ms | 68.6 ms | 15.9 ms | 2,012.4 ms（自动） |
| Typora 1.14.9，800 块 | 51.9 ms | 10.8 ms | 源码不可用 | 15.9 ms | 5.6 ms（显式） |
| Typora 1.14.9，4000 块 | 77.2 ms | 15.9 ms | 源码不可用 | 15.9 ms | 11.6 ms（显式） |

KnowBook 从已打开的文档进入整篇源码编辑区，显式应用的计时终点是独立 SQLite 连接读到首个变更块，随后重开源码编辑区核对全文。Obsidian 从文件树切换待机文档与目标文档，自动保存读回整个文件。Joplin 从笔记列表切换，自动保存通过独立 SQLite 连接读回整篇正文。Typora 在已载入文档上按 `Ctrl+/` 切入源码，显式保存读回整个文件。很短的样本受 5 毫秒轮询间隔影响。[原始样本与计时起点](benchmarks/markdown-desktop-workflow.json)

4000 块全选加粗后，KnowBook 在可格式化的段落中插入 7600 个 `**` 分隔符，Obsidian 插入 9580 个，Joplin 在整个选区首尾插入 2 个。表内时间对应各自的原生命令，修改量有明显差异。Typora 在源码模式将 Strong 置灰，两种规模全选后按 `Ctrl+B` 均逐字保留原文。[Typora 源码格式菜单](benchmarks/markdown-workflow-typora-source-format.png)

4000 块时，KnowBook 的文首输入 p95 为 58.3 毫秒，其他三款为 10.9 至 21.4 毫秒。20 段粘贴时，KnowBook 为 73.5 毫秒，Joplin 为 161.4 毫秒，Obsidian 和 Typora 均为 15.9 毫秒。四款应用的编辑样式与运行时仍有差异。

[虚拟显示采样工具](../scripts/markdown-workflow-frame.py) 仅接受配置了 `-fbdir` 和 `-nolisten tcp` 的测试 Xvfb 进程。先在隔离配置中确认目标状态并采集区域摘要，再将编辑器恢复到起始状态，然后输入动作。像素区域应避开鼠标位置、光标闪烁和计数提示。以下是批量格式化的采样命令，每次都应在计时完成后校验全文，预热两次后记录七次。

```bash
python3 scripts/markdown-workflow-frame.py --xvfb-pid "$xvfb_pid" capture 625 155 300 110 > formatted-frame.json
python3 scripts/markdown-workflow-frame.py --xvfb-pid "$xvfb_pid" frame Control_L+b formatted-frame.json
```

会自动滚动的界面用 `capture-ink` 和 `ink` 在编辑器的固定水平位置匹配可验证的字形，允许字形出现在不同的垂直位置。命中后继续校验全文。

## 第五阶段的后续事项

- 定位并改善 KnowBook 的 4000 块文首输入延迟，再用同一方法复测。
- Obsidian 新库 Mermaid 信任提示仍需用户处理，随后补验该库中的图表。此前已授权库的图表渲染证据不代替新库结果。
