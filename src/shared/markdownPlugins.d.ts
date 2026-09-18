declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'
  const install: (markdown: InstanceType<typeof MarkdownIt>) => void
  export default install
}

declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it'
  const install: (markdown: InstanceType<typeof MarkdownIt>) => void
  export default install
}
