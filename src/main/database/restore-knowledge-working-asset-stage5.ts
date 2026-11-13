import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { collectStoredMarkdownAssetDestinations, projectSyncedPortableMarkdownAssetEdits } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCapsule2AssetManifest } from './restore-knowledge-capsule2-assets-files'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget, type Merge3OriginalRowRef, type MergedRow3 } from './restore-knowledge-merge3-storage'
import { applyNavigation3TextEdits, createNavigation3RangeProjection } from './restore-knowledge-navigation3-rewrite-cells'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { assertOriginalFrameDirectory, writeOriginalFrameDirectory, type OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import { pendingLocalCellTextHash5 } from './restore-knowledge-pending-local-cell5'
import { assertRootRestoreReferenceOriginalBytes3, readRootRestoreReferenceCopySource3,
  type RootRestoreReferencePlan3, type RootRestoreStageInputs5 } from './restore-knowledge-reference3-read'
import { readRootRestoreWorkingAssetSources5 } from './restore-knowledge-working-asset-authority5'
import { projectWorkingAssetBodyCells5, workingAssetCellPosition5, workingAssetPosition5 } from './restore-knowledge-working-asset-cells5'
import { selectRootRestoreNativeAssetScopes5, type NativeAssetCellContext5 } from './restore-knowledge-selected-native-assets5'
import type { ReferenceContextFile } from './restore-knowledge-reference-context-model'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'

export interface RootRestoreWorkingAssetStage5 { readonly kind: 'main-root-restore-working-native-asset-stage5' }
type Actual = Awaited<ReturnType<typeof readRootRestoreWorkingAssetSources5>>
type Occurrence = Actual['value']['roles'][number]['occurrences'][number]
type Sealed = Extract<Occurrence, { status: 'sealed-blob' }>
type Location = Awaited<ReturnType<typeof readRootRestoreReferenceCopySource3>>['location']
type Range = { from: number; to: number; raw: string }
type PendingContext = { kind: 'pending-working-content'; proofHash: string; blockId: string; documentId: string; blockBirth: string;
  afterHash: string; scopeSource: readonly string[]; scopeFrom: number; scopeTo: number }
type Context = NativeAssetCellContext5 | PendingContext | null
type Selection = Range & { sourceRef: Merge3OriginalRowRef; targetRowId: string; column: 'summary' | 'content' | 'blocks_json';
  finalFrom: number; finalTo: number; finalCellHash: string;
  hash: string; bytes: number; logicalName: string; occurrenceIds: string[]; context: Context }
type Format = 2 | 3 | 4
type Locator = { reference: RootRestoreReferencePlan3; stageId: string; expectedManifestHash: string; format: Format }
type Saved = Locator & { directory: string; descriptorText: string; files: readonly ReferenceContextFile[] }
const stages = new WeakMap<RootRestoreWorkingAssetStage5, Saved>()
const fail = (reason: string): never => { throw new Error('Working5 原生正文附件暂存失败：' + reason) }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const collection = (location: Location) => join(location.profileRoot, 'backups', 'database-restore', location.operationId, 'restore-working-native-assets-v5')
export const workingAssetSelectedCellHash5 = (text: string) => hash('knowbook.restore.working5.selected-cell.v1', text)

function by<T>(values: readonly T[], keyOf: (value: T) => string) {
  return new Map(values.map(value => [keyOf(value), value]))
}

/** The runtime candidate and original rows are supplied by the fixed Main
 * reader. This pure data transform owns no IO or stage registry. */
export function selectRootRestoreWorkingAssets5(actual: Actual) {
  return selectAssets(actual, actual.captured.actual.candidate.pendingLocalBody ? 4 : 3)
}
function selectAssets(actual: Actual, format: Format) {
  const candidate = actual.captured.actual.candidate
  if (!candidate.candidateConflictFree || candidate.conflicts.length || !candidate.finalForestValidated)
    return fail('需要同次通过原校验的候选')
  const documents = candidate.tables.find(table => table.name === 'documents') ?? fail('候选缺实际 documents 表')
  const blocks = candidate.tables.find(table => table.name === 'blocks') ?? fail('候选缺实际 blocks 表')
  const address = (row: MergedRow3) => capsuleJson([row.sourceRef.side, row.sourceRef.sourceRowId])
  const selectedRows = by(documents.rows, address), selectedBlocks = by(blocks.rows, address)
  const finalDocuments = new Map<string, Array<Actual['captured']['cells']['physicalBlocks'][number]>>()
  const finalBody = new Map<string, ReturnType<typeof projectWorkingAssetBodyCells5>>()
  const finalBlocks = by(actual.captured.cells.physicalBlocks, row => row.rowKey), finalRows = by(blocks.rows, row => row.key)
  const sortOrder = blocks.columns.indexOf('sort_order')
  for (const physical of actual.captured.cells.physicalBlocks) if (physical.documentId !== null) {
    const list = finalDocuments.get(physical.documentId) ?? []
    list.push(physical); finalDocuments.set(physical.documentId, list)
  }
  const editGroups = new Map<string, Array<Actual['captured']['cells']['ordinaryEdits'][number]>>()
  for (const edit of actual.captured.cells.ordinaryEdits) {
    const list = editGroups.get(edit.rowKey) ?? []
    list.push(edit); editGroups.set(edit.rowKey, list)
  }
  const selections = new Map<string, Selection>(), files = new Map<string, OriginalFrameCopy>()

  function finalCandidateRange(target: MergedRow3, column: Selection['column'], originalText: string, targetText: string, original: Range) {
    const edits = editGroups.get(target.key) ?? []
    if (edits.some(edit => edit.column !== column || capsuleJson(edit.sourceRef) !== capsuleJson(target.sourceRef)))
      return fail('候选导航改写不属于同一原 cell')
    if (applyNavigation3TextEdits(originalText, edits) !== targetText) return null
    const range = createNavigation3RangeProjection(edits)(original.from, original.to)
    return range && targetText.slice(range.from, range.to) === original.raw ? range : null
  }

  function add(target: MergedRow3, column: Selection['column'], original: Range,
    range: { from: number; to: number }, finalText: string, item: Sealed) {
    const file = actual.files.get(item.id) ?? fail('已授权 occurrence 缺实际封存件')
    addFile(target, column, original, range, finalText, item.id, item.logicalName, file, null)
  }
  function addFile(target: MergedRow3, column: Selection['column'], original: Range, range: { from: number; to: number },
    finalText: string, occurrenceId: string, logicalName: string, file: OriginalFrameCopy, context: Context) {
    const localAsset = context?.kind === 'template-content' ? context.asset : null
    const coordinates = [target.sourceRef, target.targetRowId, column, original.from, original.to]
    const key = capsuleJson(localAsset ? [...coordinates, localAsset] : coordinates)
    const previous = selections.get(key), finalCellHash = workingAssetSelectedCellHash5(finalText)
    if (previous) {
      if (previous.hash !== file.sha256 || previous.bytes !== file.bytes || previous.logicalName !== logicalName
        || previous.finalCellHash !== finalCellHash || previous.finalFrom !== range.from || previous.finalTo !== range.to
        || capsuleJson(previous.context) !== capsuleJson(context))
        return fail('同入选原始 cell 的附件证明相冲突')
      previous.occurrenceIds.push(occurrenceId)
    } else selections.set(key, { sourceRef: target.sourceRef, targetRowId: target.targetRowId, column,
      from: original.from, to: original.to, raw: original.raw, finalFrom: range.from, finalTo: range.to, finalCellHash,
      hash: file.sha256, bytes: file.bytes, logicalName, occurrenceIds: [occurrenceId], context })
    const originalFile = files.get(file.sha256)
    if (originalFile && originalFile.bytes !== file.bytes) return fail('同 SHA 封存文件的长度相冲突')
    if (!originalFile) files.set(file.sha256, { ...file, frame: [], path: 'files/' + file.sha256 })
  }

  for (const role of actual.value.roles) {
    const packet = actual.captured.pair[role.role], working = actual.captured.working[role.role]!
    const records = by(working.records, item => capsuleJson([item.jobSettingKey, item.recordKey]))
    const originals = by(graph3Rows(packet.source.sourceContent, 'documents'), row => String(row.value.id))
    const originalBlocks = by(graph3Rows(packet.source.sourceContent, 'blocks'), row => String(row.value.id))
    const physicalDocuments = by(packet.source.physical.documents, row => row.documentId)
    const scopes = by(packet.source.assets.scopes, scope => capsuleJson(scope.source))
    const occurrences = new Map<string, Sealed[]>()
    for (const item of role.occurrences) {
      if (item.status !== 'sealed-blob' || item.evidence.kind !== 'settled-captured-base-alias') continue
      const key = capsuleJson(item.scopeSource), group = occurrences.get(key) ?? []
      group.push(item); occurrences.set(key, group)
    }
    for (const items of occurrences.values()) {
      const first = items[0], savedRecord = records.get(capsuleJson([first.jobSettingKey, first.recordKey]))
      if (!savedRecord || savedRecord.provenance.resultHash !== first.resultHash) return fail('实际 W 原件不属于该入选 scope')
      const record = savedRecord.record
      if (!record || record.kind !== 'document') continue
      const original = originals.get(record.id), scope = scopes.get(capsuleJson(['documents', record.id]))
      if (!original || !scope || typeof original.value.summary !== 'string') continue
      const target = selectedRows.get(capsuleJson([role.role, original.original.sourceRowId]))
      const originalSummary = original.value.summary
      const mappings = new Map<string, string>(), nativeItems: Sealed[] = []
      for (const item of items) {
        if (item.evidence.kind !== 'settled-captured-base-alias') continue
        const matching = item.evidence.witnesses.filter(witness => witness.originalScopeContentHash === scope.contentHash
          && capsuleJson(witness.originalScopeSource) === capsuleJson(scope.source))
        if (!matching.length) continue
        nativeItems.push(item)
        for (const witness of matching) {
          const previous = mappings.get(witness.sourceUri)
          if (previous !== undefined && previous !== item.destination.uri) return fail('同原始 scope URI 的逻辑别名不唯一')
          mappings.set(witness.sourceUri, item.destination.uri)
        }
      }
      if (!nativeItems.length) continue
      const fromOriginal = (item: Sealed, uri: string) => item.destination.uri === mappings.get(uri)
        && item.evidence.kind === 'settled-captured-base-alias' && item.evidence.witnesses.some(witness =>
          witness.sourceUri === uri && witness.originalScopeContentHash === scope.contentHash
          && capsuleJson(witness.originalScopeSource) === capsuleJson(scope.source))
      const portableCell = (source: string, expected: string) => {
        if (collectStoredMarkdownAssetDestinations(source).some(destination => !mappings.has(destination.url))) return null
        const projection = projectSyncedPortableMarkdownAssetEdits(source, uri => mappings.get(uri) ?? fail('原始 cell 仍有未认证附件'))
        if (projection.text !== expected) return null
        return createNavigation3RangeProjection(projection.edits.map(edit => ({ from: edit.from, to: edit.to,
          before: source.slice(edit.from, edit.to), after: edit.text })))
      }

      if (target?.sourceRef.materialHash === packet.materialHash) {
        const projection = portableCell(originalSummary, record.content.summary)
        const finalText = graph3Text(target.cells[documents.columns.indexOf('summary')], documents.encoding)
        const finalDestinations = collectStoredMarkdownAssetDestinations(finalText)
        for (const destination of scope.destinations.filter(item => item.section === 'summary')) {
          if (originalSummary.slice(destination.from, destination.to) !== destination.raw) return fail('原始摘要坐标不相符')
          const portable = projection?.(destination.from, destination.to)
          const final = finalCandidateRange(target, 'summary', originalSummary, finalText, destination)
          if (!portable || !final || !finalDestinations.some(item => item.start === final.from && item.end === final.to
            && item.url === destination.uri && item.kind === destination.kind && (item.syntax ?? 'markdown') === destination.syntax)) continue
          // The replacement can add angle delimiters. The typed output span
          // remains the unique parser destination within this projection.
          const matched = nativeItems.filter(item => item.destination.section === 'summary' && fromOriginal(item, destination.uri)
            && item.destination.from >= portable.from && item.destination.to <= portable.to)
          if (matched.length === 1) add(target, 'summary', destination, final, finalText, matched[0])
        }
      }

      const physical = physicalDocuments.get(record.id)
      if (!physical) continue
      const originalBody = projectWorkingAssetBodyCells5(physical.blocks, 'base')
      if (originalBody.baseProjectionHash !== scope.bodyProjectionHash) return fail('原始正文序列化与封存 scope 不符')
      const workingBody = projectWorkingAssetBodyCells5(record.content.blocks, 'working')
      const workingBlocks = by(record.content.blocks, block => block.id)
      const workingCells = nativeItems.flatMap(item => {
        if (item.destination.section !== 'body') return []
        const cell = workingBody.byBodyPosition.get(workingAssetPosition5(item.destination))
        return cell ? [{ item, cell }] : []
      })
      for (const destination of scope.destinations.filter(item => item.section === 'body')) {
        const cell = originalBody.byBodyPosition.get(workingAssetPosition5(destination))
        if (!cell || cell.raw !== destination.raw) continue
        const originalBlock = originalBlocks.get(cell.blockId), workingBlock = workingBlocks.get(cell.blockId)
        if (!originalBlock || !workingBlock || originalBlock.value.document_id !== record.id || typeof originalBlock.value.content !== 'string') continue
        const chosen = selectedBlocks.get(capsuleJson([role.role, originalBlock.original.sourceRowId]))
        if (!chosen || chosen.sourceRef.materialHash !== packet.materialHash) continue
        const originalText = originalBlock.value.content, finalText = graph3Text(chosen.cells[blocks.columns.indexOf('content')], blocks.encoding)
        if (originalText.slice(cell.from, cell.to) !== cell.raw) return fail('原正文资产坐标与实际 SQL cell 不符')
        const portable = portableCell(originalText, workingBlock.content)?.(cell.from, cell.to)
        const final = finalCandidateRange(chosen, 'content', originalText, finalText, cell), finalBlock = finalBlocks.get(chosen.key)
        if (!portable || !final || !finalBlock?.documentId) continue
        const matched = workingCells.filter(({ item, cell: workingCell }) => workingCell.blockId === cell.blockId
          && fromOriginal(item, destination.uri) && workingCell.from >= portable.from && workingCell.to <= portable.to)
        if (matched.length !== 1) continue
        let projectedFinal = finalBody.get(finalBlock.documentId)
        if (!projectedFinal) {
          const order = (key: string) => {
            const cell = finalRows.get(key)?.cells[sortOrder]
            return cell?.[0] === 'integer' ? BigInt(cell[1]) : fail('候选缺原生正文排序')
          }
          const body = [...(finalDocuments.get(finalBlock.documentId) ?? [])].sort((a, b) => {
            const x = order(a.rowKey), y = order(b.rowKey)
            return x < y ? -1 : x > y ? 1 : compare(a.id, b.id)
          })
          projectedFinal = projectWorkingAssetBodyCells5(body.map(item => item.block), 'base')
          finalBody.set(finalBlock.documentId, projectedFinal)
        }
        const finalOccurrence = projectedFinal.byCellPosition.get(workingAssetCellPosition5(finalBlock.id, { ...final, uri: destination.uri }))
        if (finalOccurrence?.raw === cell.raw && finalOccurrence.kind === cell.kind && finalOccurrence.syntax === cell.syntax)
          add(chosen, 'content', cell, final, finalText, matched[0].item)
      }
    }
  }

  if (format !== 2) for (const asset of selectRootRestoreNativeAssetScopes5(actual))
    addFile(asset.target, asset.column, asset.original, asset.final, asset.finalText, asset.proof.id, asset.proof.logicalName, asset.proof.file, asset.context)
  const pending = candidate.pendingLocalBody
  if (pending) {
    if (format !== 4) return fail('旧附件格式无法携带入选 pending 正文')
    const target = blocks.rows.find(row => row.targetRowId === pending.targetRowId)
    if (!target || capsuleJson(target.sourceRef) !== capsuleJson(pending.sourceRef)) return fail('pending 缺确切入选业务行')
    const content = graph3Text(target.cells[blocks.columns.indexOf('content')], blocks.encoding)
    if (pendingLocalCellTextHash5(content) !== pending.afterHash) return fail('pending 候选正文哈希不相符')
    const role = actual.value.roles.find(value => value.role === pending.sourceRef.side) ?? fail('pending 缺实际原件角色')
    for (const asset of pending.assets) {
      const matches = role.occurrences.filter(item => item.contextHash === pending.contextHash && item.resultHash === pending.resultHash
        && capsuleJson(item.scopeSource) === capsuleJson(pending.scopeSource) && item.destination.section === 'body'
        && item.destination.from === asset.scopeFrom && item.destination.to === asset.scopeTo && item.destination.raw === asset.raw
        && item.destination.uri === asset.uri && item.destination.kind === asset.kind && item.destination.syntax === asset.syntax)
      const item = matches[0]
      if (matches.length !== 1 || item?.status !== 'sealed-blob' || item.evidence.kind !== 'pending-captured-working-context'
        || item.logicalName !== asset.name || content.slice(asset.from, asset.to) !== asset.raw) return fail('pending 缺确切原件位置或逻辑别名')
      const file = actual.files.get(item.id)
      if (!file || file.sha256 !== asset.hash || file.bytes !== asset.bytes) return fail('pending 缺确切封存字节')
      addFile(target, 'content', asset, asset, content, item.id, item.logicalName, file,
        { kind: 'pending-working-content', proofHash: pending.proofHash, blockId: pending.blockId, documentId: pending.documentId,
          blockBirth: pending.blockBirth, afterHash: pending.afterHash, scopeSource: pending.scopeSource, scopeFrom: asset.scopeFrom, scopeTo: asset.scopeTo })
    }
  } else if (format === 4) return fail('pending 附件格式缺实际已入选候选')
  const selected = [...selections].sort(([a], [b]) => compare(a, b)).map(([, value]) => ({ ...value, occurrenceIds: [...new Set(value.occurrenceIds)].sort() }))
  const aliasByKey = by(selected.map(({ hash, bytes, logicalName }) => ({ hash, bytes, logicalName })), alias => capsuleJson([alias.hash, alias.logicalName]))
  const aliases = [...aliasByKey].sort(([a], [b]) => compare(a, b)).map(([, alias]) => alias)
  const copies = [...files.values()].sort((a, b) => compare(a.path, b.path))
  const value = { scope: 'selected-settled-working5-documents-and-native-canonical-template-assets' as const, selected, aliases,
    files: copies.map(({ frame, path, bytes, sha256 }) => ({ frame, path, bytes, sha256 })),
    finalAssetClosureComplete: false as const, acceptedCoverage: false as const, effective: false as const, installPermit: false as const }
  if (format !== 2) assertMerge3JsonBudget(value)
  return { value, copies }
}

function manifest(actual: Actual, stageId: string, selection: ReturnType<typeof selectRootRestoreWorkingAssets5>['value'], format: Format) {
  const shared = { kind: 'root-restore-working-native-asset-stage5' as const,
    stageId, referencePlanId: actual.value.referencePlanId, referenceManifestHash: actual.value.referenceManifestHash,
    checkedCanonicalCandidateHash: actual.captured.actual.candidate.checkedCanonicalCandidateHash,
    assetObservationHash: actual.value.observationHash }
  if (format === 2) {
    // Reproduce the original closed selection shape and hash without v3 context.
    const fields = { ...selection, scope: 'selected-native-document-summary-and-body-settled-working5' as const,
      selected: selection.selected.map(({ context: _context, ...row }) => row) }
    assertMerge3JsonBudget(fields)
    return freezeCapsuleValue({ ...shared, version: 2 as const, selectionHash: hash('knowbook.restore.working5.native-selection.v2', fields), ...fields })
  }
  if (format === 4) {
    const pending = actual.captured.actual.candidate.pendingLocalBody ?? fail('pending 附件清单缺实际选中单元格')
    const fields = { ...selection, scope: 'selected-pending-working5-and-native-assets' as const, pendingCellProofHash: pending.proofHash,
      pendingOccurrences: pending.assets.length }
    assertMerge3JsonBudget(fields)
    return freezeCapsuleValue({ ...shared, version: 4 as const, selectionHash: hash('knowbook.restore.working5.native-selection.v4', fields), ...fields })
  }
  return freezeCapsuleValue({ ...shared, version: 3 as const, selectionHash: hash('knowbook.restore.working5.native-selection.v3', selection), ...selection })
}

async function readStageInputs(reference: RootRestoreReferencePlan3, stageId: string, savedFormat?: Format, scope?: RootRestoreStageInputs5) {
  const source = await readRootRestoreReferenceCopySource3(reference)
  const actual = await readRootRestoreWorkingAssetSources5(reference, scope), pending = actual.captured.actual.candidate.pendingLocalBody
  if (source.pendingCellProofHash !== pending?.proofHash) return fail('附件与 Reference 的 pending 选择不同')
  const format = savedFormat ?? (pending ? 4 : 3), selection = selectAssets(actual, format)
  if (!selection.value.selected.length) return fail('没有具备确切原件证明的入选原生附件')
  const value = manifest(actual, stageId, selection.value, format), text = capsuleJson(value) + '\n'
  return { value, text, manifestHash: capsuleBytesHash(text), files: selection.copies,
    location: source.location, directory: join(collection(source.location), stageId), sources: actual }
}

async function verify(saved: Locator, scope?: RootRestoreStageInputs5) {
  const actual = await readStageInputs(saved.reference, saved.stageId, saved.format, scope)
  if (actual.manifestHash !== saved.expectedManifestHash) return fail('实际候选选择不等于持久清单')
  await assertOriginalFrameDirectory(actual.directory, actual.text, actual.value.files)
  await assertRootRestoreReferenceOriginalBytes3(saved.reference)
  await assertOriginalFrameDirectory(actual.directory, actual.text, actual.value.files)
  return actual
}

function mint(locator: Locator, actual: Awaited<ReturnType<typeof readStageInputs>>) {
  const stage: RootRestoreWorkingAssetStage5 = Object.freeze({ kind: 'main-root-restore-working-native-asset-stage5' })
  stages.set(stage, { ...locator, directory: actual.directory, descriptorText: actual.text, files: actual.value.files })
  return stage
}

/** Only an isolated, non-executable asset sidecar. The existing SQL stage,
 * production restore, links and broader asset closure are separate domains. */
export async function prepareRootRestoreWorkingAssetStage5(reference: RootRestoreReferencePlan3, scope?: RootRestoreStageInputs5) {
  const stageId = randomUUID(), actual = await readStageInputs(reference, stageId, undefined, scope), root = actual.location.profileRoot
  await restoreDirectory(collection(actual.location), root)
  await writeOriginalFrameDirectory({ profileRoot: root, directory: actual.directory, descriptorText: actual.text, files: actual.files })
  await syncRestoreDirectory(collection(actual.location))
  await syncOriginCatalogAncestors(collection(actual.location), root)
  await assertRootRestoreReferenceOriginalBytes3(reference)
  await assertOriginalFrameDirectory(actual.directory, actual.text, actual.value.files)
  const stage = mint({ reference, stageId, expectedManifestHash: actual.manifestHash, format: actual.value.version }, actual)
  return Object.freeze({ stage, value: actual.value, directory: actual.directory, stageId, manifestHash: actual.manifestHash })
}

export async function readRootRestoreWorkingAssetStage5(stage: RootRestoreWorkingAssetStage5) {
  const saved = stages.get(stage)
  if (!saved) return fail('不是实际附件暂存 owner')
  return (await verify(saved)).value
}

/** Same fresh observation and exact original frames used by this asset stage.
 * A closure audit does not need another semantic source read. */
export async function readRootRestoreWorkingAssetStageAndSources5(stage: RootRestoreWorkingAssetStage5, scope?: RootRestoreStageInputs5) {
  const saved = stages.get(stage)
  if (!saved) return fail('不是实际附件暂存 owner')
  const { value, sources, directory } = await verify(saved, scope)
  return Object.freeze({ value, sources, directory })
}

/** Byte tail only, for a same-call composite stage verification. */
export async function assertRootRestoreWorkingAssetStageOriginalBytes5(stage: RootRestoreWorkingAssetStage5) {
  const saved = stages.get(stage)
  if (!saved) return fail('不是实际附件暂存 owner')
  await assertOriginalFrameDirectory(saved.directory, saved.descriptorText, saved.files)
}

export async function reopenRootRestoreWorkingAssetStage5(reference: RootRestoreReferencePlan3,
  locator: { stageId: string; expectedManifestHash: string }, scope?: RootRestoreStageInputs5) {
  const row = capsuleRecord(locator, ['stageId', 'expectedManifestHash'])
  const stageId = durableSqlDagUuid(row.stageId), expectedManifestHash = durableSqlDagHash(row.expectedManifestHash)
  const { location } = await readRootRestoreReferenceCopySource3(reference)
  const path = join(collection(location), stageId, 'descriptor.json'), text = await readCapsule2AssetManifest(path, location.profileRoot)
  if (capsuleBytesHash(text) !== expectedManifestHash) return fail('附件暂存持久哈希不符')
  const descriptor: unknown = JSON.parse(text)
  if (!descriptor || typeof descriptor !== 'object' || !('version' in descriptor)
    || (descriptor.version !== 2 && descriptor.version !== 3 && descriptor.version !== 4)) return fail('未知旧/新附件暂存格式')
  const saved: Locator = { reference, stageId, expectedManifestHash, format: descriptor.version }
  const actual = await verify(saved, scope)
  return Object.freeze({ stage: mint(saved, actual), value: actual.value, directory: actual.directory, stageId: saved.stageId, manifestHash: actual.manifestHash })
}
