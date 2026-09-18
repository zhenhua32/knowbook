/// <reference types="vite/client" />
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { MathBlockPreview } from '../src/renderer/src/components/MathBlockPreview.tsx'
import { AdvancedMarkdownNode } from '../src/renderer/src/components/AdvancedMarkdownNode.tsx'
import { MarkdownDocumentContext } from '../src/renderer/src/components/MarkdownDocumentContext.tsx'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument.ts'
import { parseMarkdownBlocks } from '../src/shared/markdown.ts'
import { markdownEngine, markdownTokenTree, type MarkdownNode } from '../src/shared/markdownEngine.ts'

test('math renders accessible inline and display forms and retains invalid source with a visible error', () => {
  const inline = renderToStaticMarkup(<MathBlockPreview expression="x^2" label="Inline math" displayMode={false} />)
  const block = renderToStaticMarkup(<MathBlockPreview expression="x^2" label="Display math" />)
  assert.match(inline, /<span[^>]*role="math"/)
  assert.match(inline, /<math /)
  assert.doesNotMatch(inline, /katex-display/)
  assert.match(block, /katex-display/)
  const invalid = renderToStaticMarkup(<MathBlockPreview expression={'\\invalid{x}'} label="Math" />)
  assert.match(invalid, /Math error:/)
  assert.match(invalid, /\\invalid\{x\}/)
  const unsafe = renderToStaticMarkup(<MathBlockPreview expression={'\\href{javascript:alert(1)}{click}'} label="Math" />)
  assert.doesNotMatch(unsafe, /href="javascript:|<script/)
})

test('callout headings and collapsed state render through semantic details/summary', () => {
  const nodes = markdownTokenTree(markdownEngine.parse('> [!warning]- Read **first**\n> Body', {}))
  const html = renderToStaticMarkup(<AdvancedMarkdownNode node={nodes[0]} options={{}} />)
  const dom = new JSDOM(html)
  try {
    assert.equal(dom.window.document.querySelector('details')?.open, false)
    assert.equal(dom.window.document.querySelector('summary strong')?.textContent, 'first')
    assert.equal(dom.window.document.querySelector('.markdown-callout-body')?.textContent, 'Body')
  } finally { dom.window.close() }
})

test('footnote controls expose unique reference targets and descriptive backref labels', () => {
  const model = parseMarkdownDocumentBlocks(parseMarkdownBlocks('First[^n] and again[^n].\n\n[^n]: Note.'))
  const nodes: MarkdownNode[] = []
  const visit = (items: MarkdownNode[]) => { for (const item of items) { if (['footnote_ref', 'footnote_anchor'].includes(item.token.type)) nodes.push(item); visit(item.children) } }
  model.blockNodes.forEach(visit)
  visit(model.footnotes)
  const html = renderToStaticMarkup(<>{nodes.map((node, index) => <AdvancedMarkdownNode key={index} node={node} options={{}} />)}</>)
  const dom = new JSDOM(html)
  try {
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('sup button'), (button) => button.id), ['fn-0-ref-0', 'fn-0-ref-1'])
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.markdown-footnote-backref'), (button) => button.getAttribute('aria-label')), ['Back to footnote reference 1.1', 'Back to footnote reference 1.2'])
  } finally { dom.window.close() }
})

test('TOC renders document-scoped headings without parsing them a second time', () => {
  const model = parseMarkdownDocumentBlocks(parseMarkdownBlocks('[TOC]\n\n# One\n\n## Two'))
  const html = renderToStaticMarkup(<MarkdownDocumentContext.Provider value={{ model, isZh: false, footnoteId: () => '', navigateFootnote: () => {} }}>
    <AdvancedMarkdownNode node={model.blockNodes[0][0]} options={{}} />
  </MarkdownDocumentContext.Provider>)
  const dom = new JSDOM(html)
  try { assert.deepEqual(Array.from(dom.window.document.querySelectorAll('nav button'), (button) => button.textContent), ['One', 'Two']) }
  finally { dom.window.close() }
})
