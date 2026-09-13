import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown.ts'
import { isImeKeyboardEvent } from '../src/renderer/src/utils/imeKeyboard.ts'
import { READING_POSITIONS_KEY, readDocumentPosition, saveDocumentPosition } from '../src/renderer/src/utils/documentReadingPosition.ts'

test('IME guard covers native composition, lifecycle state and legacy 229 without swallowing ordinary keys', () => {
  assert.equal(isImeKeyboardEvent({ isComposing: true, keyCode: 13 }), true)
  assert.equal(isImeKeyboardEvent({ isComposing: false, keyCode: 229 }), true)
  assert.equal(isImeKeyboardEvent({ keyCode: 8 }, true), true)
  assert.equal(isImeKeyboardEvent({ isComposing: false, keyCode: 13 }), false)
})

test('draft export uses the current title and block structure independently of the saved path', () => {
  assert.deepEqual(buildDraftMarkdownExport({ title: ' 新标题 ', path: 'Home/旧标题', blocks: [
    { type: 'heading-2', content: '新章节', checked: false, depth: 0 },
    { type: 'todo', content: '新待办', checked: true, depth: 0 }
  ] }), { fileName: '新标题.md', markdown: '# 新标题\n\n## 新章节\n\n- [x] 新待办' })
  assert.deepEqual(buildDraftMarkdownExport({ title: ' ', blocks: [] }), { fileName: 'Untitled.md', markdown: '# Untitled\n' })
})

test('reading positions retain stable block IDs, isolate documents and evict old entries', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  for (let index = 0; index < 105; index++) {
    saveDocumentPosition(`document-${index}`, { blockId: `block-${index}`, offset: -24, scrollTop: 1200, updatedAt: index }, storage)
  }
  assert.equal(readDocumentPosition('document-0', storage), null)
  assert.equal(readDocumentPosition('document-104', storage)?.blockId, 'block-104')
  saveDocumentPosition('document-10', { blockId: 'moved-block', offset: 0, scrollTop: 450, updatedAt: 200 }, storage)
  assert.equal(JSON.parse(values.get(READING_POSITIONS_KEY)!).length, 100)
  assert.equal(readDocumentPosition('document-10', storage)?.blockId, 'moved-block')
})

test('reading tolerates corrupted, invalid and unavailable local storage', () => {
  let value = '{broken'
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next } }
  assert.equal(readDocumentPosition('doc', storage), null)
  saveDocumentPosition('doc', { blockId: 'block', offset: -10, scrollTop: 200, updatedAt: 1 }, storage)
  assert.equal(readDocumentPosition('doc', storage)?.blockId, 'block')
  value = JSON.stringify([['doc', { blockId: 'block', offset: null, scrollTop: -1, updatedAt: 1 }], null])
  assert.equal(readDocumentPosition('doc', storage), null)
  const denied = { getItem: (): string => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
  assert.equal(readDocumentPosition('doc', denied), null)
  assert.doesNotThrow(() => saveDocumentPosition('doc', { blockId: null, offset: 0, scrollTop: 0, updatedAt: 1 }, denied))
})
