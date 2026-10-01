import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import type { SyncDocument } from '../src/main/sync/model'
import { mergeSyncDocument } from '../src/main/sync/merge'

function block(id: string, content: string, overrides: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft {
  return { id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, tags: [], ...overrides }
}
function document(blocks = [block('first', '原始正文')]): SyncDocument {
  return { kind: 'document', id: 'document', parentId: null, sortOrder: 0, createdAt: '2026-10-01T00:00:00.000Z',
    content: { title: '原始标题', summary: '原始摘要', blocks } }
}
const copy = <T>(value: T): T => structuredClone(value)
const body = (value: SyncDocument) => value.content.blocks.map(item => item.content)

test('independent title, summary, move and ordering edits merge without changing identities or inputs', () => {
  const base = document(), local = copy(base), remote = copy(base)
  local.content.title = '本地标题'; local.sortOrder = 2
  remote.content.summary = '远端摘要'; remote.parentId = 'folder'
  const original = copy([base, local, remote])
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.conflicts, []); assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.title, '本地标题'); assert.equal(merged.document.content.summary, '远端摘要')
  assert.equal(merged.document.parentId, 'folder'); assert.equal(merged.document.sortOrder, 2)
  assert.equal(merged.document.id, base.id); assert.equal(merged.document.content.blocks[0].id, 'first')
  assert.deepEqual([base, local, remote], original)
  merged.document.content.blocks[0].content = '变更预览不能改原始版本'
  assert.deepEqual([base, local, remote], original)
})

test('different blocks and independent properties of the same task preserve both edits', () => {
  const base = document([block('first', '准备', { type: 'todo' }), block('second', '原始备注')])
  const local = copy(base), remote = copy(base)
  local.content.blocks[0].checked = true; local.content.blocks[1].content = '本地备注'
  remote.content.blocks[0].content = '远端准备'; remote.content.blocks[0].highlight = 'blue'
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, [])
  assert.deepEqual(body(merged.document), ['远端准备', '本地备注'])
  assert.equal(merged.document.content.blocks[0].checked, true)
  assert.equal(merged.document.content.blocks[0].highlight, 'blue')
})

test('nonoverlapping edits within one block and a Markdown summary merge at Unicode grapheme boundaries', () => {
  const base = document([block('first', '甲👩🏽‍💻乙🙂丙')]), local = copy(base), remote = copy(base)
  base.content.summary = local.content.summary = remote.content.summary = 'left middle right'
  local.content.blocks[0].content = '新👩🏽‍💻乙🙂丙'; remote.content.blocks[0].content = '甲👩🏽‍💻乙🚀丙'
  local.content.summary = 'LEFT middle right'; remote.content.summary = 'left middle RIGHT'
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.blocks[0].content, '新👩🏽‍💻乙🚀丙')
  assert.equal(merged.document.content.summary, 'LEFT middle RIGHT')
})

test('multiple edits on one side combine with an independent edit on the other side', () => {
  const base = document([block('first', 'alpha middle beta gamma')]), local = copy(base), remote = copy(base)
  local.content.blocks[0].content = 'ALPHA middle beta GAMMA'
  remote.content.blocks[0].content = 'alpha MIDDLE beta gamma'
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.blocks[0].content, 'ALPHA MIDDLE beta GAMMA')
})

test('the same concurrent patch is applied once alongside independent patches', () => {
  const base = document([block('first', 'alpha middle omega')]), local = copy(base), remote = copy(base)
  local.content.blocks[0].content = 'ALPHA MIDDLE omega'
  remote.content.blocks[0].content = 'ALPHA middle OMEGA'
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.blocks[0].content, 'ALPHA MIDDLE OMEGA')
})

