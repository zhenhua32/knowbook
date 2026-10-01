import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { BlockSearchPanel } from '../src/renderer/src/components/BlockSearchPanel'
import { findBlockSearchMatches } from '../src/renderer/src/utils/blockSearch'

type Props = ComponentProps<typeof BlockSearchPanel>
const propsFor = (query: string, items: Props['items']): Props => ({
  isOpen: true, query, items, placeholder: 'Find in document', noMatchText: 'No matching blocks',
  onQueryChange: () => {}, onSelect: () => {}, onClose: () => {}
})
const block = (content: string, type: DocumentBlockDraft['type'] = 'paragraph'): DocumentBlockDraft => ({
  type, content, checked: false, depth: 0
})

function withMarkup(query: string, items: Props['items'], run: (document: Document) => void) {
  const dom = new JSDOM(renderToStaticMarkup(createElement(BlockSearchPanel, propsFor(query, items))))
  try { run(dom.window.document) } finally { dom.window.close() }
}

test('preview highlighting is trimmed, case-insensitive and literal while preserving surrounding text and button content', () => {
  for (const [query, text, expected] of [
    ['  needle  ', 'before NeedLE between needle after', ['NeedLE', 'needle']],
    [' [a+b].* (x)? \\ $^ ', 'before [a+b].* (x)? \\ $^ and after', ['[a+b].* (x)? \\ $^']],
    [' beta ', 'İ before BETA after beta', ['BETA', 'beta']],
    [' İ ', 'before İ after İ', ['İ', 'İ']],
    ['\u0307i', 'İİİ', ['İİİ']],
    ['σ', 'İ ΟΣΣ tail', ['Σ']],
    [' 中文 ', '完整前文 中文 完整后文', ['中文']]
  ] as const) {
    withMarkup(query, [{ index: 8, type: 'paragraph', contentPreview: text }], document => {
      const preview = document.querySelector('.block-find-result-preview')!
      const result = document.querySelector<HTMLButtonElement>('.block-find-result')!
      assert.deepEqual([...preview.querySelectorAll('mark')].map(mark => mark.textContent), [...expected])
      assert.equal(preview.textContent, text, 'Highlighting must not replace or lose any preview text')
      assert.equal(result.textContent, `9${text}`)
      assert.equal(result.type, 'button')
      assert.equal(result.hasAttribute('aria-label'), false, 'The existing full text remains the button name')
      assert.equal(preview.querySelectorAll('a, button, input').length, 0)
    })
  }
})

test('HTML and script-looking preview text stays literal even where it is highlighted', () => {
  const text = '<script>window.__previewRan = true</script><img src=x onerror=alert(1)> & tail'
  withMarkup('script', [{ index: 0, type: 'paragraph', contentPreview: text }], document => {
    const preview = document.querySelector('.block-find-result-preview')!
    assert.equal(preview.textContent, text)
    assert.deepEqual([...preview.querySelectorAll('mark')].map(mark => mark.textContent), ['script', 'script'])
    assert.equal(document.querySelectorAll('script, img, [onerror]').length, 0)
    assert.equal(Reflect.has(document.defaultView!, '__previewRan'), false)
  })
})

test('unmatched, type-only and whitespace queries never create a false text highlight', () => {
  const text = '完整正文没有查询词'
  const typeMatches = findBlockSearchMatches([block(text, 'code')], ' CODE ')
  assert.equal(typeMatches.length, 1)
  for (const [query, items] of [
    ['missing', [{ index: 0, type: 'paragraph', contentPreview: text }]],
    [' CODE ', typeMatches],
    [' \t ', [{ index: 0, type: 'paragraph', contentPreview: text }]]
  ] as const) {
    withMarkup(query, [...items], document => {
      assert.equal(document.querySelectorAll('mark').length, 0)
      assert.equal(document.querySelector('.block-find-result-preview')?.textContent, text)
    })
  }
  withMarkup('', [{ index: 0, type: 'paragraph', contentPreview: text }], document => {
    assert.equal(document.querySelectorAll('.block-find-result, mark').length, 0)
  })
})

