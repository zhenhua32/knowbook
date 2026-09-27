import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentMarkdown } from '../src/shared/attachments'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'
import { insertAttachmentBlocks } from '../src/renderer/src/utils/attachments'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const file = { name: '图 [1]*.png', url: 'file:///assets/image.png', size: 12, kind: 'image' as const }
const blocks: DocumentBlockDraft[] = [{ id: 'first', type: 'paragraph', content: 'before selected after', checked: false, depth: 0, tags: ['keep'], highlight: 'yellow' }]

test('attachment insertion replaces the captured selection while retaining the block identity and metadata', () => {
  const target = { blockId: 'first', content: blocks[0].content, start: 7, end: 15 }
  const result = insertAttachmentBlocks(blocks, [file], target)
  assert.equal(result[0].content, 'before ' + attachmentMarkdown(file) + ' after')
  assert.equal(result[0].id, 'first'); assert.deepEqual(result[0].tags, ['keep']); assert.equal(result[0].highlight, 'yellow')
  assert.equal(collectMarkdownDestinations(result[0].content)[0].url, file.url)
  assert.equal(blocks[0].content, 'before selected after')
  assert.throws(() => insertAttachmentBlocks([{ ...blocks[0], content: 'new text' }], [file], target), /changed/)
  assert.throws(() => insertAttachmentBlocks([], [file], target), /changed/)
})

test('attachments append as paragraphs and insert outside code without rewriting its source', () => {
  const code = [{ ...blocks[0], type: 'code', language: 'ts' }]
  const result = insertAttachmentBlocks(code, [file], { blockId: 'first', content: code[0].content, start: 0, end: 0 })
  assert.deepEqual(result[0], code[0]); assert.equal(result[1].type, 'paragraph'); assert.ok(result[1].id)
  const appended = insertAttachmentBlocks(blocks, [file, { ...file, kind: 'file', name: 'report.pdf' }])
  assert.equal(appended.length, 3)
  assert.equal(appended[1].content.startsWith('!['), true)
  assert.equal(appended[2].content.startsWith('['), true)
})
