/// <reference types="vite/client" />
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockReadingRow } from '../src/renderer/src/components/BlockReadingRow.tsx'
import { getActiveUiText } from '../src/renderer/src/i18n.ts'

function render(content: string, type = 'paragraph') {
  return renderToStaticMarkup(<BlockReadingRow block={{ id: 'block', type, content, checked: false, depth: 0 }}
    index={0} indentPx={0} numberLabel="" isHighlighted={false} hasChildren={false} collapsed={false}
    onToggleCollapse={() => {}} onNavigateReference={() => {}} ui={getActiveUiText()} isZh />)
}

test('reading renders formatting without edit controls and preserves unsafe markup as text', () => {
  const html = render('**结论** <script>alert(1)</script> [不安全](javascript:alert) [[章节]]')
  assert.match(html, /<strong>结论<\/strong>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /\[不安全\]\(javascript:alert\)/)
  assert.match(html, /<button[^>]+inline-link[^>]*>章节<\/button>/)
  assert.doesNotMatch(html, /<textarea|<script|href="javascript:/)
})

test('reading keeps invalid table source and displays valid image markup only as a preview', () => {
  assert.match(render('还没写完的表格', 'table'), /<pre>还没写完的表格<\/pre>/)
  const image = render('说明 ![示意](https://example.com/image.png)')
  assert.match(image, /<img/)
  assert.doesNotMatch(image, /!\[示意\]/)
  const code = render('`[literal](https://example.com)`')
  assert.match(code, /<code[^>]*>\[literal\]\(https:\/\/example.com\)<\/code>/)
})
