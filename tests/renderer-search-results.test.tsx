import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { SearchMatchText } from '../src/renderer/src/components/SearchMatchText'
import { searchResultDocumentLink } from '../src/renderer/src/utils/searchResultLink'
import { collectMarkdownSourceLinks, resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'

test('search highlighting treats metacharacters and HTML as text and handles Chinese and repeated terms', () => {
  const source = 'C++ <script>中文</script> c++ 中文'
  const dom = new JSDOM(renderToStaticMarkup(<SearchMatchText text={source} query="c++ 中文 c++" />))
  try {
    assert.equal(dom.window.document.body.textContent, source)
    assert.equal(dom.window.document.querySelector('script'), null)
    assert.deepEqual([...dom.window.document.querySelectorAll('mark')].map((mark) => mark.textContent), ['C++', '中文', 'c++', '中文'])
    assert.equal(renderToStaticMarkup(<SearchMatchText text="unchanged" query="  " />), 'unchanged')
  } finally { dom.window.close() }
})

test('copied document links resolve from any folder and escape Markdown and path delimiters', () => {
  const result = { documentId: 'doc', documentTitle: '[设计] C# (草稿) *v2*', documentPath: 'Home/[设计] C# (草稿) *v2*', matchType: 'block' as const, blockId: 'block', snippet: '' }
  const markdown = searchResultDocumentLink(result)
  const links = collectMarkdownSourceLinks(markdown)
  assert.equal(links.length, 1)
  for (const source of ['Home/Other', 'Another/Nested/Document']) {
    assert.deepEqual(resolveMarkdownDocumentPath(source, links[0].url), { path: result.documentPath, fragment: '' })
  }
})
