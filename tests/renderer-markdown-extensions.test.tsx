import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { MarkdownContent, MarkdownReferencesContext } from '../src/renderer/src/components/MarkdownContent.tsx'
import { MarkdownTablePreview } from '../src/renderer/src/components/MarkdownTablePreview.tsx'
import { collectMarkdownReferences } from '../src/shared/markdownEngine.ts'
import { renderMarkdownTableHtml } from '../src/shared/markdownTable.ts'

test('table preview preserves parsed cell content, alignment and reference styles', () => {
  const source = 'Name | State | Detail\n:- | :-: | -:\n[**Guide**][ref] | ~old~ | `a\\|b`\n![Logo][img] | [x] text | ~~**gone**~~\nshort\n1 | 2 | 3 | ignored'
  const references = collectMarkdownReferences('[ref]: https://example.com "Guide"\n[img]: https://example.com/logo.png')
  const html = renderToStaticMarkup(<MarkdownReferencesContext.Provider value={references}>
    <MarkdownTablePreview content={source} label="Table" />
  </MarkdownReferencesContext.Provider>)
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    assert.equal(doc.querySelectorAll('th').length, 3)
    assert.equal(doc.querySelectorAll('td').length, 12)
    assert.deepEqual(Array.from(doc.querySelectorAll('th'), (cell) => cell.style.textAlign), ['left', 'center', 'right'])
    assert.equal(doc.querySelector('td button strong')?.textContent, 'Guide')
    assert.equal(doc.querySelector('code')?.textContent, 'a|b')
    assert.equal(doc.querySelector('del strong')?.textContent, 'gone')
    assert.equal(doc.querySelector('img')?.getAttribute('src'), 'https://example.com/logo.png')
    assert.equal(doc.querySelectorAll('input').length, 0)
    assert.equal(doc.body.textContent?.includes('ignored'), false)
    assert.match(renderMarkdownTableHtml(source, { references })!, /<del>old<\/del>/)
  } finally { dom.window.close() }
  const empty = renderToStaticMarkup(<MarkdownTablePreview content={'| A | B |\n| - | - |'} label="Empty" />)
  assert.doesNotMatch(empty, /<tbody/)
})

test('task checkbox tokens distinguish escaped text and work in nested ordered lists', () => {
  const html = renderToStaticMarkup(<MarkdownContent content={'> 3. [X] ~~Done~~\n>    - [ ] Child\n> 4. \\[x] Literal\n> 5. &#91;x] Entity\n> 6. `[x]` Code\n> 7. [x]joined'} />)
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    assert.equal(doc.querySelector('ol')?.start, 3)
    assert.equal(doc.querySelectorAll('input').length, 2)
    assert.equal(doc.querySelector<HTMLInputElement>('input')?.checked, true)
    assert.equal(doc.querySelectorAll('input:disabled').length, 2)
    assert.equal(doc.querySelector('del')?.textContent, 'Done')
    assert.match(doc.body.textContent!, /\[x\] Literal/)
    assert.match(doc.body.textContent!, /\[x\] Entity/)
  } finally { dom.window.close() }
})
