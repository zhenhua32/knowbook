export const advancedMarkdown = [
  '[TOC]', '', '# Advanced', '',
  'Text ==highlight **bold**==, $E=mc^2$, \\(x+y\\) and named[^note] / repeated[^note].', '',
  '- [x] Task with inline ^[An ==inline note== and ^[a nested note].]',
  '- [ ] Another reference[^note]', '',
  '> [!tip]+ A **formatted** title[^tip]', '> Body with $a^2+b^2=c^2$.', '>',
  '> > [!warning]- Nested warning', '> > Keep ==important== text.', '',
  '| Value | Formula | Source |', '| :- | :-: | -: |', '| x | $x^2$ | [^note] |', '',
  '## Repeated $x$', '', '## Repeated $x$', '',
  '$$\\sum_{i=1}^n i = \\frac{n(n+1)}2$$', '',
  '\\[', '\\int_0^1 x^2 \\,dx=\\frac13', '\\]', '',
  '```mermaid', 'flowchart LR', '  A[写作] --> B[预览] --> C[保存]', '```', '',
  'Missing reference[^missing]; literal `[^note] $code$ ==text==` and \\==escaped==.', '',
  '[^note]: Definition with **formatting**, a [link][guide] and $z^2$.', '',
  '    Second paragraph and a list:', '', '    - item one', '    - item two', '',
  '[^tip]: Tip definition.', '', '[guide]: https://example.com/guide "Guide"'
].join('\n')
