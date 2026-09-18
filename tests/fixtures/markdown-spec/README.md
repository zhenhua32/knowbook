# 官方 Markdown 规范样本

这些文件是固定版本的外部规范测试数据，供离线、可复现的兼容性验证使用。

| 文件 | 来源与版本 | 数量 | SHA-256 |
| --- | --- | ---: | --- |
| commonmark-0.31.2.json | https://spec.commonmark.org/0.31.2/spec.json | 652 | d431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20 |
| gfm-0.29.json | https://github.github.com/gfm/，0.29-gfm (2019-04-06) | 677 | ae2bb0ea40e77f55bfb758fdcbb1562063ee058a5b9348024fd3fff1221780cf |

CommonMark 文件原样保存。GFM 文件从官方 HTML 的每个示例提取 Markdown、预期 HTML、编号和章节；页面用于表示 Tab 的 `→` 转回 `\t`，没有更改示例语法或预期结果。提取脚本为 `scripts/extract-gfm-spec.mjs`：

```powershell
Invoke-WebRequest https://github.github.com/gfm/ -OutFile .tmp/gfm-spec.html
node scripts/extract-gfm-spec.mjs .tmp/gfm-spec.html
```

本次 GFM 原始页面的 SHA-256 为 `b153d814fdfc8624bb6da7449162c1cd707a637f7d1c1b636eb44b9cf63fa220`。

## 作者与许可

CommonMark 规范作者为 John MacFarlane 及贡献者；GFM 规范由 GitHub 发布，基于 John MacFarlane 的 CommonMark 规范。这些规范及此目录内由它们衍生的样例、策略输出数据按 [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/) 提供。原始署名和许可说明见 [CommonMark](https://spec.commonmark.org/0.31.2/) 和 [GFM](https://github.github.com/gfm/) 页面开头。提取、JSON 包装以及 KnowBook 策略输出属于本项目的改编。

## 有意差异的验证

`policy-differences.json` 逐条记录原始 HTML 作为文字、自动链接扩展始终开启、Wiki 链接优先，以及未识别的 XMPP 自动链接。每条同时保存当前预期输出，并参加测试；不是跳过用例。新增差异、输出变化、过时差异记录都会导致测试失败。所有样例仍须通过三轮普通 Markdown 和元数据备份往返，包括块内容与格式信息的恢复。

运行 `npm run test:markdown-spec` 会生成 `test-results/markdown-spec-report.json`，包含每条样例的结果。全量 `npm test` 也执行同样的规范验证，并额外覆盖编辑器草稿规范化与 SQLite 持久化。
