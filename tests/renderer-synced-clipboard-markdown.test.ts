import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { markdownEngine } from '../src/shared/markdownEngine'
import { assertClipboardIndependentlySerializable, renderPublicSyncedClipboard, rewriteClipboardLocalBlockLinks } from '../src/renderer/src/features/synced-blocks/clipboardMarkdown'

const block = (id: string, content: string, type = 'paragraph'): SyncedStableBlockDraft => ({ id, content, type, checked: false, depth: 0, parentBlockId: null })

test('private clipboard maps actual local Markdown and Wiki block links to the new ordinary identity', () => {
  const old = randomUUID(), fresh = randomUUID(), other = randomUUID()
  const selected = [block(old, 'Copied destination'), block(other,
    `Read [this](#^${old} "keep") [[ #^${old} | spaced alias ]] [via][own] \`[literal](#^${old})\` [elsewhere](Elsewhere.md#^${old})`),
  block(randomUUID(), `[own]: #^${old} "definition title"`), block(randomUUID(), `[code](#^${old})`, 'code')]
  const revised = rewriteClipboardLocalBlockLinks(selected, new Map([[old, fresh]]))
  assert.equal(revised[1].content, selected[1].content.replace(`](#^${old} "keep")`, `](#^${fresh} "keep")`).replace(`[[ #^${old} |`, `[[ #^${fresh} |`))
  assert.equal(revised[2].content, `[own]: #^${fresh} "definition title"`)
  assert.equal(revised[3].content, selected[3].content)
})

test('public clipboard proves the separately named definitions of repeated synced group occurrences', () => {
  const documentId = randomUUID(), originInstance = randomUUID(), time = '2026-11-14T00:00:00Z'
  const group: SyncedGroupWire = { kind: 'synced-group', id: randomUUID(), creationId: randomUUID(), createdAt: time,
    origin: { version: 1, documentId, pathAtCreation: 'Already existing', firstInstanceId: originInstance }, bindings: [],
    blocks: [block(randomUUID(), 'shared [label][same] [^note]'), block(randomUUID(), '[same]: https://example.test/shared'),
      block(randomUUID(), '[^note]: shared note')].map(row => ({ ...row, createdAt: time })) }
  const ref = (id: string) => block(id, serializeSyncedBlockPayload({ version: 1, groupId: group.id }), 'synced-block')
  const scope = [block(randomUUID(), 'outside [outside-link][same] [^note]'), block(randomUUID(), '[same]: https://example.test/host'),
    block(randomUUID(), '[^note]: ordinary note'), ref(originInstance), ref(randomUUID())]
  const exported = renderPublicSyncedClipboard(documentId, scope, [group])
  const env: Parameters<typeof markdownEngine.parse>[1] = {}
  markdownEngine.parse(exported, env)
  assert.equal(Object.keys(env.references ?? {}).length, 3)
  assert.equal(Object.keys((env.footnotes as { refs?: Record<string, number> } | undefined)?.refs ?? {}).length, 3)
  const refs = collectMarkdownSourceLinks(exported).filter(link => link.kind === 'definition').map(link => link.url).sort()
  assert.deepEqual(refs, ['https://example.test/host', 'https://example.test/shared', 'https://example.test/shared'])
  assert.equal(exported.split('shared note').length - 1, 2)
  assert.equal(exported.includes(group.id), false)
})

test('a selected actual consumer cannot drop a definition outside the copied roots', () => {
  const use = block(randomUUID(), 'Read [source][separate] and [^note].')
  const definition = block(randomUUID(), '[separate]: https://example.test/source')
  const note = block(randomUUID(), '[^note]: Ordinary Note')
  assert.throws(() => assertClipboardIndependentlySerializable([use, definition, note], [use], 0, 0), /cannot preserve/)
  assert.doesNotThrow(() => assertClipboardIndependentlySerializable([use, definition, note], [use, definition, note], 0, 2))
  const literal = { ...use, content: '\`[source][separate] [^note]\`' }
  assert.doesNotThrow(() => assertClipboardIndependentlySerializable([literal, definition, note], [literal], 0, 0))
})
