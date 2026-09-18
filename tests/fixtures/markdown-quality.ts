/** Fixed, deterministic inputs shared by correctness and performance checks. */
export function mixedMarkdown(sections: number): string {
  return Array.from({ length: sections }, (_, index) => `## 第 ${index} 节

中英文 **bold** ~~strike~~ ==mark== $x_i^2$ [note](Target.md#section-${index})[^n${index}]

- [x] Task
- [ ] Pending

| Left | Right |
| :--- | ---: |
| a\\|b | [link](Target.md#section-${index}) |

> [!note] 注释
> Content

\`\`\`ts
const section = ${index};
\`\`\`

[^n${index}]: Footnote [link](Target.md#section-${index})`).join('\n\n')
}

export const unclosedMath = '$x '.repeat(5_000)
export const unclosedBrackets = '['.repeat(12_000) + 'text'
export const deepQuote = '> '.repeat(2_000) + 'text'
export const duplicateHeadings = Array.from({ length: 4_000 }, (_, index) => `## Same\n\nText ${index}`).join('\n\n')
export const largeTable = '| A | B | C | D |\n| - | - | - | - |\n' + Array.from({ length: 1_000 }, (_, index) =>
  `| 中文 ${index} | $x_${index}$ | [${index}](Target.md#row-${index}) | a\\|b |`).join('\n')
export const imageParagraph = Array.from({ length: 2_000 }, (_, index) => `![图 ${index}](assets/${index}.png)`).join(' ')
