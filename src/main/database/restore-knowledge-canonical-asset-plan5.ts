import { join } from 'node:path'
import { localAttachmentFileUrl, managedLocalAttachmentPath } from '../attachments'
import { buildSyncedPortableAssetUri, collectSyncedMarkdownAssetDestinations, localizeSyncedPortableGroupAssets,
  rewriteSyncedGroupAssets } from '../../shared/syncedBlockPortable'
import { escapeMarkdownDestination } from '../../shared/markdownLinks'
import { validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Encode, graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import { applyNavigation3TextEdits, createNavigation3RangeProjection, type Navigation3TextEdit } from './restore-knowledge-navigation3-rewrite-cells'
import { nativeAssetMetadataHash5 } from './restore-knowledge-selected-native-assets5'
import { workingAssetSelectedCellHash5 } from './restore-knowledge-working-asset-stage5'
import { syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { parseSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import type { readRootRestoreAssetAliasSqlSource5 } from './restore-knowledge-asset-alias-stage5'
import { navigation3RowLookup, projectNavigation3TableRows, type Navigation3TableSource } from './restore-knowledge-navigation3-tables'

type Source = Awaited<ReturnType<typeof readRootRestoreAssetAliasSqlSource5>>
const fail = (reason: string): never => { throw new Error('非执行同步正文附件改写失败：' + reason) }
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const occurrence = (id: string, from: number, to: number) => capsuleJson([id, from, to])
const opaque = new Set(['code', 'code-block', 'math', 'frontmatter', 'divider', 'columns', 'column', 'database-view', 'synced-block'])
export interface RootRestoreCanonicalAssetPlan5 {
  readonly tables: readonly Navigation3TableSource[]
  readonly wires: Iterable<SyncedGroupWire> & { readonly length: number }
  readonly facts: { readonly aliasStageId: string; readonly aliasManifestHash: string; readonly basePhysicalObservationHash: string
    readonly assetClosureObservationHash: string; readonly groups: readonly { groupId: string; creationId: string; activationHash: string }[]
    readonly rewrittenOccurrences: number; readonly alreadyLocalOccurrences?: number
    readonly remainingCanonicalOccurrences: number; readonly planHash: string }
}

/** Derive an overlay before the first lifecycle INSERT. Only fresh groups
 * with complete destination proof are eligible for address edits. */
export function deriveRootRestoreCanonicalAssetPlan5(input: Source): RootRestoreCanonicalAssetPlan5 {
  const { physical, referenceActual: actual, audit, matched, location } = input.source
  const current = actual.data.inputs.current.source.sourceContent
  const oldGroups = new Set(graph3Rows(current, 'synced_groups').map(row => row.value.id))
  const oldLifecycle = current.tables.find(table => table.name === 'synced_group_lifecycle') ?? fail('原 current 缺生命周期表')
  const oldLifeIds = new Set(graph3Rows(current, 'synced_group_lifecycle').map(row => row.value.group_id))
  const life = new Map(graph3Rows({ encoding: current.encoding, tables: [{ ...oldLifecycle, rows: physical.lifecycleAdded }] }, 'synced_group_lifecycle')
    .map(row => [row.value.group_id, row.value]))
  const intents = new Map(actual.allocation.materialization.lifecycleIntents.map(intent => [intent.targetGroupId, intent]))
  const ledger = new Map(graph3Rows({ encoding: current.encoding, tables: [physical.ledger] }, 'block_identities').map(row => [row.value.id, row.value]))
  const headerTable = physical.tables.find(table => table.name === 'synced_groups') ?? fail('实际 SQL 缺组表')
  const bodyTable = physical.tables.find(table => table.name === 'synced_group_blocks') ?? fail('实际 SQL 缺正文表')
  const coordinates = new Map<string, Set<string>>([[headerTable.name, new Set()], [bodyTable.name, new Set()]])
  for (const { entry, selection } of matched) {
    const context = selection?.context
    if (entry.domain === 'final-sql' && entry.scope[0] === 'synced_groups' && entry.cell?.column === 'content'
      && entry.proof.kind === 'staged' && context?.kind === 'canonical') {
      coordinates.get(headerTable.name)!.add(context.owner.targetRowId)
      coordinates.get(bodyTable.name)!.add(entry.cell.targetRowId)
    }
  }
  const readHeader = navigation3RowLookup(headerTable, row => row.targetRowId, coordinates.get(headerTable.name)!)
  const readBody = navigation3RowLookup(bodyTable, row => row.targetRowId, coordinates.get(bodyTable.name)!)
  const text = (table: Navigation3TableSource, entry: NonNullable<ReturnType<typeof readHeader>>, column: string) =>
    graph3Text(entry.cells[table.columns.indexOf(column)], table.encoding)
  const aliases = new Map(input.aliases.map(alias => [capsuleJson([alias.hash, alias.logicalName]), alias]))
  const conflicts = new Set(input.remaining.aliasPathConflicts.flat()), assetRoot = join(location.profileRoot, 'storage', 'assets')
  const auditCounts = new Map<string, number>()
  for (const entry of audit.entries) if (entry.domain === 'final-sql' && entry.scope[0] === 'synced_groups')
    auditCounts.set(entry.scope[1], (auditCounts.get(entry.scope[1]) ?? 0) + 1)
  const proofs = new Map<string, Map<string, { uri: string; raw: string; portable: string; local: string }>>()
  let alreadyLocalOccurrences = 0
  for (const { entry, selection } of matched) {
    const { cell, destination, scope } = entry, context = selection?.context
    if (entry.domain !== 'final-sql' || scope[0] !== 'synced_groups' || !selection || context?.kind !== 'canonical' || !cell
      || cell.column !== 'content' || entry.proof.kind !== 'staged') continue
    const { owner } = context, groupId = owner.groupId
    const body = readBody(cell.targetRowId) ?? fail('缺实际 canonical 正文 rowid')
    const header = readHeader(owner.targetRowId) ?? fail('缺实际 canonical 属主 rowid')
    const id = text(bodyTable, body, 'id'), birth = text(bodyTable, body, 'created_at'), identity = ledger.get(id)
    const content = text(bodyTable, body, 'content'), { from, to, raw } = cell.range
    if (!same(body.sourceRef, cell.sourceRef) || !same(header.sourceRef, owner.sourceRef) || scope[1] !== groupId
      || text(bodyTable, body, 'group_id') !== groupId || text(headerTable, header, 'id') !== groupId
      || text(headerTable, header, 'creation_id') !== owner.creationId
      || nativeAssetMetadataHash5(text(headerTable, header, 'origin_json')) !== owner.originJsonHash
      || nativeAssetMetadataHash5(text(headerTable, header, 'bindings_json')) !== owner.bindingsJsonHash
      || !identity || identity.last_owner_kind !== 'group' || identity.last_owner_id !== groupId || identity.state !== 'live'
      || identity.created_at !== birth || content.slice(from, to) !== raw
      || workingAssetSelectedCellHash5(content) !== selection.finalCellHash) return fail('canonical 精确属主、出生或前像不同')
    const { hash, logicalName, bytes } = entry.proof, alias = aliases.get(capsuleJson([hash, logicalName]))
    if (!alias || alias.bytes !== bytes) return fail('canonical 缺原别名字节')
    if (conflicts.has(alias.path)) continue
    const local = localAttachmentFileUrl(join(assetRoot, ...alias.path.split('/')))
    try { managedLocalAttachmentPath(local, assetRoot) } catch { continue }
    if (local === destination.uri && !life.has(groupId)) {
      alreadyLocalOccurrences++
      continue
    }
    if (!life.has(groupId)) continue
    const portable = buildSyncedPortableAssetUri({ hash, name: logicalName })
    const group = proofs.get(groupId) ?? new Map()
    const key = occurrence(id, from, to)
    if (group.has(key)) return fail('canonical 附件范围重复')
    group.set(key, { uri: destination.uri, raw, portable, local })
    proofs.set(groupId, group)
  }
  const bodyChanges = new Map<string, string>(), bindingChanges = new Map<string, string>()
  const localized = new Map<string, ReturnType<typeof validateSyncedGroupWire>>()
  let rewrittenOccurrences = 0
  for (const wire of actual.candidate.activeGroupWires) {
    const group = proofs.get(wire.id)
    if (!group || auditCounts.get(wire.id) !== group.size) continue
    const fresh = life.get(wire.id), intent = intents.get(wire.id)
    if (oldGroups.has(wire.id) || oldLifeIds.has(wire.id) || intent?.mode !== 'new-import-materialization'
      || intent.targetCreationId !== wire.creationId || !fresh || fresh.creation_id !== wire.creationId || fresh.state !== 'active'
      || fresh.state_version !== 1n || fresh.exposure_state !== 'unknown' || fresh.create_history_id !== null
      || fresh.activation_hash !== syncedLifecycleSemanticHash(wire)) return fail('目标不是实际新导入 activation')
    const edits = new Map<string, Navigation3TextEdit[]>(), toPortable = new Map<string, string>(), toLocal = new Map<string, string>()
    let complete = true, occurrences = 0
    for (const block of wire.blocks) for (const destination of opaque.has(block.type) ? [] : collectSyncedMarkdownAssetDestinations(block.content)) {
      const proof = group.get(occurrence(block.id, destination.start, destination.end))
      if (!proof || proof.uri !== destination.url || proof.raw !== block.content.slice(destination.start, destination.end)
        || toPortable.has(proof.uri) && toPortable.get(proof.uri) !== proof.portable
        || toLocal.has(proof.portable) && toLocal.get(proof.portable) !== proof.local) { complete = false; continue }
      const list = edits.get(block.id) ?? []
      const { start, end, syntax, kind } = destination
      const angled = block.content[start - 1] === '<' && block.content[end] === '>'
      if (kind === 'autolink') {
        const label = proof.raw.replace(/[\\\[\]]/g, '\\$&')
        const brackets = syntax === 'bare' ? 0 : 1
        list.push({ from: start - brackets, to: end + brackets, before: block.content.slice(start - brackets, end + brackets),
          after: '[' + label + '](<' + proof.local + '>)' })
      } else {
        const after = syntax ? escapeMarkdownDestination(proof.local, syntax) : angled ? proof.local : '<' + proof.local + '>'
        list.push({ from: start, to: end, before: proof.raw, after })
      }
      edits.set(block.id, list); toPortable.set(proof.uri, proof.portable); toLocal.set(proof.portable, proof.local); occurrences++
    }
    if (!complete || occurrences !== group.size) continue
    const portable = rewriteSyncedGroupAssets(wire, uri => toPortable.get(uri) ?? fail('原组资产闭集不同'))
    const next = localizeSyncedPortableGroupAssets(portable, uri => toLocal.get(uri) ?? fail('portable 资产闭集不同'))
    const reverse = new Map([...toLocal].map(([portable, local]) => [local, portable]))
    if (!same(rewriteSyncedGroupAssets(next, uri => reverse.get(uri) ?? fail('本机别名闭集不同')), portable))
      return fail('canonical portable 往返不同')
    const blocks = wire.blocks.map(block => {
      const items = edits.get(block.id)
      return items ? { ...block, content: applyNavigation3TextEdits(block.content, items) } : block
    })
    const ranges = new Map([...edits].map(([id, items]) => [id, createNavigation3RangeProjection(items)]))
    const byId = new Map(blocks.map(block => [block.id, block]))
    const bindings = wire.bindings.map(binding => {
      const move = ranges.get(binding.blockId)
      const range = move ? move(binding.from, binding.to) : { from: binding.from, to: binding.to }
      if (!range || byId.get(binding.blockId)?.content.slice(range.from, range.to) !== binding.raw)
        return fail('canonical 绑定跨附件范围或原文本改变')
      return { ...binding, ...range }
    })
    if (!same(next, { ...wire, blocks, bindings }) || !same(parseSyncedBindingOccurrences(next.origin, next.blocks)
      .map(({ url: _url, ...key }) => capsuleJson(key)).sort(), next.bindings.map(({ target: _target, ...key }) => capsuleJson(key)).sort()))
      return fail('canonical UTF-16 编辑或整组绑定不一致')
    if (same(next, wire)) continue
    for (const [index, block] of next.blocks.entries()) if (block.content !== wire.blocks[index].content) bodyChanges.set(block.id, block.content)
    if (!same(next.bindings, wire.bindings)) bindingChanges.set(wire.id, capsuleJson(next.bindings))
    localized.set(wire.id, next); rewrittenOccurrences += occurrences
  }
  const remainingCanonicalOccurrences = [...auditCounts.values()].reduce((total, count) => total + count, 0)
    - rewrittenOccurrences - alreadyLocalOccurrences
  if (!localized.size && remainingCanonicalOccurrences) return fail('没有全组附件原件已闭合的新组')
  const tables = actual.candidate.tables.map(table => {
    const changes = table.name === 'synced_group_blocks' ? bodyChanges : table.name === 'synced_groups' ? bindingChanges : undefined
    if (!changes?.size) return table
    const idColumn = table.columns.indexOf('id'), column = table.columns.indexOf(table.name === 'synced_groups' ? 'bindings_json' : 'content')
    return projectNavigation3TableRows(table, row => {
      const value = changes.get(graph3Text(row.cells[idColumn], table.encoding))
      return value === undefined ? row : { ...row, cells: row.cells.map((cell, index) => index === column ? graph3Encode(value, table.encoding) : cell) }
    })
  })
  const groups = [...localized.values()].map(wire => ({ groupId: wire.id, creationId: wire.creationId, activationHash: syncedLifecycleSemanticHash(wire) }))
  const facts = { aliasStageId: input.stageId, aliasManifestHash: input.manifestHash, basePhysicalObservationHash: physical.physicalObservationHash,
    assetClosureObservationHash: audit.observationHash, groups, rewrittenOccurrences,
    ...(alreadyLocalOccurrences ? { alreadyLocalOccurrences } : {}), remainingCanonicalOccurrences }
  const originalWires = actual.candidate.activeGroupWires
  const wires = Object.freeze({ length: originalWires.length, *[Symbol.iterator]() {
    for (const wire of originalWires) yield localized.get(wire.id) ?? wire
  } })
  return Object.freeze({ tables: Object.freeze(tables), wires,
    facts: freezeCapsuleValue({ ...facts, planHash: capsuleBytesHash('knowbook.restore.canonical-asset-plan.v1\0' + capsuleJson(facts)) }) })
}
