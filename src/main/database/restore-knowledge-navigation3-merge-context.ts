import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import type { Graph3Inputs } from './restore-knowledge-graph3-data'
import type { Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import type { FinishedMerge3Table, Merge3OriginalRowRef, MergedRow3 } from './restore-knowledge-merge3-storage'
import type { deriveRootRestoreMergedContent3 } from './restore-knowledge-merge3-model'
import type { Navigation3FinalTarget } from './restore-knowledge-navigation3-rewrite-cells'
import { deriveRootRestoreNavigationRewriteInputs3, deriveRootRestoreCurrentNavigationRewriteInputs3 } from './restore-knowledge-navigation3-model'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '../../shared/markdownWiki'
import { canBlockNestUnder } from '../../shared/blockTypes'
import { parseSyncedBlockPayload, SYNCED_MAX_BLOCKS, SYNCED_MAX_DEPTH, validateSyncedCanonicalEdit, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import { captureSyncedCreateSourceFacts } from './synced-host-create-plan'

export type Navigation3Baseline = ReturnType<typeof deriveRootRestoreNavigationRewriteInputs3>
export type Navigation3OriginalScope = Navigation3Baseline['scopes'][number]
export type Navigation3OriginalDestination = Navigation3OriginalScope['destinations'][number]
export type Navigation3Table = FinishedMerge3Table['table']
export interface Navigation3Cell {
  readonly table: 'documents' | 'blocks' | 'synced_group_blocks'; readonly rowKey: string; readonly targetRowId: string
  readonly column: 'content' | 'summary'; readonly sourceRef: Merge3OriginalRowRef; readonly encoding: Capsule2Encoding
  /** The actual selected final cell, before the caller's next range edits. */
  readonly text: string
}
export type Navigation3MappedTarget = Navigation3FinalTarget
  | { readonly kind: 'unresolved'; readonly reason: string; readonly preserveUnresolved: true }
  | { readonly kind: 'opaque'; readonly reason: string }
  | Extract<Navigation3OriginalDestination['target'], { kind: 'captured-binding' }>
export interface Navigation3FinalLocation {
  readonly table: 'documents' | 'blocks' | 'synced_group_blocks'; readonly sourceRowId: string
  readonly column: 'content' | 'summary'; readonly blockId: string | null; readonly groupId: string | null; readonly instanceId: string | null
  readonly blockBirth: string | null; readonly instanceBirth: string | null; readonly sourceRef: Merge3OriginalRowRef
}
export interface Navigation3FinalBlock {
  readonly id: string; readonly birth: string; readonly documentId: string | null; readonly groupId: string | null
  readonly block: SyncedStableBlockDraft; readonly sourceRef: Merge3OriginalRowRef; readonly replaces: Merge3OriginalRowRef | null
  readonly rowKey: string; readonly targetRowId: string
}
export interface Navigation3FinalDocument {
  readonly id: string; readonly birth: string; readonly path: string; readonly title: string; readonly summary: string
  readonly sourceRef: Merge3OriginalRowRef; readonly replaces: Merge3OriginalRowRef | null; readonly rowKey: string; readonly targetRowId: string
}
export interface Navigation3FinalScope {
  readonly scopeId: string; readonly field: 'body' | 'summary'; readonly finalDocumentId: string
  readonly document: Navigation3FinalDocument; readonly path: string; readonly title: string
  readonly blocks: readonly { readonly occurrenceKey: string; readonly finalOccurrenceKey: string; readonly block: SyncedStableBlockDraft
    readonly location: Navigation3FinalLocation; readonly cell: Navigation3Cell }[]
  readonly destinations: readonly { readonly key: Navigation3OriginalDestination['key']; readonly url: string; readonly image: boolean
    readonly grammar: Navigation3OriginalDestination['grammar']; readonly location: Navigation3FinalLocation
    readonly cell: Navigation3Cell; readonly finalOccurrenceKey: string }[]
  readonly definitions: Navigation3OriginalScope['definitions']; readonly effectiveDefinitions: Navigation3OriginalScope['effectiveDefinitions']
  readonly uses: Navigation3OriginalScope['uses']; readonly units: Navigation3OriginalScope['units']
}
export interface Navigation3FinalIndex {
  readonly kind: 'restore-navigation3-final-syntax-index'; readonly version: 1
  readonly documents: readonly Navigation3FinalDocument[]; readonly physicalBlocks: readonly Navigation3FinalBlock[]
  readonly headingNamespaces: readonly { readonly document: Navigation3FinalDocument; readonly headings: readonly {
    readonly key: string; readonly blockId: string | null; readonly text: string; readonly slug: string; readonly location: Navigation3FinalLocation | null }[] }[]
  readonly scopes: readonly Navigation3FinalScope[]; readonly bindingsValidated: false; readonly permit: false; readonly indexHash: string
  readonly routes: readonly { readonly path: string; readonly blockId: string; readonly documentId: string; readonly side: Side; readonly sourceRowId: string
    readonly sourceMaterialHash: string; readonly originalRowHash: string }[]
}
export type Navigation3ContextScope = Omit<Navigation3OriginalScope, 'blocks' | 'destinations'> & {
  readonly side: 'source' | 'current'; readonly finalDocumentId: string | null
  readonly blocks: readonly (Navigation3OriginalScope['blocks'][number] & { readonly cell: Navigation3Cell | null; readonly finalOccurrenceKey: string | null })[]
  readonly destinations: readonly (Navigation3OriginalDestination & { readonly cell: Navigation3Cell | null
    readonly finalOccurrenceKey: string | null; readonly finalTarget: Navigation3MappedTarget })[]
}
export interface Navigation3MergeContext {
  readonly kind: 'restore-navigation3-source-current-merge-context'; readonly version: 1
  readonly source: Navigation3Baseline; readonly current: ReturnType<typeof deriveRootRestoreCurrentNavigationRewriteInputs3>
  readonly scopes: readonly Navigation3ContextScope[]; readonly final: Navigation3FinalIndex
  readonly mergedContentHash: string; readonly contextHash: string; readonly permit: false
}

type Side = 'source' | 'current'
type OriginalIdentity = Navigation3OriginalScope['document']
type OriginalLocation = Navigation3OriginalDestination['location']
type Values = Record<string, unknown>
type FinalEntry = { table: Navigation3Table; row: MergedRow3; value: Values }
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('navigation-merge-text', typeof value)
const integer = (value: unknown): number => typeof value === 'bigint' && Number.isSafeInteger(Number(value)) ? Number(value) : graph3Conflict('navigation-merge-integer', typeof value)
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const unresolved = (reason: string): Extract<Navigation3MappedTarget, { kind: 'unresolved' }> => ({ kind: 'unresolved', reason, preserveUnresolved: true })
const ascii = (value: string) => value.replace(/[A-Z]/g, value => value.toLowerCase())
const refKey = (ref: Merge3OriginalRowRef) => graph3Key(ref)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
function originalAccess(data: Graph3Inputs) {
  const tables = new Map<string, ReturnType<typeof graph3Rows>>()
  const payloads = new Map((['source', 'current'] as const).map(side => {
    const matches = data.inputs.knowledge.constraints.payloads.filter(payload => !payload.witness.domain.length && payload.witness.side === side)
    if (matches.length !== 1) return graph3Conflict('navigation-merge-payload', side)
    return [side, matches[0]] as const
  }))
  function rows(side: Side, table: string) {
    const key = graph3Key(side, table)
    let result = tables.get(key)
    if (!result) { result = graph3Rows(data.inputs[side].source.sourceContent, table); tables.set(key, result) }
    return result
  }
  const byRow = new Map<string, Map<string, ReturnType<typeof graph3Rows>[number]>>()
  const byId = new Map<string, Map<string, ReturnType<typeof graph3Rows>[number]>>()
  function original(side: Side, table: string, sourceRowId: string) {
    const key = graph3Key(side, table)
    if (!byRow.has(key)) byRow.set(key, new Map(rows(side, table).map(row => [row.original.sourceRowId, row])))
    return byRow.get(key)!.get(sourceRowId) ?? graph3Conflict('navigation-merge-original-row', { side, table, sourceRowId })
  }
  function identity(side: Side, table: 'documents' | 'blocks' | 'synced_group_blocks', id: string) {
    const key = graph3Key(side, table)
    if (!byId.has(key)) byId.set(key, new Map(rows(side, table).map(row => [text(row.value.id), row])))
    return byId.get(key)!.get(id) ?? graph3Conflict('navigation-merge-original-identity', { side, table, id })
  }
  const refs = new Map<string, Merge3OriginalRowRef>()
  function ref(side: Side, table: Merge3OriginalRowRef['table'], sourceRowId: string): Merge3OriginalRowRef {
    const key = graph3Key(side, table, sourceRowId), old = refs.get(key)
    if (old) return old
    const packet = data.inputs[side], raw = packet.source.sourceContent, row = original(side, table, sourceRowId), payload = payloads.get(side)!
    const result: Merge3OriginalRowRef = { side, table, sourceRowId, payload: payload.key, materialHash: packet.materialHash, witness: payload.witness,
      originalRowHash: hash('knowbook.restore.merge3.original-row.v1', { table, columns: row.table.columns, primaryKey: row.table.primaryKey,
        encoding: raw.encoding, sourceRowId, cells: row.original.cells }) }
    refs.set(key, result); return result
  }
  function checked(refValue: Merge3OriginalRowRef) {
    if (!same(refValue, ref(refValue.side, refValue.table, refValue.sourceRowId))) return graph3Conflict('navigation-merge-original-ref', refValue)
    return original(refValue.side, refValue.table, refValue.sourceRowId)
  }
  return { rows, original, identity, ref, checked }
}
function finalEntries(tables: readonly Navigation3Table[]): FinalEntry[] {
  assertMerge3JsonBudget(tables)
  let rows = 0, valueBytes = 0
  const names = new Set<string>(), targetRows = new Set<string>()
  return tables.flatMap(table => {
    if (names.has(table.name)) return graph3Conflict('navigation-final-table-duplicate', table.name)
    names.add(table.name)
    return table.rows.map(row => {
      if (++rows > CAPSULE2_RAW_MAX_ROWS || row.cells.length !== table.columns.length) return graph3Conflict('navigation-final-row-budget-or-width', table.name)
      const locator = graph3Key(table.name, row.targetRowId)
      if (targetRows.has(locator)) return graph3Conflict('navigation-final-rowid-duplicate', locator)
      targetRows.add(locator)
      const value = Object.fromEntries(table.columns.map((column, index) => {
        const cell = row.cells[index]
        const bytes = cell[0] === 'text' || cell[0] === 'blob' ? cell[1].length / 4 * 3 - (cell[1].endsWith('==') ? 2 : cell[1].endsWith('=') ? 1 : 0) : 8
        valueBytes += bytes
        if (!Number.isSafeInteger(valueBytes) || valueBytes > CAPSULE2_RAW_MAX_VALUE_BYTES) return graph3Conflict('navigation-final-value-budget', null)
        return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding) : cell[0] === 'integer' ? BigInt(cell[1])
          : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
      }))
      return { table, row, value }
    })
  })
}
function blockSyntax(value: Values): SyncedStableBlockDraft {
  const json = (value: unknown) => { const raw = text(value); return parseStrictJson(raw, { maxBytes: Math.max(1, Buffer.byteLength(raw)), maxDepth: 32 }) }
  return { id: text(value.id), type: text(value.type), content: text(value.content), checked: value.checked === 1n,
    depth: integer(value.depth), parentBlockId: value.parent_block_id === null ? null : text(value.parent_block_id),
    ...(value.tags_json === null ? {} : { tags: json(value.tags_json) as string[] }), ...(value.language === null ? {} : { language: text(value.language) }),
    ...(value.list_start === null ? {} : { listStart: integer(value.list_start) }), ...(value.markdown_format_json === null ? {} : { markdownFormat: json(value.markdown_format_json) as NonNullable<SyncedStableBlockDraft['markdownFormat']> }),
    ...(value.highlight === null ? {} : { highlight: text(value.highlight) }) }
}
function cell(entry: FinalEntry, column: 'content' | 'summary'): Navigation3Cell {
  return { table: entry.table.name as Navigation3Cell['table'], rowKey: entry.row.key, targetRowId: entry.row.targetRowId,
    column, sourceRef: entry.row.sourceRef, encoding: entry.table.encoding, text: text(entry.value[column]) }
}
function captureGrammar(blocks: readonly SyncedStableBlockDraft[]) {
  const facts = captureSyncedCreateSourceFacts(blocks)
  const offsets = blocks.map(block => { const result: number[] = []; for (let i = 0; i < block.content.length; i++) {
    result.push(i); if (block.content[i] === '\r' && block.content[i + 1] === '\n') i++
  } result.push(block.content.length); return result })
  const grammar = new Map(collectDocumentMarkdownLinks(blocks.map(block => ({ ...block, content: block.content.replace(/\r\n?/g, '\n') }))).map(link => [
    graph3Key(link.blockId, offsets[link.blockIndex][link.start], offsets[link.blockIndex][link.end]), link
  ]))
  if (grammar.size !== facts.links.length) return graph3Conflict('navigation-final-incomplete-grammar', null)
  const links = facts.links.map(link => {
    const role = grammar.get(graph3Key(link.key.blockId, link.key.from, link.key.to))
    if (!role || role.url !== link.url) return graph3Conflict('navigation-final-range-grammar', link.key)
    return { ...link, grammar: { kind: role.kind, syntax: role.kind === 'wiki' ? 'wiki' as const : role.syntax ?? null } }
  })
  return { links, definitions: facts.definitions, effectiveDefinitions: [...facts.effective].map(([key, definition]) => ({ key, definition })),
    uses: [...facts.uses].map(([blockId, definitions]) => ({ blockId, definitions: [...definitions] })), units: facts.units }
}

/** Final syntax only. Stale wire bindings are deliberately NOT validated or
 * replaced by an empty binding wire. Physical forests, registry mirrors and
 * every expanded occurrence are checked directly; no live authority is minted. */
export function buildMerge3NavigationFinalIndex3(data: Graph3Inputs, tables: readonly Navigation3Table[]): Navigation3FinalIndex {
  const access = originalAccess(data), entries = finalEntries(tables), byTable = new Map<string, FinalEntry[]>()
  for (const entry of entries) { const values = byTable.get(entry.table.name) ?? []; values.push(entry); byTable.set(entry.table.name, values) }
  const physical = entries.filter(entry => ['documents', 'blocks', 'synced_groups', 'synced_group_blocks'].includes(entry.table.name))
  const assignments = new Map<string, typeof data.value.assignments>()
  for (const item of data.value.assignments) { const key = graph3Key(item.kind, item.sourceId), values = assignments.get(key) ?? []; values.push(item); assignments.set(key, values) }
  function mapped(side: Side, kind: 'document' | 'block' | 'group', original: Values, ownerKind: 'document' | 'group' | null, ownerId: string | null) {
    if (side === 'current') return text(original.id)
    const slots = (assignments.get(graph3Key(kind, original.id)) ?? []).filter(item => item.physical && !item.ambiguous
      && item.birth === original.created_at && item.ownerKind === ownerKind && item.ownerId === ownerId)
    if (slots.length !== 1) return graph3Conflict('navigation-final-source-allocation', { kind, id: original.id })
    return slots[0].targetId
  }
  const documents: Navigation3FinalDocument[] = [], physicalBlocks: Navigation3FinalBlock[] = []
  const documentEntries = new Map<string, FinalEntry>(), blockEntries = new Map<string, FinalEntry>(), groupEntries = new Map<string, FinalEntry>()
  for (const entry of physical) {
    const original = access.checked(entry.row.sourceRef).value, name = entry.table.name, kind = name === 'documents' ? 'document' : name === 'synced_groups' ? 'group' : 'block'
    const ownerKind = kind !== 'block' ? null : name === 'blocks' ? 'document' : 'group'
    const ownerId = ownerKind === null ? null : text(original[ownerKind === 'document' ? 'document_id' : 'group_id'])
    if (entry.value.id !== mapped(entry.row.sourceRef.side, kind, original, ownerKind, ownerId) || entry.value.created_at !== original.created_at)
      return graph3Conflict('navigation-final-identity-or-birth', entry.row.key)
    if (entry.row.replaces) {
      const old = access.checked(entry.row.replaces).value
      if (entry.row.replaces.side !== 'current' || entry.row.replaces.table !== name || old.id !== entry.value.id || old.created_at !== entry.value.created_at)
        return graph3Conflict('navigation-final-replaced-incarnation', entry.row.key)
    }
    const id = text(entry.value.id)
    if (name === 'documents') {
      if (documentEntries.has(id)) return graph3Conflict('navigation-final-document-duplicate', id)
      documentEntries.set(id, entry)
      documents.push({ id, birth: text(entry.value.created_at), path: text(entry.value.path), title: text(entry.value.title), summary: text(entry.value.summary),
        sourceRef: entry.row.sourceRef, replaces: entry.row.replaces, rowKey: entry.row.key, targetRowId: entry.row.targetRowId })
    } else if (name === 'synced_groups') { if (groupEntries.has(id)) return graph3Conflict('navigation-final-group-duplicate', id); groupEntries.set(id, entry) }
    else {
      if (blockEntries.has(id)) return graph3Conflict('navigation-final-global-block-owner', id)
      blockEntries.set(id, entry)
      physicalBlocks.push({ id, birth: text(entry.value.created_at), documentId: name === 'blocks' ? text(entry.value.document_id) : null,
        groupId: name === 'synced_group_blocks' ? text(entry.value.group_id) : null, block: blockSyntax(entry.value),
        sourceRef: entry.row.sourceRef, replaces: entry.row.replaces, rowKey: entry.row.key, targetRowId: entry.row.targetRowId })
    }
  }
  const hostRows = new Map<string, Navigation3FinalBlock[]>(), groupRows = new Map<string, Navigation3FinalBlock[]>()
  for (const block of physicalBlocks) {
    const index = block.documentId === null ? groupRows : hostRows, owner = block.documentId ?? block.groupId!
    if (!(block.documentId === null ? groupEntries : documentEntries).has(owner)) return graph3Conflict('navigation-final-block-owner-missing', owner)
    const values = index.get(owner) ?? []; values.push(block); index.set(owner, values)
  }
  const order = (items: Navigation3FinalBlock[]) => {
    items.sort((a, b) => integer(blockEntries.get(a.id)!.value.sort_order) - integer(blockEntries.get(b.id)!.value.sort_order))
    if (items.some((item, index) => integer(blockEntries.get(item.id)!.value.sort_order) < 0 || index > 0
      && blockEntries.get(item.id)!.value.sort_order === blockEntries.get(items[index - 1].id)!.value.sort_order)) return graph3Conflict('navigation-final-forest-order', null)
    return items
  }
  for (const items of hostRows.values()) { order(items); validateSyncedHostForest(items.map(item => item.block)) }
  const activeGroups = new Set<string>(), groupMaximum = new Map<string, number>()
  const physicalGroupStates = new Map((['source', 'current'] as const).map(side => [side,
    new Map(data.inputs[side].source.physical.groups.map(group => [group.groupId, group]))] as const))
  for (const [id, entry] of groupEntries) {
    const original = access.checked(entry.row.sourceRef).value
    const fact = physicalGroupStates.get(entry.row.sourceRef.side)!.get(text(original.id))
    if (!fact) return graph3Conflict('navigation-final-group-state-source', id)
    const items = order(groupRows.get(id) ?? [])
    if (fact.snapshot === null) { if (items.length) return graph3Conflict('navigation-final-inactive-canonical', id); continue }
    validateSyncedCanonicalEdit(items.map(item => item.block)); activeGroups.add(id)
    groupMaximum.set(id, items.reduce((max, item) => Math.max(max, item.block.depth), 0))
  }
  const instances = new Map((byTable.get('synced_instances') ?? []).map(entry => [text(entry.value.instance_id), entry]))
  const usedInstances = new Set<string>(), scopes: Navigation3FinalScope[] = [], headingNamespaces: Navigation3FinalIndex['headingNamespaces'][number][] = []
  let expandedJsonBytes = 0, expandedMinimumBytes = 0
  const minimumByGroup = new Map([...groupRows].map(([id, items]) => [id, items.reduce((bytes, item) => bytes + Buffer.byteLength(capsuleJson(item.block.content)) * 2, 0)]))
  for (const document of documents) {
    const hosts = hostRows.get(document.id) ?? [], wrapperCount = hosts.reduce((count, item) => count + (item.block.type === 'synced-block'
      ? (groupRows.get(parseSyncedBlockPayload(item.block.content).groupId)?.length ?? 0) : 1), 0)
    if (wrapperCount > SYNCED_MAX_BLOCKS) return graph3Conflict('navigation-final-expanded-host-budget', document.id)
    for (const item of hosts) expandedMinimumBytes += item.block.type === 'synced-block' ? minimumByGroup.get(parseSyncedBlockPayload(item.block.content).groupId) ?? 0
      : Buffer.byteLength(capsuleJson(item.block.content)) * 2
    if (expandedMinimumBytes > 128 * 1024 * 1024) return graph3Conflict('navigation-final-expanded-json-budget', null)
    const expanded: Navigation3FinalScope['blocks'][number][] = []
    const add = (item: Navigation3FinalBlock, instance: Navigation3FinalBlock | null, depth: number, parent: string | null) => {
      const key = graph3Key(instance?.id ?? null, item.id), original = blockEntries.get(item.id)!
      const location: Navigation3FinalLocation = { table: original.table.name as 'blocks' | 'synced_group_blocks', sourceRowId: item.sourceRef.sourceRowId,
        column: 'content', blockId: item.id, groupId: item.groupId, instanceId: instance?.id ?? null,
        blockBirth: item.birth, instanceBirth: instance?.birth ?? null, sourceRef: item.sourceRef }
      const block = { ...item.block, id: key, depth, parentBlockId: parent }
      const value = { occurrenceKey: key, finalOccurrenceKey: key, block, location, cell: cell(original, 'content') }
      expandedJsonBytes += Buffer.byteLength(capsuleJson(value))
      if (expandedJsonBytes > 128 * 1024 * 1024) return graph3Conflict('navigation-final-expanded-json-budget', null)
      expanded.push(value)
    }
    for (const host of hosts) {
      if (host.block.type !== 'synced-block') { add(host, null, host.block.depth, host.block.parentBlockId === null ? null : graph3Key(null, host.block.parentBlockId)); continue }
      const groupId = parseSyncedBlockPayload(host.block.content).groupId, registry = instances.get(host.id)
      if (!registry || registry.value.host_document_id !== document.id || registry.value.group_id !== groupId
        || registry.value.parent_block_id !== host.block.parentBlockId || registry.value.depth !== BigInt(host.block.depth) || !activeGroups.has(groupId))
        return graph3Conflict('navigation-final-instance-mirror-or-inactive', host.id)
      usedInstances.add(host.id)
      const group = groupRows.get(groupId)!, parent = host.block.parentBlockId === null ? null : blockEntries.get(host.block.parentBlockId)
      if (host.block.depth + groupMaximum.get(groupId)! > SYNCED_MAX_DEPTH || parent && group.some(item => item.block.depth === 0 && !canBlockNestUnder(text(parent.value.type), item.block.type)))
        return graph3Conflict('navigation-final-canonical-projection', host.id)
      for (const child of group) add(child, host, host.block.depth + child.block.depth, child.block.parentBlockId === null
        ? host.block.parentBlockId === null ? null : graph3Key(null, host.block.parentBlockId) : graph3Key(host.id, child.block.parentBlockId))
    }
    const docEntry = documentEntries.get(document.id)!, summaryKey = graph3Key('summary', document.id)
    const summaryLocation: Navigation3FinalLocation = { table: 'documents', sourceRowId: document.sourceRef.sourceRowId, column: 'summary', blockId: null,
      groupId: null, instanceId: null, blockBirth: null, instanceBirth: null, sourceRef: document.sourceRef }
    const summary = [{ occurrenceKey: summaryKey, finalOccurrenceKey: summaryKey, block: { id: summaryKey, type: 'paragraph', content: document.summary,
      checked: false, depth: 0, parentBlockId: null }, location: summaryLocation, cell: cell(docEntry, 'summary') }]
    for (const [field, blocks] of [['body', expanded], ['summary', summary]] as const) {
      const parsed = captureGrammar(blocks.map(item => item.block)), locations = new Map(blocks.map(item => [item.occurrenceKey, item]))
      scopes.push({ scopeId: graph3Key(field, document.id), field, finalDocumentId: document.id, document, path: document.path, title: document.title, blocks,
        destinations: parsed.links.map(link => { const owner = locations.get(link.key.blockId)!; return { ...link, location: owner.location, cell: owner.cell, finalOccurrenceKey: owner.occurrenceKey } }),
        definitions: parsed.definitions, effectiveDefinitions: parsed.effectiveDefinitions, uses: parsed.uses, units: parsed.units })
    }
    const locations = new Map(expanded.map(item => [item.occurrenceKey, item.location]))
    headingNamespaces.push({ document, headings: getMarkdownHeadingTargets(expanded.map(item => item.block), document.title)
      .map(heading => ({ ...heading, location: heading.blockId === null ? null : locations.get(heading.blockId)! })) })
  }
  if (instances.size !== usedInstances.size) return graph3Conflict('navigation-final-registry-without-leaf', null)
  const routes: Navigation3FinalIndex['routes'][number][] = []
  const finalBlocks = new Map(physicalBlocks.filter(block => block.documentId !== null).map(block => [block.id, block]))
  for (const side of ['source', 'current'] as const) {
    const originals = new Map(access.rows(side, 'blocks').map(row => [text(row.value.id), row]))
    for (const route of access.rows(side, 'document_block_routes')) {
      const old = originals.get(text(route.value.block_id))
      if (!old) continue // A retained/canonical UUID alone is never a physical host route.
      const originalRef = access.ref(side, 'blocks', old.original.sourceRowId)
      const targetId = mapped(side, 'block', old.value, 'document', text(old.value.document_id)), block = finalBlocks.get(targetId)
      if (!block || block.birth !== old.value.created_at || !(same(block.sourceRef, originalRef) || side === 'current' && same(block.replaces, originalRef))) continue
      routes.push({ path: text(route.value.document_path), blockId: block.id, documentId: block.documentId!, side,
        sourceRowId: route.original.sourceRowId, sourceMaterialHash: data.inputs[side].materialHash,
        originalRowHash: hash('knowbook.restore.merge3.original-row.v1', { table: route.table.name, columns: route.table.columns, primaryKey: route.table.primaryKey,
          encoding: data.inputs[side].source.sourceContent.encoding, sourceRowId: route.original.sourceRowId, cells: route.original.cells }) })
    }
  }
  const body = { kind: 'restore-navigation3-final-syntax-index' as const, version: 1 as const, documents, physicalBlocks, headingNamespaces, scopes, routes,
    bindingsValidated: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  return freezeCapsuleValue({ ...body, indexHash: hash('knowbook.restore.navigation3.final-index.v1', body) })
}

export function parseMerge3NavigationScopes3(data: Graph3Inputs, tables: readonly Navigation3Table[]): readonly Navigation3FinalScope[] {
  return buildMerge3NavigationFinalIndex3(data, tables).scopes
}

export function deriveRootRestoreNavigationMergeContext3(data: Graph3Inputs,
  merged: ReturnType<typeof deriveRootRestoreMergedContent3>): Navigation3MergeContext {
  const source = deriveRootRestoreNavigationRewriteInputs3(data), current = deriveRootRestoreCurrentNavigationRewriteInputs3(data)
  const final = buildMerge3NavigationFinalIndex3(data, merged.tables), access = originalAccess(data)
  const documents = new Map(final.documents.map(document => [document.id, document])), physical = new Map(final.physicalBlocks.map(block => [block.id, block]))
  const finalScopes = new Map(final.scopes.map(scope => [graph3Key(scope.finalDocumentId, scope.field), scope]))
  const occurrences = new Map(final.scopes.filter(scope => scope.field === 'body').map(scope => [scope.finalDocumentId,
    new Map(scope.blocks.map(block => [block.occurrenceKey, block]))]))
  const selectedCells = new Map<string, Navigation3Cell>()
  for (const table of merged.tables) if (table.name === 'documents' || table.name === 'blocks' || table.name === 'synced_group_blocks') {
    const column = table.name === 'documents' ? 'summary' : 'content'
    for (const row of table.rows) {
      access.checked(row.sourceRef)
      const key = graph3Key(refKey(row.sourceRef), column)
      if (selectedCells.has(key)) return graph3Conflict('navigation-selected-cell-duplicate-origin', key)
      selectedCells.set(key, { table: table.name, rowKey: row.key, targetRowId: row.targetRowId, column, sourceRef: row.sourceRef,
        encoding: table.encoding, text: graph3Text(row.cells[table.columns.indexOf(column)], table.encoding) })
    }
  }
  function evidence(side: Side, kind: 'document' | 'block', identity: OriginalIdentity) {
    let table: 'documents' | 'blocks' | 'synced_group_blocks' = 'documents'
    if (kind === 'block') table = identity.ownerKind === 'group' ? 'synced_group_blocks' : 'blocks'
    const row = access.identity(side, table, identity.id)
    if (row.value.created_at !== identity.birth) return graph3Conflict('navigation-baseline-identity-birth', identity)
    return access.ref(side, table, row.original.sourceRowId)
  }
  const projected = new Map<string, Navigation3FinalDocument | Navigation3FinalBlock | null>()
  function project(side: Side, kind: 'document', identity: OriginalIdentity): Navigation3FinalDocument | null
  function project(side: Side, kind: 'block', identity: OriginalIdentity): Navigation3FinalBlock | null
  function project(side: Side, kind: 'document' | 'block', identity: OriginalIdentity): Navigation3FinalDocument | Navigation3FinalBlock | null {
    const key = graph3Key(side, kind, identity), cached = projected.get(key)
    if (cached !== undefined) return cached
    const ref = evidence(side, kind, identity), target = (kind === 'document' ? documents : physical).get(identity.targetId)
    const valid = target && target.birth === identity.birth && (same(target.sourceRef, ref) || side === 'current' && same(target.replaces, ref))
    const value = valid ? target : null
    projected.set(key, value); return value
  }
  const headingNamespaces = new Map(final.headingNamespaces.map(namespace => [namespace.document.id, namespace]))
  type FinalHeading = Navigation3FinalIndex['headingNamespaces'][number]['headings'][number]
  function headingIndex<T extends { key: string; blockId: string | null; text: string }>(headings: readonly T[]) {
    const byKey = new Map<string, T>(), byBlock = new Map<string | null, T[]>()
    for (const heading of headings) { byKey.set(heading.key, heading); const values = byBlock.get(heading.blockId) ?? []; values.push(heading); byBlock.set(heading.blockId, values) }
    return { byKey, byBlock }
  }
  const finalHeadingIndexes = new Map(final.headingNamespaces.map(namespace => [namespace.document.id, headingIndex(namespace.headings)]))
  const originalHeadingIndexes = new Map(([['source', source], ['current', current]] as const).map(([side, baseline]) => [side,
    new Map(baseline.headingNamespaces.map(namespace => [namespace.document.id, headingIndex(namespace.headings)]))] as const))
  const replacedHeadingMaps = new Map<string, Map<string, FinalHeading>>()
  function target(side: Side, destination: Navigation3OriginalDestination): Navigation3MappedTarget {
    const old = destination.target
    if (old.kind === 'unresolved' || old.kind === 'opaque' || old.kind === 'captured-binding') return old
    const document = project(side, 'document', old.document)
    if (!document) return unresolved('original-document-incarnation-not-present-in-final')
    if (old.kind === 'document') return { kind: 'document', documentId: document.id, documentPath: document.path }
    if (old.kind === 'block') {
      const block = project(side, 'block', old.block)
      return block && block.documentId === document.id ? { kind: 'block', documentId: document.id, documentPath: document.path, blockId: block.id }
        : unresolved('original-block-incarnation-or-owner-not-present-in-final')
    }
    const namespace = headingNamespaces.get(document.id)
    if (!namespace) return unresolved('final-heading-namespace-unavailable')
    if (old.location === null) {
      const heading = finalHeadingIndexes.get(document.id)!.byKey.get('$title')
      return heading ? { kind: 'heading', documentId: document.id, documentPath: document.path, headingKey: heading.key, slug: heading.slug }
        : unresolved('final-title-heading-unavailable')
    }
    const location = old.location, block = location.blockIdentity && project(side, 'block', location.blockIdentity)
    const instance = location.instanceIdentity && project(side, 'block', location.instanceIdentity)
    if (!block || location.instanceId !== null && !instance) return unresolved('heading-block-or-instance-incarnation-not-present-in-final')
    const wrapper = graph3Key(instance?.id ?? null, block.id), oldWrapper = graph3Key(location.instanceId, location.blockId)
    if (!old.headingKey.startsWith(oldWrapper + ':')) return unresolved('heading-occurrence-key-not-proved')
    const finalHeadingIndex = finalHeadingIndexes.get(document.id)!, candidates = finalHeadingIndex.byBlock.get(wrapper) ?? []
    const requested = wrapper + old.headingKey.slice(oldWrapper.length)
    let heading = finalHeadingIndex.byKey.get(requested)
    const originalRef = evidence(side, 'block', location.blockIdentity!)
    if (side === 'current' && !same(block.sourceRef, originalRef)) {
      // A whole-cell source replacement does not prove that an old raw HTML or
      // multi-heading ordinal survived. Match exact text multiplicity, or the
      // sole heading of the same actual heading block, never just its slug.
      const mappingKey = graph3Key(side, old.document.id, oldWrapper, document.id, wrapper)
      let mapping = replacedHeadingMaps.get(mappingKey)
      if (!mapping) {
        mapping = new Map<string, FinalHeading>()
        const before = originalHeadingIndexes.get(side)!.get(old.document.id)?.byBlock.get(oldWrapper) ?? []
        const oldBlock = access.identity(side, originalRef.table as 'blocks' | 'synced_group_blocks', location.blockId!)
        if (/^heading-[1-6]$/.test(text(oldBlock.value.type)) && /^heading-[1-6]$/.test(block.block.type) && before.length === 1 && candidates.length === 1)
          mapping.set(before[0].key, candidates[0])
        else {
          const left = new Map<string, typeof before>(), right = new Map<string, typeof candidates>()
          for (const item of before) { const values = left.get(item.text) ?? []; values.push(item); left.set(item.text, values) }
          for (const item of candidates) { const values = right.get(item.text) ?? []; values.push(item); right.set(item.text, values) }
          for (const [text, values] of left) {
            const matches = right.get(text) ?? []
            if (values.length === matches.length) for (let i = 0; i < values.length; i++) mapping.set(values[i].key, matches[i])
          }
        }
        replacedHeadingMaps.set(mappingKey, mapping)
      }
      heading = mapping.get(old.headingKey)
    }
    return heading ? { kind: 'heading', documentId: document.id, documentPath: document.path, headingKey: heading.key, slug: heading.slug }
      : unresolved('replaced-heading-occurrence-not-proved')
  }
  const scopes: Navigation3ContextScope[] = []
  for (const [side, baseline] of [['source', source], ['current', current]] as const) for (const scope of baseline.scopes) {
    const document = project(side, 'document', scope.document), finalDocumentId = document?.id ?? null
    const blocks = scope.blocks.map(entry => {
      const location = entry.location, ref = access.ref(side, location.table, location.sourceRowId)
      const cell = selectedCells.get(graph3Key(refKey(ref), location.column)) ?? null
      let finalOccurrenceKey: string | null = null
      if (cell && document) {
        if (scope.field === 'summary') finalOccurrenceKey = finalScopes.get(graph3Key(document.id, 'summary'))?.blocks[0]?.occurrenceKey ?? null
        else if (location.blockIdentity) {
          const block = project(side, 'block', location.blockIdentity), instance = location.instanceIdentity && project(side, 'block', location.instanceIdentity)
          if (block && (location.instanceId === null || instance)) {
            const key = graph3Key(instance?.id ?? null, block.id), observed = occurrences.get(document.id)?.get(key)
            if (observed && same(observed.location.sourceRef, ref)) finalOccurrenceKey = key
          }
        }
      }
      return { ...entry, cell, finalOccurrenceKey }
    })
    const blockByOccurrence = new Map(blocks.map(block => [block.occurrenceKey, block]))
    scopes.push({ ...scope, side, finalDocumentId, blocks, destinations: scope.destinations.map(destination => {
      const entry = blockByOccurrence.get(destination.key.blockId) ?? graph3Conflict('navigation-context-destination-owner', destination.key)
      return { ...destination, cell: entry.cell, finalOccurrenceKey: entry.finalOccurrenceKey, finalTarget: target(side, destination) }
    }) })
  }
  const body = { kind: 'restore-navigation3-source-current-merge-context' as const, version: 1 as const, source, current, scopes, final,
    mergedContentHash: merged.mergedContentHash, permit: false as const }
  assertMerge3JsonBudget(body)
  return freezeCapsuleValue({ ...body, contextHash: hash('knowbook.restore.navigation3.merge-context.v1', body) })
}

type Resolver = (documentId: string, url: string, wiki: boolean) => Navigation3MappedTarget
const resolvers = new WeakMap<Navigation3FinalIndex, Resolver>()
/** Indexes only this pure result. No K/SQL/certification cache or authority. */
export function createFinalNavigation3Resolver(index: Navigation3FinalIndex): Resolver {
  const byId = new Map(index.documents.map(document => [document.id, document]))
  const byPath = new Map<string, Navigation3FinalDocument[]>(), byAsciiPath = new Map<string, Navigation3FinalDocument[]>(), byTitle = new Map<string, Navigation3FinalDocument[]>()
  for (const document of index.documents) for (const [lookup, key] of [[byPath, document.path], [byAsciiPath, ascii(document.path)], [byTitle, ascii(document.title)]] as const) {
    const values = lookup.get(key) ?? []; values.push(document); lookup.set(key, values)
  }
  const blocks = new Map(index.physicalBlocks.filter(block => block.documentId !== null).map(block => [block.id, block]))
  const routes = new Map<string, Navigation3FinalIndex['routes'][number][]>()
  for (const route of index.routes) { const key = graph3Key(route.path, route.blockId), values = routes.get(key) ?? []; values.push(route); routes.set(key, values) }
  const headingIndexes = new Map(index.headingNamespaces.map(namespace => {
    const slug = new Map<string, typeof namespace.headings[number]>(), normalizedText = new Map<string, typeof namespace.headings[number]>()
    for (const heading of namespace.headings) { if (!slug.has(heading.slug)) slug.set(heading.slug, heading)
      const key = heading.text.normalize('NFC').toLowerCase(); if (!normalizedText.has(key)) normalizedText.set(key, heading) }
    return [namespace.document.id, { slug, normalizedText }] as const
  }))
  class Ambiguous extends Error {}
  const lookup = (path: string, wiki: boolean) => {
    const values = byPath.get(path) ?? (wiki ? byAsciiPath.get(ascii(path)) : undefined) ?? []
    if (values.length > 1) throw new Ambiguous('ambiguous-final-path')
    return values[0]
  }
  const blockAt = (path: string, fragment: string, localDocumentId?: string): Navigation3FinalTarget | null => {
    const id = fragment.startsWith('^') ? fragment.slice(1) : fragment, block = blocks.get(id)
    if (!block) return null
    const document = byId.get(block.documentId!)
    if (!document) return null
    const route = routes.has(graph3Key(path, id))
    if (localDocumentId !== undefined && document.id !== localDocumentId && !route || document.path !== path && !route) return null
    return { kind: 'block', documentId: document.id, documentPath: document.path, blockId: block.id }
  }
  const bareWikiBlock = (document: Navigation3FinalDocument, token: string): Navigation3FinalTarget | null => {
    const block = blocks.get(token)
    if (block?.documentId === document.id) return { kind: 'block', documentId: document.id, documentPath: document.path, blockId: block.id }
    const id = token.startsWith('^') ? token.slice(1) : token
    return routes.has(graph3Key(document.path, id)) ? blockAt(document.path, token) : null
  }
  return (documentId, url, wiki) => {
    const source = byId.get(documentId)
    if (!source) return unresolved('final-source-document-missing')
    const reference = wiki ? parseWikiReference(url) : null, local = wiki ? null : parseLocalMarkdownUrl(url)
    const resolved = wiki ? null : resolveMarkdownDocumentPath(source.path, url)
    if (!wiki && !resolved) return local && /\.md$/i.test(local.path) ? unresolved('invalid-final-local-path') : { kind: 'opaque', reason: 'image-or-external-or-asset' }
    try {
      let destination: Navigation3FinalDocument | undefined, fragment: string, path: string
      if (wiki) {
        const found = !reference!.path && reference!.hasFragment ? { document: source, reference: reference! }
          : resolveWikiDocument(url, source.path, { byPath: path => lookup(path, true), byTitle: title => {
            const values = byTitle.get(ascii(title)) ?? []
            if (values.length > 1) throw new Ambiguous('ambiguous-final-title')
            return values
          } })
        if (!found) {
          if (!reference!.hasFragment) { const block = bareWikiBlock(source, reference!.target); if (block) return block }
          let routeReference = reference!
          const hash = routeReference.target.lastIndexOf('#')
          if (hash >= 0 && /[#|]/.test(routeReference.target.slice(0, hash))) routeReference = { ...routeReference,
            path: routeReference.target.slice(0, hash), fragment: routeReference.target.slice(hash + 1), hasFragment: true }
          if (routeReference.fragment) for (const path of wikiDocumentPaths(routeReference.path, source.path)) {
            const block = blockAt(path, routeReference.fragment); if (block) return block
          }
          return unresolved('final-document-missing')
        }
        destination = found.document; fragment = found.reference.fragment; path = found.document.path
      } else {
        path = resolved!.path; fragment = resolved!.fragment
        if (fragment) { const block = blockAt(path, fragment, !local!.path ? source.id : undefined); if (block) return block }
        destination = !local!.path ? source : lookup(path, false)
      }
      if (!destination) return unresolved('final-document-missing')
      if (!fragment) return { kind: 'document', documentId: destination.id, documentPath: destination.path }
      const block = blockAt(destination.path, fragment, destination.id)
      if (block) return block
      if (fragment.startsWith('^') || wiki && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(fragment)) return unresolved('final-block-missing')
      const headings = headingIndexes.get(destination.id)
      const heading = headings?.slug.get(fragment) ?? (wiki ? headings?.normalizedText.get(fragment.normalize('NFC').toLowerCase()) : undefined)
      return heading ? { kind: 'heading', documentId: destination.id, documentPath: destination.path, headingKey: heading.key, slug: heading.slug }
        : unresolved('final-heading-missing')
    } catch (error) { if (error instanceof Ambiguous) return unresolved(error.message); throw error }
  }
}
export function resolveFinalNavigation3(index: Navigation3FinalIndex, documentId: string, url: string, wiki: boolean): Navigation3MappedTarget {
  let resolver = resolvers.get(index)
  if (!resolver) { resolver = createFinalNavigation3Resolver(index); resolvers.set(index, resolver) }
  return resolver(documentId, url, wiki)
}
