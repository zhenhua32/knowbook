import { useMemo } from 'react'
import katex from 'katex'

type MathBlockPreviewProps = {
  expression: string
  label: string
}

export function MathBlockPreview({ expression, label }: MathBlockPreviewProps) {
  const rendered = useMemo(() => katex.renderToString(expression, {
    displayMode: true,
    output: 'htmlAndMathml',
    strict: 'ignore',
    throwOnError: false
  }), [expression])

  return (
    <div
      aria-label={label}
      className="block-math-preview"
      dangerouslySetInnerHTML={{ __html: rendered }}
      role="math"
    />
  )
}