test('a long literal query searches the complete block but caps its excerpt and marks the visible part of the real match', () => {
  const query = 'Z'.repeat(500), prefix = 'lead '.repeat(30)
  const content = `${prefix}${query} trailing context`
  const draft = block(content)
  const matches = findBlockSearchMatches([draft], query)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].index, 0)
  assert.equal(matches[0].contentPreview, `…${content.slice(prefix.length - 36, prefix.length - 36 + 120)}…`)
  assert.equal(matches[0].contentPreview.length, 122, 'Only the display excerpt is capped; ellipses are additional')
  assert.equal(draft.content, content)
  assert.deepEqual(findBlockSearchMatches([draft], `${query}!`), [], 'The full query must still match, not only its visible prefix')
  withMarkup(query, matches, document => {
    const preview = document.querySelector('.block-find-result-preview')!
    assert.equal(preview.textContent, matches[0].contentPreview)
    assert.deepEqual([...preview.querySelectorAll('mark')].map(mark => mark.textContent), ['Z'.repeat(84)])
  })
  const emojiQuery = '😀'.repeat(80)
  for (const [emojiContent, visibleCount] of [
    [`${'A'.repeat(35)}${emojiQuery} trailing`, 42],
    [`${'😀'.repeat(18)}A${emojiQuery}`, 41]
  ] as const) {
    const emojiDraft = block(emojiContent)
    const emojiMatches = findBlockSearchMatches([emojiDraft], emojiQuery)
    assert.equal(emojiMatches.length, 1)
    assert.equal(emojiDraft.content, emojiContent)
    assert.equal(emojiMatches[0].contentPreview, `${emojiContent.slice(0, 119)}…`)
    const excerpt = emojiMatches[0].contentPreview.slice(0, -1)
    assert.ok(excerpt.length <= 120)
    assert.doesNotMatch(excerpt, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    withMarkup(emojiQuery, emojiMatches, document => {
      const preview = document.querySelector('.block-find-result-preview')!
      const marks = [...preview.querySelectorAll('mark')].map(mark => mark.textContent!)
      assert.equal(preview.textContent, emojiMatches[0].contentPreview)
      assert.deepEqual(marks, ['😀'.repeat(visibleCount)])
      assert.doesNotMatch(marks[0], /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    })
  }
})

test('lowercase expansion before a late hit cannot move its raw excerpt or highlighted characters', () => {
  const content = `${'İ'.repeat(100)} BETA trailing context`
  const matches = findBlockSearchMatches([block(content)], ' beta ')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].contentPreview, `…${content.slice(101 - 36)}`)
  withMarkup(' beta ', matches, document => {
    const preview = document.querySelector('.block-find-result-preview')!
    assert.equal(preview.textContent, matches[0].contentPreview)
    assert.deepEqual([...preview.querySelectorAll('mark')].map(mark => mark.textContent), ['BETA'])
  })
})

test('highlighted result text stays inside the original button and retains click, input navigation and IME behavior', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const selected: number[] = []
  const items = [4, 17, 91].map(index => ({ index, type: 'paragraph', contentPreview: `before Needle after ${index}` }))
  const props = { ...propsFor('needle', items), onSelect: (index: number) => { selected.push(index) } }
  const document = dom.window.document
  const key = async (target: HTMLElement, value: string) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    await act(async () => target.dispatchEvent(event))
    return event
  }
  try {
    await act(async () => root.render(createElement(BlockSearchPanel, props)))
    const input = document.querySelector<HTMLInputElement>('.block-find-input')!
    const result = document.querySelectorAll<HTMLButtonElement>('.block-find-result')[2]!
    const mark = result.querySelector('mark')!
    assert.ok(mark)
    assert.equal(mark.closest('button') === result, true)
    await act(async () => mark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(selected, [91])
    assert.equal(document.activeElement === input, true)
    assert.equal(document.querySelector('.block-find-count')?.textContent, '3 / 3')
    await act(async () => result.focus())
    assert.equal((await key(result, 'Enter')).defaultPrevented, false)
    assert.deepEqual(selected, [91], 'Synthetic keydown cannot stand in for native button activation')
    await act(async () => input.focus())
    await act(async () => input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal((await key(input, 'Enter')).defaultPrevented, false)
    assert.deepEqual(selected, [91])
    await act(async () => input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.equal((await key(input, 'Enter')).defaultPrevented, true)
    assert.deepEqual(selected, [91, 4])
    assert.equal(document.activeElement === input, true)
    assert.equal(input.value, 'needle')
    assert.equal(document.querySelector('.block-find-count')?.textContent, '1 / 3')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