test('two edits to components of one composed emoji remain a conflict', () => {
  const base = document([block('first', '工作👩🏽‍💻完成')]), local = copy(base), remote = copy(base)
  local.content.blocks[0].content = '工作👨🏽‍💻完成'; remote.content.blocks[0].content = '工作👩🏿‍💻完成'
  const merged = mergeSyncDocument(base, local, remote)
  assert.equal(merged.unresolved[0]?.field, 'block-content')
  assert.equal(merged.document.content.blocks[0].content, local.content.blocks[0].content)
})

test('identical concurrent edits and single-sided block insertion are accepted without inventing conflicts', () => {
  const base = document(), local = copy(base), remote = copy(base)
  local.content.blocks.push(block('new', '新增块'))
  let merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, []); assert.equal(merged.document.content.blocks.length, 2)
  remote.content.blocks = copy(local.content.blocks)
  merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, []); assert.equal(merged.document.content.blocks.length, 2)
})

test('overlapping text edits stay unresolved until selected, retaining independent edits in the candidate', () => {
  const base = document([block('first', 'draft content'), block('second', 'other')]), local = copy(base), remote = copy(base)
  local.content.blocks[0].content = 'local content'; local.content.title = '本地改标题'
  remote.content.blocks[0].content = 'remote content'; remote.content.blocks[1].content = '远端改另一个块'
  const preview = mergeSyncDocument(base, local, remote)
  assert.equal(preview.unresolved.length, 1); assert.equal(preview.conflicts[0].id, 'block:first:content')
  assert.equal(preview.conflicts[0].basePreview, 'draft content'); assert.equal(preview.conflicts[0].canEditText, true)
  assert.equal(preview.document.content.title, '本地改标题')
  assert.deepEqual(body(preview.document), ['local content', '远端改另一个块'])
  const chosen = mergeSyncDocument(base, local, remote, { 'block:first:content': { choice: 'remote' } })
  assert.equal(chosen.conflicts.length, 1); assert.deepEqual(chosen.unresolved, [])
  assert.deepEqual(body(chosen.document), ['remote content', '远端改另一个块'])
})

test('custom text resolves only the selected conflict and preserves complete unsliced text', () => {
  const base = document(), local = copy(base), remote = copy(base)
  local.content.title = '本地'; remote.content.title = '远端'
  local.content.blocks[0].content = '本地正文'; remote.content.blocks[0].content = '远端正文'
  const merged = mergeSyncDocument(base, local, remote, {
    title: { choice: 'custom', text: '  合并标题  ' },
    'block:first:content': { choice: 'custom', text: '保留双方\n本地正文\n远端正文' }
  })
  assert.equal(merged.conflicts.length, 2); assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.title, '合并标题')
  assert.equal(merged.document.content.blocks[0].content, '保留双方\n本地正文\n远端正文')
})

test('invalid custom titles and custom structural choices never resolve a conflict', () => {
  const base = document(), local = copy(base), remote = copy(base)
  local.content.title = '本地'; remote.content.title = '远端'
  local.parentId = 'local-parent'; remote.parentId = 'remote-parent'
  for (const title of ['', '..', '坏/标题', '坏\\标题', '坏\n标题', '长'.repeat(501)]) {
    const merged = mergeSyncDocument(base, local, remote, { title: { choice: 'custom', text: title }, parentId: { choice: 'custom', text: 'arbitrary' } })
    assert.deepEqual(merged.unresolved.map(part => part.id), ['title', 'parentId'])
    assert.equal(merged.document.parentId, 'local-parent')
  }
})

test('concurrent insertion at the same location and repeated ambiguous text remain conflicts', () => {
  for (const [before, left, right] of [['ab', 'aXb', 'aYb'], ['aaa', 'aaaa', 'baa'], ['ababa', 'babab', 'aBaba']]) {
    const base = document([block('first', before)]), local = copy(base), remote = copy(base)
    local.content.blocks[0].content = left; remote.content.blocks[0].content = right
    assert.equal(mergeSyncDocument(base, local, remote).unresolved[0]?.field, 'block-content')
  }
})

