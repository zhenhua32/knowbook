import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload, parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { parseMarkdownBlocks, serializeMarkdownWithBlockRanges } from '../src/shared/markdown'
import { NATIVE_LITERAL_MARKER, projectedMarkdownContentPosition } from '../src/shared/markdownNativeText'
import { planDatabaseViewInsertion } from '../src/renderer/src/utils/databaseViewInsertion'
import { createMarkdownSourceDraft, replaceMarkdownSource, markdownSourceDraftToBlocks } from '../src/renderer/src/utils/markdownSourceDraft'

const payload = (query = 'Old query') => ({ version: 1 as const, databaseId: 'source', viewId: null,
  config: { ...createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, 'notes']), query } })
const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, type, content, depth, parentBlockId, checked: false })

test('public source insertion replaces the slash host once while retaining its identity and authored metadata', () => {
  const initial = [{ ...block('host', 'paragraph', '/database'), tags: ['keep'], highlight: 'blue' }]
  const next = planDatabaseViewInsertion(initial, 'host', payload(), { start: 0, cursor: 9 })!
  assert.equal(next.id, 'host'); assert.equal(next.blocks.length, 1)
  assert.equal(next.blocks[0].type, 'database-view'); assert.deepEqual(next.blocks[0].tags, ['keep'])
  assert.equal(next.blocks[0].highlight, 'blue'); assert.equal(next.blocks[0].content, serializeDatabaseViewPayload(payload()))
  assert.equal(next.blocks[0].language, undefined); assert.equal(next.blocks[0].markdownFormat, undefined)
  assert.equal(initial[0].content, '/database', 'planning must leave the captured history snapshot unchanged')
})

test('source insertion preserves populated subtrees and climbs out of lists into their column', () => {
  const initial = [block('group', 'columns', ''), { ...block('column', 'column', '', 1, 'group'), markdownFormat: { columnWeight: 10000 } },
    block('list', 'bulleted-list', 'Keep /database', 2, 'column'), block('child', 'bulleted-list', 'Nested', 3, 'list'),
    block('tail', 'paragraph', 'After', 2, 'column')]
  const next = planDatabaseViewInsertion(initial, 'list', payload(), { start: 5, cursor: 14 })!
  assert.deepEqual(next.blocks.map(item => item.id), ['group', 'column', 'list', 'child', next.id, 'tail'])
  assert.equal(next.blocks[2].content, 'Keep ')
  assert.deepEqual(next.blocks[3], { ...initial[3], language: undefined, listStart: undefined, markdownFormat: undefined })
  assert.equal(next.blocks[4].depth, 2); assert.equal(next.blocks[4].parentBlockId, 'column')
  assert.equal(planDatabaseViewInsertion(initial, 'missing', payload()), null)
  assert.equal(planDatabaseViewInsertion([], undefined, payload())?.blocks[0].type, 'database-view')
})

test('editing the actual source fence retains the atom identity and column ancestry without code attributes', () => {
  const initial = [block('group', 'columns', ''), { ...block('column', 'column', '', 1, 'group'), markdownFormat: { columnWeight: 10000 } },
    { ...block('atom', 'database-view', serializeDatabaseViewPayload(payload()), 2, 'column'), tags: ['source'], highlight: 'yellow' },
    block('tail', 'paragraph', 'Unchanged')]
  const draft = createMarkdownSourceDraft(initial), from = draft.source.indexOf('Old query')
  assert.ok(from > 0)
  const next = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from, to: from + 9, insert: 'New query' }))
  assert.equal(next[2].id, 'atom'); assert.equal(next[2].parentBlockId, 'column'); assert.equal(next[2].depth, 2)
  assert.deepEqual(next[2].tags, ['source']); assert.equal(next[2].highlight, 'yellow')
  assert.equal(parseDatabaseViewPayload(next[2].content).config.query, 'New query')
  assert.equal(next[2].language, undefined); assert.equal(next[2].markdownFormat, undefined)
  assert.equal(next[3].id, 'tail'); assert.equal(initial[2].content, serializeDatabaseViewPayload(payload()))
  const invalid = draft.source.indexOf('"version":1')
  assert.throws(() => markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: invalid, to: invalid + 11, insert: '"version":2' })))
})

test('native literal escrow never decodes closing-looking strings inside an embedded database JSON payload', () => {
  const query = NATIVE_LITERAL_MARKER + '&lt;/div&gt; ' + NATIVE_LITERAL_MARKER.repeat(2) + ' </aside> ```'
  const initial = [{ ...block('callout', 'callout', 'Container'), markdownFormat: { calloutKind: 'note' as const } },
    block('atom', 'database-view', serializeDatabaseViewPayload(payload(query)), 1, 'callout')]
  const { markdown } = serializeMarkdownWithBlockRanges(initial)
  const parsed = parseMarkdownBlocks(markdown)
  assert.equal(parsed[1].content, initial[1].content)
  assert.equal(parseDatabaseViewPayload(parsed[1].content).config.query, query)
})

test('database source projection includes only exact canonical JSON body boundaries in plain and backup native forests', () => {
  for (const includeBlockMetadata of [false, true]) {
    const atom = block('atom', 'database-view', serializeDatabaseViewPayload(payload('``` </div>')))
    const { markdown, ranges } = serializeMarkdownWithBlockRanges([atom], { includeBlockMetadata })
    const lines = markdown.split('\n'), offsets = [0]
    for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
    const body = markdown.indexOf(atom.content), range = ranges[0]
    for (const local of [0, 1, atom.content.indexOf('source'), atom.content.length])
      assert.equal(projectedMarkdownContentPosition(atom, range, markdown, lines, offsets, body + local), local)
    for (const position of [0, body - 1, body + atom.content.length + 1, markdown.length])
      assert.equal(projectedMarkdownContentPosition(atom, range, markdown, lines, offsets, position), null)
    const spaced = markdown.replace(atom.content, JSON.stringify(JSON.parse(atom.content), null, 1))
    const spacedLines = spaced.split('\n'), spacedOffsets = [0]
    for (const line of spacedLines) spacedOffsets.push(spacedOffsets.at(-1)! + line.length + 1)
    assert.equal(projectedMarkdownContentPosition(atom, { ...range, endLine: spacedLines.length }, spaced, spacedLines, spacedOffsets, body), null)
  }
})
