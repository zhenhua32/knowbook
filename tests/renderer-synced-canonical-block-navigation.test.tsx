import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { MarkdownContent } from '../src/renderer/src/components/MarkdownContent'
import { extractBlockRichMedia } from '../src/renderer/src/utils/blockRichMedia'
import { formatSyncedCanonicalBlockAddress } from '../src/shared/synced-canonical-block-address'

test('canonical block Markdown and Wiki destinations use internal buttons and never become external media', () => {
  const address = formatSyncedCanonicalBlockAddress({ groupId: 'b9321264-877d-4c85-8a92-7cab957f1c53',
    creationId: 'b5912708-76c9-4dcf-b297-7bff97e69fd4', groupCreatedAt: '2000-01-01T00:00:00.000Z',
    blockId: '块/?#', blockCreatedAt: '2000-01-01T00:00:01.000Z' })
  const content = `[Direct](${address}) [[${address}|别名]] [Reference][target]\n\n[target]: <${address}>`
  const markup = renderToStaticMarkup(<MarkdownContent content={content} onReference={() => {}} onNavigateLink={() => {}} />)
  const dom = new JSDOM(markup)
  try {
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('button'), button => [button.textContent, button.title]),
      [['Direct', address], ['别名', address], ['Reference', address]])
    assert.equal(dom.window.document.querySelector('a, img'), null)
  } finally { dom.window.close() }
  assert.equal(extractBlockRichMedia(content).links.length, 0)
  assert.deepEqual(extractBlockRichMedia(content, undefined, true).links, [{ label: 'Direct', url: address }])
})