test('different changes within one Markdown destination or attachment identity cannot synthesize a new target', () => {
  for (const before of ['[目标](https://example.com/abcd)', `![图片](knowbook-asset://${'a'.repeat(64)}/image.png)`,
    `knowbook-asset://${'a'.repeat(64)}/image.png`, '[[文档甲乙|标签]]', '[id]: https://example.com/abcd']) {
    const base = document([block('first', before)]), local = copy(base), remote = copy(base)
    if (before.includes('甲乙')) {
      local.content.blocks[0].content = before.replace('甲', '新')
      remote.content.blocks[0].content = before.replace('乙', '改')
    } else if (before.includes('knowbook-asset')) {
      local.content.blocks[0].content = before.replace('a'.repeat(64), `b${'a'.repeat(63)}`)
      remote.content.blocks[0].content = before.replace('a'.repeat(64), `${'a'.repeat(63)}c`)
    } else {
      local.content.blocks[0].content = before.replace('abcd', 'Xbcd')
      remote.content.blocks[0].content = before.replace('abcd', 'abcY')
    }
    assert.equal(mergeSyncDocument(base, local, remote).unresolved[0]?.field, 'block-content', before)
  }
})

test('a changed attachment and a changed label merge while keeping the attachment URL intact', () => {
  const original = `knowbook-asset://${'a'.repeat(64)}/image.png`, updated = `knowbook-asset://${'b'.repeat(64)}/image.png`
  const base = document([block('first', `![图片](${original})`)]), local = copy(base), remote = copy(base)
  local.content.blocks[0].content = `![图片](${updated})`; remote.content.blocks[0].content = `![新图片](${original})`
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, [])
  assert.equal(merged.document.content.blocks[0].content, `![新图片](${updated})`)
})

test('concurrent body structure changes produce one atomic body choice rather than mixing tree or type fields', () => {
  const base = document([block('first', 'task', { type: 'todo' }), block('second', 'tail')])
  const scenarios: Array<(local: SyncDocument, remote: SyncDocument) => void> = [
    (local, remote) => { local.content.blocks[0].type = 'paragraph'; remote.content.blocks[0].checked = true },
    (local, remote) => { local.content.blocks.reverse(); remote.content.blocks[0].content = 'changed' },
    (local, remote) => { local.content.blocks.pop(); remote.content.blocks[1].content = 'changed' },
    (local, remote) => { local.content.blocks.push(block('local-new', 'local')); remote.content.blocks.push(block('remote-new', 'remote')) }
  ]
  for (const change of scenarios) {
    const local = copy(base), remote = copy(base); change(local, remote)
    const preview = mergeSyncDocument(base, local, remote)
    assert.deepEqual(preview.conflicts.map(part => part.id), ['blocks'])
    assert.deepEqual(preview.unresolved.map(part => part.id), ['blocks'])
    assert.equal(preview.conflicts[0].canEditText, false)
    const chosen = mergeSyncDocument(base, local, remote, { blocks: { choice: 'remote' } })
    assert.deepEqual(chosen.unresolved, []); assert.deepEqual(chosen.document.content.blocks, remote.content.blocks)
  }
})

test('conflicting tags are chosen atomically so removed tags are not silently resurrected', () => {
  const base = document([block('first', 'body', { tags: ['a', 'b'] })]), local = copy(base), remote = copy(base)
  local.content.blocks[0].tags = ['a']; remote.content.blocks[0].tags = ['a', 'b', 'c']
  const preview = mergeSyncDocument(base, local, remote)
  assert.equal(preview.conflicts[0].id, 'block:first:tags'); assert.equal(preview.conflicts[0].canEditText, false)
  const custom = mergeSyncDocument(base, local, remote, { 'block:first:tags': { choice: 'custom', text: '["a","c"]' } })
  assert.equal(custom.unresolved.length, 1)
  const chosen = mergeSyncDocument(base, local, remote, { 'block:first:tags': { choice: 'local' } })
  assert.deepEqual(chosen.unresolved, []); assert.deepEqual(chosen.document.content.blocks[0].tags, ['a'])
})

