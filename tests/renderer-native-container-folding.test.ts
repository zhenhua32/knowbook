import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { applyDocumentToggleDefaults, buildDocumentSections, findDocumentSection, getVisibleDocumentEntries, readDocumentFoldView, revealDocumentBlock, saveDocumentFoldView } from '../src/renderer/src/utils/documentSections'

const block = (id: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft => ({ id, type, depth, parentBlockId, content: id, checked: false })
const emptyView = () => ({ collapsedIds: new Set<string>(), focusedHeadingId: null })

test('author defaults and explicit personal toggle preferences remain separate across reload and default changes', () => {
  const blocks = [block('toggle', 'toggle'), block('child', 'paragraph', 1, 'toggle'), block('outside')]
  blocks[0].markdownFormat = { toggleDefaultOpen: false }
  const defaults = applyDocumentToggleDefaults(blocks, emptyView())
  assert.deepEqual(getVisibleDocumentEntries(blocks, defaults).map(entry => entry.block.id), ['toggle', 'outside'])
  assert.equal(defaults.toggleOpenOverrides, undefined)
  let serialized = ''
  const storage = { getItem: () => serialized || null, setItem: (_key: string, value: string) => { serialized = value } }
  saveDocumentFoldView('one', defaults, storage)
  blocks[0].markdownFormat = { toggleDefaultOpen: true }
  assert.equal(getVisibleDocumentEntries(blocks, readDocumentFoldView('one', storage)).length, 3, 'a previously displayed default is not a user override')
  const personal = { ...defaults, toggleOpenOverrides: new Map([['toggle', false]]) }
  saveDocumentFoldView('one', personal, storage)
  assert.equal(getVisibleDocumentEntries(blocks, readDocumentFoldView('one', storage)).length, 2)
  assert.deepEqual(blocks[0].markdownFormat, { toggleDefaultOpen: true }, 'personal folding does not modify author metadata')
  assert.equal(getVisibleDocumentEntries(blocks, readDocumentFoldView('two', storage)).length, 3, 'another document starts with its authored state')
  blocks[0].markdownFormat = undefined
  assert.equal(getVisibleDocumentEntries(blocks, emptyView()).length, 3, 'missing authored setting means open')
})

test('folding a toggle hides its complete mixed subtree and navigation reveals nested toggle ancestors without changing data', () => {
  const blocks = [block('outer', 'toggle'), block('callout', 'callout', 1, 'outer'), block('code', 'code', 2, 'callout'),
    block('inner', 'toggle', 1, 'outer'), block('task', 'todo', 2, 'inner'), block('image', 'paragraph', 2, 'inner'), block('outside')]
  blocks[0].markdownFormat = blocks[3].markdownFormat = { toggleDefaultOpen: false }
  const frozen = structuredClone(blocks)
  const view = applyDocumentToggleDefaults(blocks, emptyView())
  assert.deepEqual(getVisibleDocumentEntries(blocks, view).map(entry => entry.block.id), ['outer', 'outside'])
  const revealed = revealDocumentBlock(blocks, view, 'task')
  assert.deepEqual([...revealed.toggleOpenOverrides!], [['inner', true], ['outer', true]])
  assert.deepEqual(getVisibleDocumentEntries(blocks, revealed).map(entry => entry.block.id), blocks.map(value => value.id))
  assert.deepEqual(blocks, frozen)
  assert.deepEqual([...view.collapsedIds], ['outer', 'inner'])
})

test('a heading inside a native container ends at its physical subtree and cannot fold the following outer content', () => {
  const blocks = [block('chapter', 'heading-1'), block('toggle', 'toggle'), block('inner-heading', 'heading-1', 1, 'toggle'),
    block('inner-body', 'paragraph', 1, 'toggle'), block('outer-body'), block('next', 'heading-1'), block('next-body')]
  const sections = buildDocumentSections(blocks)
  assert.deepEqual(sections, [
    { id: 'chapter', index: 0, end: 5, level: 1, parentId: null },
    { id: 'inner-heading', index: 2, end: 4, level: 1, parentId: null },
    { id: 'next', index: 5, end: 7, level: 1, parentId: null }
  ])
  assert.equal(findDocumentSection(sections, 4)?.id, 'chapter')
  assert.deepEqual(getVisibleDocumentEntries(blocks, { ...emptyView(), collapsedIds: new Set(['inner-heading']) }).map(entry => entry.block.id),
    ['chapter', 'toggle', 'inner-heading', 'outer-body', 'next', 'next-body'])
  assert.deepEqual(getVisibleDocumentEntries(blocks, { ...emptyView(), collapsedIds: new Set(['chapter']) }).map(entry => entry.block.id), ['chapter', 'next', 'next-body'])
})
