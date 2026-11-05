import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { collectSyncedBindingOccurrences } from '../src/main/sync/synced-binding-occurrences'
import { projectSyncedMetadataGroupLinks2 } from '../src/main/database/synced-metadata-group-links2'
import { restyleHeadingTitleOrdinaryBlocks3, restyleHeadingTitleGroupProjection3, HeadingTitle3StyleRequired } from '../src/main/database/synced-heading-title-style3'

const block = (content: string): SyncedStableBlockDraft => ({ id: randomUUID(), type: 'paragraph', content, depth: 0, checked: false, parentBlockId: null })

test('title3 ordinary self-block URI retains exact caret and query spelling through native normalization', () => {
  const before = [block('[self](#^stable) and [query](Old.md?x=%2f&y=one#^stable)')]
  const canonical = [{ ...before[0], content: '[self](#%5Estable) and [query](New.md?x=%2f&y=one#%5Estable)' }]
  const result = restyleHeadingTitleOrdinaryBlocks3(before, canonical, 'New')
  assert.equal(result.blocks[0].content, '[self](#^stable) and [query](New.md?x=%2f&y=one#^stable)')
  assert.equal(result.edits.length, 2)
})

test('title3 complete inverse template restores Unicode, percent case, escapes and HTML entities only in URI ranges', () => {
  const before = [block('[unicode](旧.md?x=%2f#原) <a href="Old.md?x=1&amp;y=2#%5estable">label</a>')]
  const canonical = [{ ...before[0], content: '[unicode](%E6%96%B0.md?x=%2f#%E5%8E%9F) <a href="New.md?x=1&amp;y=2#^stable">label</a>' }]
  const styled = restyleHeadingTitleOrdinaryBlocks3(before, canonical, 'Source')
  assert.equal(styled.blocks[0].content, '[unicode](新.md?x=%2f#原) <a href="New.md?x=1&amp;y=2#%5estable">label</a>')
  const inverseCanonical = [{ ...before[0], content: '[unicode](%E6%97%A7.md?x=%2f#%E5%8E%9F) <a href="Old.md?x=1&amp;y=2#^stable">label</a>' }]
  assert.equal(restyleHeadingTitleOrdinaryBlocks3(styled.blocks, inverseCanonical, 'Source', before).blocks[0].content, before[0].content)
  const otherQuery = [{ ...before[0], content: before[0].content.replace('x=%2f', 'x=%2Fextra') }]
  assert.throws(() => restyleHeadingTitleOrdinaryBlocks3(styled.blocks, inverseCanonical, 'Source', otherQuery), HeadingTitle3StyleRequired)
})

test('title3 canonical inverse composes exact Keys and preserves current unrelated URI content', () => {
  const first = randomUUID(), second = randomUUID(), time = '2026-11-04T00:00:00.000Z'
  const origin = { version: 1 as const, documentId: randomUUID(), pathAtCreation: 'Source', firstInstanceId: randomUUID() }
  const blocks = [{ ...block('[one](Old%20name.MD#%73table) and [other](Other.md)'), createdAt: time }]
  const before: SyncedGroupWire = { kind: 'synced-group', id: randomUUID(), creationId: randomUUID(), createdAt: time, origin, blocks,
    bindings: collectSyncedBindingOccurrences(origin, blocks).map(({ blockId, from, to, raw, syntax }, index) => ({ blockId, from, to, raw, syntax,
      target: index === 0 ? { kind: 'heading' as const, documentId: first, slug: 'stable', state: 'live' as const }
        : { kind: 'document' as const, id: second, state: 'live' as const } })) }
  const destinations = (id: string, old: string, next: string) => new Map([[id, { documentId: id, beforeCreatedAt: time, afterCreatedAt: time,
    beforePath: old, afterPath: next, headings: new Map<string, string>() }]])
  const forward = restyleHeadingTitleGroupProjection3(projectSyncedMetadataGroupLinks2(before, destinations(first, 'Old name', 'New name'), new Map()))
  assert.equal(forward.after.blocks[0].content, '[one](New%20name.MD#%73table) and [other](Other.md)')
  const unrelated = restyleHeadingTitleGroupProjection3(projectSyncedMetadataGroupLinks2(forward.after, destinations(second, 'Other', 'Elsewhere'), new Map()))
  const restored = restyleHeadingTitleGroupProjection3(projectSyncedMetadataGroupLinks2(unrelated.after, destinations(first, 'New name', 'Old name'), new Map()),
    [{ from: forward.after, to: before }])
  assert.equal(restored.after.blocks[0].content, '[one](Old%20name.MD#%73table) and [other](Elsewhere.md)')
  assert.deepEqual(restored.after.bindings[1].target, unrelated.after.bindings[1].target)
  const native = collectSyncedBindingOccurrences(origin, restored.after.blocks)
  assert.deepEqual(restored.after.bindings.map(({ target: _target, ...key }) => key), native.map(({ blockId, from, to, raw, syntax }) => ({ blockId, from, to, raw, syntax })))
})