test('empty code-fence metadata and concurrent content changes remain one stable structural conflict', () => {
  const base = document([block('first', 'base code', { type: 'code', language: 'js' })]), local = copy(base), remote = copy(base)
  local.content.blocks[0].content = ''; local.content.blocks[0].markdownFormat = { emptyCode: true }
  remote.content.blocks[0].content = 'remote code'
  const preview = mergeSyncDocument(base, local, remote)
  assert.deepEqual(preview.conflicts.map(part => part.id), ['blocks'])
  for (const choice of ['local', 'remote'] as const) {
    const chosen = mergeSyncDocument(base, local, remote, { blocks: { choice } })
    assert.deepEqual(chosen.conflicts.map(part => part.id), ['blocks']); assert.deepEqual(chosen.unresolved, [])
    assert.deepEqual(chosen.document.content.blocks, (choice === 'local' ? local : remote).content.blocks)
  }
})

test('invalid block trees and metadata choices are kept unresolved before any store normalization', () => {
  const base = document(), local = copy(base)
  for (const invalid of [
    [block('first', 'body', { depth: 1 })],
    [block('first', 'body', { type: 'todo', depth: 1, parentBlockId: 'missing' })],
    [block('first', 'body'), block('first', 'duplicate')],
    [block('first', 'body', { checked: true })],
    [block('first', 'body', { language: 'js' })],
    [block('first', 'body', { listStart: 1 })],
    [block('first', 'body', { markdownFormat: { codeInfo: 'js' } })],
    [block('first', 'body', { tags: [' a '] })],
    [block('first', 'body', { highlight: 'unknown' })]
  ]) {
    const remote = copy(base); remote.content.blocks = invalid
    const chosen = mergeSyncDocument(base, local, remote, { blocks: { choice: 'remote' } })
    assert.deepEqual(chosen.unresolved.map(part => part.id), ['blocks'])
    assert.deepEqual(chosen.document.content.blocks, local.content.blocks)
  }
})

test('valid nested task metadata survives independent content edits', () => {
  const base = document([block('parent', 'parent', { type: 'todo' }), block('child', 'child', { type: 'numbered-todo', depth: 1,
    parentBlockId: 'parent', listStart: 2, markdownFormat: { listMarker: ')', listLoose: true } })])
  const local = copy(base), remote = copy(base)
  local.content.blocks[0].content = '本地父块'; remote.content.blocks[1].content = '远端子块'
  const merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, []); assert.equal(merged.document.content.blocks[1].parentBlockId, 'parent')
  assert.equal(merged.document.content.blocks[1].depth, 1); assert.equal(merged.document.content.blocks[1].listStart, 2)
})

test('large or expensive text comparisons fall back to a resolvable conflict', () => {
  for (const before of ['a'.repeat(32_001), 'a'.repeat(1_200) + 'z'.repeat(1_200)]) {
    const base = document([block('first', before)]), local = copy(base), remote = copy(base)
    local.content.blocks[0].content = 'L' + before.slice(1, -1) + 'X'
    remote.content.blocks[0].content = 'R' + before.slice(1, -1) + 'Y'
    const preview = mergeSyncDocument(base, local, remote)
    assert.equal(preview.unresolved[0]?.field, 'block-content')
    const chosen = mergeSyncDocument(base, local, remote, { 'block:first:content': { choice: 'remote' } })
    assert.deepEqual(chosen.unresolved, []); assert.equal(chosen.document.content.blocks[0].content, remote.content.blocks[0].content)
  }
})

test('mismatched document identities are never treated as a common ancestor', () => {
  const base = document(), local = copy(base), remote = copy(base)
  remote.id = 'unrelated'; assert.throws(() => mergeSyncDocument(base, local, remote), /身份/)
  remote.id = base.id; remote.createdAt = '2026-10-02T00:00:00.000Z'
  assert.throws(() => mergeSyncDocument(base, local, remote), /创建时间/)
})
