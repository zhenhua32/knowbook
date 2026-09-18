import { useContext, useEffect, useState } from 'react'
import mermaid from 'mermaid'
import { MarkdownDocumentContext } from './MarkdownDocumentContext'

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
  htmlLabels: false, theme: 'neutral', maxTextSize: 50000, maxEdges: 500,
  secure: ['securityLevel', 'startOnLoad', 'suppressErrorRendering', 'htmlLabels', 'flowchart', 'theme', 'themeCSS', 'themeVariables', 'maxTextSize', 'maxEdges', 'secure'],
  flowchart: { htmlLabels: false }
})
let nextDiagram = 0

export function MermaidPreview({ source, label }: { source: string; label: string }) {
  const { isZh } = useContext(MarkdownDocumentContext)
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string }>()
  useEffect(() => {
    let cancelled = false
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
    host.setAttribute('aria-hidden', 'true')
    document.body.append(host)
    // Debounce source typing; successful SVGs are displayed as isolated images.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (source.length > 50000) throw new Error(isZh ? '图表超过 50000 字符。' : 'Diagram exceeds 50000 characters.')
          // Image nodes can fetch their dimensions while rendering. Keep diagrams
          // self-contained and preserve unsupported input for editing/export.
          if (/\bimg\s*:|<img\b/i.test(source)) throw new Error(isZh ? '图表中的外部图片暂不支持。' : 'External images inside diagrams are not supported.')
          const rendered = await mermaid.render(`knowbook-mermaid-${++nextDiagram}`, source, host)
          const xml = new DOMParser().parseFromString(rendered.svg, 'image/svg+xml')
          xml.querySelectorAll('script, foreignObject, image').forEach((element) => element.remove())
          xml.querySelectorAll('*').forEach((element) => {
            for (const attribute of Array.from(element.attributes)) {
              if (/^on/i.test(attribute.name) || (/^(?:xlink:)?href$/i.test(attribute.name) && !attribute.value.startsWith('#'))) element.removeAttribute(attribute.name)
            }
          })
          const svg = new XMLSerializer().serializeToString(xml.documentElement)
          if (!cancelled) setResult({ source, svg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` })
        } catch (error) {
          if (!cancelled) setResult({ source, error: error instanceof Error ? error.message : String(error) })
        } finally { host.remove() }
      })()
    }, 180)
    return () => { cancelled = true; clearTimeout(timer); host.remove() }
  }, [source, isZh])
  const current = result?.source === source ? result : undefined
  return <figure className="markdown-mermaid" aria-label={label}>
    {current?.svg ? <img src={current.svg} alt={label} /> : <>
      {current?.error ? <p className="markdown-render-error" role="status">{isZh ? '图表错误：' : 'Diagram error: '}{current.error}</p>
        : <p role="status">{isZh ? '正在绘制图表…' : 'Rendering diagram…'}</p>}
      <pre><code>{source}</code></pre>
    </>}
  </figure>
}
