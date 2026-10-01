import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { LinkSuggestionPanel } from '../src/renderer/src/components/LinkSuggestionPanel'

const base: ComponentProps<typeof LinkSuggestionPanel> = {
  query: 'current query', blockSuggestions: [], linkSuggestions: [], blocksLabel: 'Current blocks',
  linkedDocsLabel: 'Documents', titleLabel: 'Link suggestions', queryLabel: query => `Query: ${query}`,
  noMatchingLabel: 'No suggestions matched', loadingLabel: 'Finding documents', retryLabel: 'Retry',
  onSelectBlockSuggestion: () => {}, onSelectLinkSuggestion: () => {}, onRetry: () => {}
}

function markup(props: Partial<typeof base>, run: (document: Document) => void) {
  const dom = new JSDOM(renderToStaticMarkup(createElement(LinkSuggestionPanel, { ...base, ...props })))
  try { run(dom.window.document) } finally { dom.window.close() }
}

test('pending link lookup announces loading rather than a premature empty result', () => {
  markup({ linkSuggestionsLoading: true }, document => {
    assert.equal(document.querySelector('[role=status]')?.textContent, 'Finding documents')
    assert.equal(document.querySelector('.empty-text'), null)
    assert.equal(document.querySelector('[role=alert]'), null)
  })
})

test('remote lookup keeps local block choices available during loading and failure', () => {
  const block = { id: 'local', type: 'paragraph' as const, content: 'current query in a local block', checked: false, depth: 0 }
  for (const state of [{ linkSuggestionsLoading: true }, { linkSuggestionsError: 'Document lookup failed' }]) {
    markup({ blockSuggestions: [block], ...state }, document => {
      assert.equal(document.querySelector('.relation-chip')?.textContent?.includes(block.content), true)
      assert.equal(document.querySelector('.relation-chip')?.hasAttribute('disabled'), false)
      assert.equal(document.querySelector('.empty-text'), null)
    })
  }
})

test('failed link lookup exposes a named retry action that can be the keyboard candidate', () => {
  markup({ linkSuggestionsError: 'Document lookup failed', activeSuggestionKey: 'retry' }, document => {
    assert.equal(document.querySelector('[role=alert]')?.textContent, 'Document lookup failed')
    const retry = document.querySelector<HTMLButtonElement>('.link-suggestions-retry')!
    assert.equal(retry.textContent, 'Retry')
    assert.equal(retry.type, 'button')
    assert.equal(retry.getAttribute('aria-current'), 'true')
    assert.equal(document.querySelector('[role=status]'), null)
    assert.equal(document.querySelector('.empty-text'), null)
  })
})

test('completed empty lookup shows the empty result without loading or error feedback', () => {
  markup({}, document => {
    assert.equal(document.querySelector('.empty-text')?.textContent, 'No suggestions matched')
    assert.equal(document.querySelector('[role=status]'), null)
    assert.equal(document.querySelector('[role=alert]'), null)
    assert.equal(document.querySelector('.link-suggestions-retry'), null)
  })
})
