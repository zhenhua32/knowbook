import { useContext, useMemo } from 'react'
import katex from 'katex'
import { MarkdownDocumentContext } from './MarkdownDocumentContext'

type MathBlockPreviewProps = {
  expression: string
  label: string
  displayMode?: boolean
}

export function MathBlockPreview({ expression, label, displayMode = true }: MathBlockPreviewProps) {
  const { isZh } = useContext(MarkdownDocumentContext)
  const rendered = useMemo(() => {
    try {
      return { html: katex.renderToString(expression, {
        displayMode, output: 'htmlAndMathml', strict: 'ignore', throwOnError: true,
        trust: false, maxExpand: 1000, maxSize: 100
      }) }
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }, [expression, displayMode])
  const Element = displayMode ? 'div' : 'span'
  if (rendered.error) return <Element className="markdown-render-error" title={rendered.error}>
    <span>{isZh ? '公式错误：' : 'Math error: '}</span><code>{expression}</code>
  </Element>

  return (
    <Element
      aria-label={label}
      className={displayMode ? 'block-math-preview' : 'markdown-inline-math'}
      dangerouslySetInnerHTML={{ __html: rendered.html! }}
      role="math"
    />
  )
}
