import type { MarkdownRenderableBlock } from '../../shared/markdown'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { collectStoredMarkdownAssetDestinations, parseSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson } from './restore-knowledge-capsule-model'
import { capsule2CombinedAssetUris3 } from './restore-knowledge-capsule2-asset-supplement-model'
import { capsule2CombinedAssetUris4 } from './restore-knowledge-capsule2-asset-supplement4-model'
import { capsule5CombinedAssetUris5 } from './restore-knowledge-capsule5-asset-supplement-model'
import { CAPSULE_V3_ASSET_MAX_FILE_BYTES } from './restore-knowledge-capsule-v3-assets'
import { logicalFileAsset } from './restore-knowledge-assets5-working-portable-derive'
import { transformCanonical3Cell, type Canonical3TextEdit } from './restore-knowledge-canonical3-cells'
import { graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import type { Merge3OriginalRowRef, MergedRow3 } from './restore-knowledge-merge3-storage'
import { applyNavigation3TextEdits, createNavigation3RangeProjection } from './restore-knowledge-navigation3-rewrite-cells'
import { mixedOriginCapsulePath } from './restore-knowledge-mixed-origin-bundle-model'
import type { OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import { referenceContextFileKey } from './restore-knowledge-reference-context-model'
import { template3ContentStringRanges } from './restore-knowledge-template3-json'
import type { readRootRestoreWorkingAssetSources5 } from './restore-knowledge-working-asset-authority5'
import { projectWorkingAssetBodyCells5, workingAssetCellPosition5, workingAssetPosition5 } from './restore-knowledge-working-asset-cells5'

type Actual = Awaited<ReturnType<typeof readRootRestoreWorkingAssetSources5>>
type Content = Actual['captured']['pair']['source']
type Scope = Content['source']['assets']['scopes'][number]
type Destination = Scope['destinations'][number]
type Table = Actual['captured']['actual']['candidate']['tables'][number]
type Range = { from: number; to: number; raw: string }
export type NativeAssetCellContext5 =
  | { kind: 'canonical'; owner: { sourceRef: Merge3OriginalRowRef; targetRowId: string; groupId: string; creationId: string;
    originJsonHash: string; bindingsJsonHash: string } }
  | { kind: 'template-content'; blockIndex: number; localId: string; asset: Range }
  | { kind: 'template-summary' }

export interface VerifiedBackupV3Asset5 {
  readonly snapshotId: string; readonly inventoryHash: string; readonly archiveHash: string
}

type BaseAssetProof = { id: string; logicalName: string; file: OriginalFrameCopy; backupV3?: VerifiedBackupV3Asset5 }

export interface SelectedNativeAsset5 {
  target: MergedRow3
  column: 'content' | 'summary' | 'blocks_json'
  original: Range
  final: { from: number; to: number }
  finalText: string
  context: NativeAssetCellContext5 | null
  proof: BaseAssetProof
}

const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fail = (reason: string): never => { throw new Error('原生 canonical/模板附件范围：' + reason) }
const rowKey = (side: string, rowId: string) => capsuleJson([side, rowId])
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const mapBy = <T>(values: readonly T[], key: (value: T) => string) => new Map(values.map(value => [key(value), value]))
export const nativeAssetMetadataHash5 = (text: string) => hash('knowbook.restore.native-asset-metadata.v1', text)

function cellText(table: Table, row: MergedRow3, column: string) {
  const index = table.columns.indexOf(column)
  if (index < 0) return fail('候选缺实际列 ' + column)
  return graph3Text(row.cells[index], table.encoding)
}

export function bindRootRestoreBaseAssetBlobs5(actual: Actual, side: 'source' | 'current') {
  const packet = actual.captured.pair[side]
  const archive = packet.assetArchive
  if (archive.version === 1) return null
  const original = actual.captured.pair.originalPackage, binding = original.original.node[side]
  if (binding.capsule.operationId !== packet.operationId || binding.capsule.capsuleId !== packet.capsuleId
    || archive.sourceContentHash !== packet.source.assets.sourceContentHash || archive.assetReferencesObservationHash !== packet.source.assets.observationHash)
    return fail('typed base scope 不属于同一角色/capsule')
  const uris = archive.version === 2 || archive.version === 6 || archive.version === 7 || archive.version === 9 ? archive.referenceUris
    : archive.version === 3 ? capsule2CombinedAssetUris3(archive.referenceUris, archive.assetScopeSupplement)
      : archive.version === 4 ? capsule2CombinedAssetUris4(archive.referenceUris, archive.assetScopeSupplement)
        : capsule5CombinedAssetUris5(archive.referenceUris, archive.assetScopeSupplement)
  const index = new Map(uris.map((uri, i) => [uri, i]))
  const files = mapBy(original.files, referenceContextFileKey), inventory = mapBy(archive.tree.files, file => file.hash)
  const actualScopes = new Set(packet.source.assets.scopes)
  const members = new WeakMap<Scope, Set<Destination>>()
  const v3Files = archive.version === 6 ? mapBy(archive.backupV3.files, file => file.relativePath) : null
  const installedV3 = archive.version === 7 || archive.version === 8
    ? archive.installedV3.aliases.map(alias => ({ alias, backupV3: archive.installedV3.backupV3 }))
    : archive.version === 9 || archive.version === 10 ? archive.installedV3Many.aliases : []
  const installedByPath = mapBy(installedV3, entry => entry.alias.relativePath)
  return (scope: Scope, destination: Destination): BaseAssetProof | null => {
    // Call sites pass only real members of this actual original typed scope.
    // An occurrence may remain unresolved even if another role owns its hash.
    if (!actualScopes.has(scope)) return fail('不是本角色封存的 typed scope')
    let destinations = members.get(scope)
    if (!destinations) { destinations = new Set(scope.destinations); members.set(scope, destinations) }
    if (!destinations.has(destination)) return fail('不是精确原 typed occurrence')
    const referenceIndex = index.get(destination.uri)
    if (referenceIndex === undefined) return fail('原 typed destination 不在已认证 base URI 索引')
    const entry = archive.referenceProvenance.entries[referenceIndex]
    if (!entry || entry[0] !== referenceIndex) return fail('原 base 证明缺准确位置')
    if (entry[1] === 'unresolved') return null
    const alias = archive.tree.aliases[entry[2]]
    if (!alias || inventory.get(alias.hash)?.bytes !== alias.bytes) return fail('原 alias 不属于已认证 tree')
    const root = entry[1] === 'file' ? archive.referenceProvenance.rootSpellings[entry[3]] : undefined
    const name = entry[1] === 'portable' ? parseSyncedPortableAssetUri(destination.uri).name
      : root && logicalFileAsset(destination.uri, root.uri, alias.hash)?.name
    if (!name) return null
    const path = mixedOriginCapsulePath(binding, 'knowledge-complete-assets-v2') + '/files/' + alias.hash
    const file = files.get(referenceContextFileKey({ frame: [], path }))
    if (!file || file.sha256 !== alias.hash || file.bytes !== alias.bytes) return fail('本角色 frame 缺准确原附件')
    let backupV3: VerifiedBackupV3Asset5 | undefined
    if (archive.version === 6) {
      const originalV3 = entry[1] === 'portable' && v3Files?.get(syncedPortableAssetBackupPath(destination.uri))
      if (!originalV3 || originalV3.hash !== alias.hash || originalV3.bytes !== alias.bytes || alias.bytes > CAPSULE_V3_ASSET_MAX_FILE_BYTES)
        return fail('V3 原件清单与入选 typed alias 不符')
      backupV3 = { snapshotId: archive.backupV3.snapshotId, inventoryHash: archive.backupV3.inventoryHash, archiveHash: packet.assetArchiveHash }
    } else if (alias.bytes > ATTACHMENT_MAX_FILE_BYTES) {
      const installed = installedByPath.get(alias.relativePath)
      if (!installed || !same(installed.alias, alias)) return fail('旧封存附件超过原 25MiB 预算')
      backupV3 = installed.backupV3
    }
    return { id: hash('knowbook.restore.selected-native-base-asset-occurrence.v1', { side, capsule: binding.capsule,
      archiveHash: packet.assetArchiveHash, scope: scope.source, scopeContentHash: scope.contentHash, destination,
      referenceIndex, aliasIndex: entry[2], hash: alias.hash, bytes: alias.bytes, logicalName: name }), logicalName: name, file,
      ...(backupV3 ? { backupV3 } : {}) }
  }
}

function reprojectCanonicalRange(range: Range, edits: readonly Canonical3TextEdit[]) {
  let shift = 0
  for (const edit of edits) {
    // An insertion at the left edge comes before the old range. An insertion
    // at its right edge is outside this half-open destination. Both use the
    // actual validated canonical edit order, including zero-width links.
    if (edit.key.to <= range.from) shift += edit.after.length - edit.key.raw.length
    else if (edit.key.from < range.to) return null
  }
  return { from: range.from + shift, to: range.to + shift }
}

function selectBackupV3DocumentAssets(actual: Actual, side: 'source' | 'current', documents: Table, blocks: Table,
  scopes: ReadonlyMap<string, Scope>, bindBlob: NonNullable<ReturnType<typeof bindRootRestoreBaseAssetBlobs5>>): SelectedNativeAsset5[] {
  const packet = actual.captured.pair[side], raw = packet.source.sourceContent
  const chosenDocuments = mapBy(documents.rows.filter(row => row.sourceRef.side === side), row => row.sourceRef.sourceRowId)
  const chosenBlocks = mapBy(blocks.rows.filter(row => row.sourceRef.side === side), row => row.sourceRef.sourceRowId)
  const originalDocuments = mapBy(graph3Rows(raw, 'documents'), row => String(row.value.id))
  const originalBlocks = mapBy(graph3Rows(raw, 'blocks'), row => String(row.value.id))
  const editGroups = new Map<string, (typeof actual.captured.cells.ordinaryEdits)[number][]>()
  for (const edit of actual.captured.cells.ordinaryEdits) {
    const list = editGroups.get(edit.rowKey) ?? []
    list.push(edit); editGroups.set(edit.rowKey, list)
  }
  const rowsByKey = mapBy(blocks.rows, row => row.key)
  const physicalByDocument = new Map<string, (typeof actual.captured.cells.physicalBlocks)[number][]>()
  for (const item of actual.captured.cells.physicalBlocks) if (item.documentId !== null) {
    const list = physicalByDocument.get(item.documentId) ?? []
    list.push(item); physicalByDocument.set(item.documentId, list)
  }
  const finalBodies = new Map<string, ReturnType<typeof projectWorkingAssetBodyCells5>>()
  const order = (key: string) => {
    const cell = rowsByKey.get(key)?.cells[blocks.columns.indexOf('sort_order')]
    return cell?.[0] === 'integer' ? BigInt(cell[1]) : fail('最终正文缺实际排序')
  }
  const finalBody = (documentId: string) => {
    let body = finalBodies.get(documentId)
    if (!body) {
      const physical = [...(physicalByDocument.get(documentId) ?? [])].sort((left, right) => {
        const a = order(left.rowKey), b = order(right.rowKey)
        return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      })
      body = projectWorkingAssetBodyCells5(physical.map(item => item.block), 'base')
      finalBodies.set(documentId, body)
    }
    return body
  }
  const selected: SelectedNativeAsset5[] = []
  for (const doc of packet.source.physical.documents) {
    const originalDocument = originalDocuments.get(doc.documentId)
    const scope = scopes.get(capsuleJson(['documents', doc.documentId]))
    if (!originalDocument || !scope?.destinations.length) continue
    const header = chosenDocuments.get(originalDocument.original.sourceRowId)
    if (header?.sourceRef.materialHash !== packet.materialHash) continue
    const documentId = cellText(documents, header, 'id'), body = projectWorkingAssetBodyCells5(doc.blocks, 'base')
    if (body.baseProjectionHash !== scope.bodyProjectionHash) return fail('V3 原正文范围与封存 typed scope 不符')
    const summary = cellText(documents, header, 'summary'), summaryDestinations = collectStoredMarkdownAssetDestinations(summary)
    for (const destination of scope.destinations) {
      const cell = destination.section === 'body' ? body.byBodyPosition.get(workingAssetPosition5(destination)) : undefined
      const originalBlock = cell && originalBlocks.get(cell.blockId)
      if (destination.section === 'body' && (!cell || !originalBlock || originalBlock.value.document_id !== doc.documentId)) continue
      const target = originalBlock ? chosenBlocks.get(originalBlock.original.sourceRowId) : header
      if (target?.sourceRef.materialHash !== packet.materialHash || originalBlock && cellText(blocks, target, 'document_id') !== documentId) continue
      const column = originalBlock ? 'content' : 'summary', original = cell ?? destination
      const oldText = originalBlock ? originalBlock.value.content : originalDocument.value.summary
      const finalText = originalBlock ? cellText(blocks, target, 'content') : summary
      const edits = editGroups.get(target.key) ?? []
      if (edits.some(edit => edit.column !== column || !same(edit.sourceRef, target.sourceRef))) return fail('V3 导航改写不属于原 cell')
      if (typeof oldText !== 'string' || oldText.slice(original.from, original.to) !== original.raw || original.raw !== destination.raw
        || applyNavigation3TextEdits(oldText, edits) !== finalText) continue
      const final = createNavigation3RangeProjection(edits)(original.from, original.to)
      if (!final || finalText.slice(final.from, final.to) !== destination.raw) continue
      if (originalBlock) {
        const blockId = cellText(blocks, target, 'id')
        const occurrence = finalBody(documentId).byCellPosition.get(workingAssetCellPosition5(blockId, { ...final, uri: destination.uri }))
        if (occurrence?.raw !== destination.raw || occurrence.kind !== destination.kind || occurrence.syntax !== destination.syntax) continue
      } else if (!summaryDestinations.some(item => item.start === final.from && item.end === final.to && item.url === destination.uri
        && item.kind === destination.kind && (item.syntax ?? 'markdown') === destination.syntax)) continue
      const proof = bindBlob(scope, destination)
      if (proof) selected.push({ target, column, original, final, finalText, context: null, proof })
    }
  }
  return selected
}

/** Data-only staging requests. Main calls this after its fixed same-read
 * Reference3 + qualified-original owner returns actual packets and candidate. */
export function selectRootRestoreNativeAssetScopes5(actual: Actual): SelectedNativeAsset5[] {
  const candidate = actual.captured.actual.candidate
  const table = (name: string) => candidate.tables.find(table => table.name === name) ?? fail('缺候选表 ' + name)
  const groupTable = table('synced_groups'), blockTable = table('synced_group_blocks'), templates = table('document_templates')
  const selectedGroups = mapBy(groupTable.rows, row => rowKey(row.sourceRef.side, row.sourceRef.sourceRowId))
  const selectedBlocks = mapBy(blockTable.rows, row => rowKey(row.sourceRef.side, row.sourceRef.sourceRowId))
  const selectedTemplates = mapBy(templates.rows, row => rowKey(row.sourceRef.side, row.sourceRef.sourceRowId))
  const finalWires = mapBy(candidate.activeGroupWires, group => group.id)
  const finalBodies = new Map<string, ReturnType<typeof projectWorkingAssetBodyCells5>>()
  const groupEdits = new Map<string, (typeof candidate.canonicalEdits)[number][]>()
  for (const edit of candidate.canonicalEdits) {
    const list = groupEdits.get(edit.rowKey) ?? []
    list.push(edit); groupEdits.set(edit.rowKey, list)
  }
  const selected: SelectedNativeAsset5[] = []

  for (const side of ['source', 'current'] as const) {
    const packet = actual.captured.pair[side], bindBlob = bindRootRestoreBaseAssetBlobs5(actual, side)
    if (!bindBlob) continue
    const raw = packet.source.sourceContent, scopes = mapBy(packet.source.assets.scopes, scope => capsuleJson(scope.source))
    if (packet.assetArchive.version === 6 || packet.assetArchive.version === 7 || packet.assetArchive.version === 8
      || packet.assetArchive.version === 9 || packet.assetArchive.version === 10)
      selected.push(...selectBackupV3DocumentAssets(actual, side, table('documents'), table('blocks'), scopes, bindBlob))
    const belongs = (row: MergedRow3 | undefined): row is MergedRow3 => row !== undefined && row.sourceRef.materialHash === packet.materialHash
    const groupRows = mapBy(graph3Rows(raw, 'synced_groups'), row => String(row.value.id))
    const blockRows = mapBy(graph3Rows(raw, 'synced_group_blocks'), row => String(row.value.id))
    for (const group of packet.source.physical.groups) {
      const snapshot = group.snapshot, owner = groupRows.get(group.groupId), scope = scopes.get(capsuleJson(['synced_groups', group.groupId]))
      if (!snapshot || !owner || !scope?.destinations.length) continue
      const selectedGroup = selectedGroups.get(rowKey(side, owner.original.sourceRowId))
      if (!belongs(selectedGroup)) continue
      const groupId = cellText(groupTable, selectedGroup, 'id'), finalWire = finalWires.get(groupId)
      if (!finalWire) continue
      const creationId = cellText(groupTable, selectedGroup, 'creation_id')
      const origin = cellText(groupTable, selectedGroup, 'origin_json'), bindings = cellText(groupTable, selectedGroup, 'bindings_json')
      if (finalWire.creationId !== creationId || !same(JSON.parse(origin), finalWire.origin) || !same(JSON.parse(bindings), finalWire.bindings))
        return fail('canonical group 候选元数据不是实际最终 wire')
      const context = { kind: 'canonical' as const, owner: { sourceRef: selectedGroup.sourceRef, targetRowId: selectedGroup.targetRowId,
        groupId, creationId, originJsonHash: nativeAssetMetadataHash5(origin), bindingsJsonHash: nativeAssetMetadataHash5(bindings) } }
      const originalBody = projectWorkingAssetBodyCells5(snapshot.blocks, 'base')
      if (originalBody.baseProjectionHash !== scope.bodyProjectionHash) return fail('canonical 完整原 body scope 与原字节不符')
      let finalBody = finalBodies.get(groupId)
      if (!finalBody) { finalBody = projectWorkingAssetBodyCells5(finalWire.blocks, 'base'); finalBodies.set(groupId, finalBody) }
      for (const destination of scope.destinations) {
        if (destination.section !== 'body') continue
        const cell = originalBody.byBodyPosition.get(workingAssetPosition5(destination))
        if (!cell || cell.raw !== destination.raw) continue
        const original = blockRows.get(cell.blockId)
        if (!original || original.value.group_id !== group.groupId || typeof original.value.content !== 'string') continue
        const target = selectedBlocks.get(rowKey(side, original.original.sourceRowId))
        if (!belongs(target) || cellText(blockTable, target, 'group_id') !== groupId) continue
        const finalText = cellText(blockTable, target, 'content'), id = cellText(blockTable, target, 'id')
        const finalBlock = finalWire.blocks.find(block => block.id === id)
        if (!finalBlock || finalBlock.content !== finalText || original.value.content.slice(cell.from, cell.to) !== cell.raw)
          return fail('canonical SQL 单元与实际原/最终 block 不符')
        const edits = groupEdits.get(target.key) ?? []
        if (edits.some(edit => edit.side !== side || edit.key.blockId !== cell.blockId)) return fail('canonical 改写串借原 cell')
        const parsed = snapshot.bindings.filter(binding => binding.blockId === cell.blockId)
        const projected = transformCanonical3Cell(original.value.content, parsed, edits, blockTable.encoding)
        if (projected.text !== finalText) continue
        const final = reprojectCanonicalRange(cell, projected.edits)
        const finalOccurrence = final && finalBody.byCellPosition.get(workingAssetCellPosition5(id, { ...final, uri: destination.uri }))
        if (!final || finalOccurrence?.raw !== cell.raw || finalOccurrence.kind !== cell.kind || finalOccurrence.syntax !== cell.syntax) continue
        const proof = bindBlob(scope, destination)
        if (proof) selected.push({ target, column: 'content', original: cell, final, finalText, context, proof })
      }
    }

    for (const original of graph3Rows(raw, 'document_templates')) {
      const id = original.value.id, sourceJson = original.value.blocks_json, sourceSummary = original.value.summary
      const scope = scopes.get(capsuleJson(['document_templates', id])), target = selectedTemplates.get(rowKey(side, original.original.sourceRowId))
      if (typeof id !== 'string' || typeof sourceJson !== 'string' || typeof sourceSummary !== 'string' || !scope?.destinations.length || !belongs(target)) continue
      const finalJson = cellText(templates, target, 'blocks_json'), finalSummary = cellText(templates, target, 'summary')
      const sourceBlocks = JSON.parse(sourceJson) as MarkdownRenderableBlock[], finalBlocks = JSON.parse(finalJson) as MarkdownRenderableBlock[]
      const sourceTokens = template3ContentStringRanges(sourceJson), finalTokens = template3ContentStringRanges(finalJson)
      const sourceBody = projectWorkingAssetBodyCells5(sourceBlocks, 'base'), finalBody = projectWorkingAssetBodyCells5(finalBlocks, 'base')
      if (sourceBody.baseProjectionHash !== scope.bodyProjectionHash) return fail('模板原完整 scope 与原字节不符')
      const locals = sourceBlocks.flatMap((block, i) => block.id ? [[block.id, { block, i }] as const] : [])
      const sourceByLocalId = new Map(locals)
      if (sourceByLocalId.size !== locals.length) continue
      const finalSummaryDestinations = collectStoredMarkdownAssetDestinations(finalSummary)
      for (const destination of scope.destinations) {
        const proof = bindBlob(scope, destination)
        if (!proof) continue
        if (destination.section === 'summary') {
          if (sourceSummary !== finalSummary || sourceSummary.slice(destination.from, destination.to) !== destination.raw
            || !finalSummaryDestinations.some(item => item.start === destination.from && item.end === destination.to && item.url === destination.uri
              && item.kind === destination.kind && (item.syntax ?? 'markdown') === destination.syntax)) continue
          selected.push({ target, column: 'summary', original: destination, final: destination, finalText: finalSummary,
            context: { kind: 'template-summary' }, proof })
          continue
        }
        const cell = sourceBody.byBodyPosition.get(workingAssetPosition5(destination))
        if (!cell || cell.raw !== destination.raw) continue
        const from = sourceByLocalId.get(cell.blockId)
        if (!from || !same(from.block, finalBlocks[from.i])) continue
        const finalOccurrence = finalBody.byCellPosition.get(workingAssetCellPosition5(cell.blockId, cell))
        if (finalOccurrence?.raw !== cell.raw || finalOccurrence.kind !== cell.kind || finalOccurrence.syntax !== cell.syntax) continue
        const token = sourceTokens[from.i], final = finalTokens[from.i]
        const raw = sourceJson.slice(token.from, token.to)
        if (raw !== finalJson.slice(final.from, final.to) || JSON.parse(raw) !== from.block.content) continue
        selected.push({ target, column: 'blocks_json', original: { ...token, raw }, final, finalText: finalJson,
          context: { kind: 'template-content', blockIndex: from.i, localId: cell.blockId, asset: { from: cell.from, to: cell.to, raw: cell.raw } }, proof })
      }
    }
  }
  return selected
}
