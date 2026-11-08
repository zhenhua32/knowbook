import { parseSyncedPortableAssetUri, type SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import { isSyncedBlockId } from '../../shared/syncedBlockValidation'
import * as exchange from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { projectCapturedBaseDocumentPortable5 } from './restore-knowledge-assets5-working-portable-derive'
import { root3SupplementOriginalRowHash3 } from './restore-knowledge-assets3-context'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Conflict, graph3Rows } from './restore-knowledge-graph3-data'
import type { readRootRestoreIdentityInputsAndOriginals5 } from './restore-knowledge-identity3-read'
import { projectWorkingAssetBodyCells5, workingAssetPosition5 } from './restore-knowledge-working-asset-cells5'

export interface PendingLocalComponentLocator5 {
  readonly kind: 'restore-pending-local-component'; readonly version: 1; readonly side: 'source'
  readonly archiveHash: string; readonly workingManifestHash: string
  readonly operationId: string; readonly attemptId: string; readonly jobHash: string; readonly contextHash: string
  readonly planHash: string; readonly componentHash: string; readonly recordKey: string; readonly localFinalHash: string
}
interface PendingBodyAsset5 {
  readonly from: number; readonly to: number; readonly raw: string; readonly uri: string; readonly kind: string; readonly syntax: string
  readonly scopeFrom: number; readonly scopeTo: number; readonly hash: string; readonly name: string; readonly bytes: number
}
export interface SelectedPendingLocalBody5 {
  readonly locator: PendingLocalComponentLocator5; readonly sourceMaterialHash: string; readonly sourceRowId: string
  readonly documentId: string; readonly documentBirth: string; readonly blockId: string; readonly blockBirth: string
  readonly before: string; readonly after: string; readonly scopeSource: readonly string[]; readonly assets: readonly PendingBodyAsset5[]
}

type Actual = Pick<Awaited<ReturnType<typeof readRootRestoreIdentityInputsAndOriginals5>>, 'pair' | 'working'>
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fail = (reason: string): never => graph3Conflict('pending-local-component-' + reason, null)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const locatorKeys = ['kind', 'version', 'side', 'archiveHash', 'workingManifestHash', 'operationId', 'attemptId', 'jobHash',
  'contextHash', 'planHash', 'componentHash', 'recordKey', 'localFinalHash']

export function pendingLocalComponentHash5(component: exchange.ExchangeComponent) {
  return hash('knowbook.restore.pending-local-component.v1', component)
}

export function parsePendingLocalComponentLocator5(input: unknown): PendingLocalComponentLocator5 {
  const row = capsuleRecord(input, locatorKeys)
  if (row.kind !== 'restore-pending-local-component' || row.version !== 1 || row.side !== 'source'
    || typeof row.recordKey !== 'string' || row.recordKey.length > 1024 || !row.recordKey.startsWith('doc:')
    || !isSyncedBlockId(row.recordKey.slice(4))) return fail('locator')
  return Object.freeze({ kind: row.kind, version: row.version, side: row.side, recordKey: row.recordKey,
    operationId: durableSqlDagUuid(row.operationId), attemptId: durableSqlDagUuid(row.attemptId),
    archiveHash: durableSqlDagHash(row.archiveHash), workingManifestHash: durableSqlDagHash(row.workingManifestHash),
    jobHash: durableSqlDagHash(row.jobHash), contextHash: durableSqlDagHash(row.contextHash), planHash: durableSqlDagHash(row.planHash),
    componentHash: durableSqlDagHash(row.componentHash), localFinalHash: durableSqlDagHash(row.localFinalHash) })
}

function singleParagraphDiff(before: SyncedPortableHostRecord, after: SyncedPortableHostRecord) {
  const { blocks: previous, ...previousContent } = before.content, { blocks: next, ...nextContent } = after.content
  if (previous.length !== next.length || !same({ ...before, content: previousContent }, { ...after, content: nextContent })
    || previous.some(block => block.type === 'synced-block')) return fail('whole-document-shape')
  const changed = previous.flatMap((block, index) => {
    const { content: oldContent, ...oldFields } = block, { content: newContent, ...newFields } = next[index]
    if (!same(oldFields, newFields)) return fail('whole-forest-shape')
    return oldContent === newContent ? [] : [next[index]]
  })
  if (changed.length !== 1 || changed[0].type !== 'paragraph' || changed[0].depth !== 0 || changed[0].parentBlockId !== null)
    return fail('single-native-paragraph')
  return changed[0]
}

/** Pure validation over the caller's same-read Main packets. A locator names
 * original evidence only. No receipt, execution row or authority is minted. */
export function deriveSelectedPendingLocalBody5(captured: Actual, locator: PendingLocalComponentLocator5): SelectedPendingLocalBody5 {
  const packet = captured.pair.source, working = captured.working.source, archive = packet.assetArchive
  if (!working || archive.version !== 5 || packet.assetArchiveHash !== locator.archiveHash
    || working.manifestHash !== locator.workingManifestHash || working.manifest.sourceContentHash !== archive.sourceContentHash)
    return fail('original-role')
  const raw = packet.source.sourceContent, settings = graph3Rows(raw, 'app_settings')
  const jobKey = exchange.exchangeJobKey(locator.operationId, locator.attemptId)
  const jobRow = settings.find(row => row.value.key === jobKey)
  if (!jobRow || typeof jobRow.value.value !== 'string') return fail('original-job')
  const job = exchange.validateExchangeJob(exchange.parseExchangeStored(jobRow.value.value))
  if (job.version !== 4 || job.request.operationId !== locator.operationId || job.attemptId !== locator.attemptId
    || exchange.exchangeJobHash(job) !== locator.jobHash || publicationJson(job) !== jobRow.value.value
    || jobRow.value.updated_at !== job.preparedAt || job.workspaceScope !== raw.workspaceScope || job.recoveryEpoch !== raw.recoveryEpoch
    || job.descriptor.planHash !== locator.planHash || job.deletions.some(entry => entry.key === locator.recordKey)) return fail('job-binding')
  const head = settings.find(row => row.value.key === exchange.exchangeJobHeadKey(locator.operationId))
  if (head?.value.value !== publicationJson({ kind: 'synced-exchange-job-head', version: 1, operationId: locator.operationId,
    requestHash: job.requestHash, attemptId: locator.attemptId, attemptIndex: job.attemptIndex, jobHash: locator.jobHash })) return fail('job-head')
  const phaseKey = (sequence: number) => exchange.exchangeJobPhaseKey(locator.operationId, locator.attemptId, sequence)
  const phasePrefix = phaseKey(0).slice(0, -1)
  const phaseRows = settings.filter(row => typeof row.value.key === 'string' && row.value.key.startsWith(phasePrefix))
  if (phaseRows.length !== 2 || graph3Rows(raw, 'synced_operations').some(row => row.value.client_operation_id === locator.operationId))
    return fail('phase-or-receipt')
  let previousFactHash: string | null = null
  for (const [sequence, phase] of ['prepared', 'possible'].entries()) {
    const phaseRow = phaseRows.find(row => row.value.key === phaseKey(sequence))
    if (!phaseRow || typeof phaseRow.value.value !== 'string') return fail('phase-row')
    const fact = exchange.validateExchangeJobPhase(exchange.parseExchangeStored(phaseRow.value.value))
    if (fact.version !== 1 || fact.operationId !== locator.operationId || fact.attemptId !== locator.attemptId || fact.sequence !== sequence
      || fact.previousFactHash !== previousFactHash || fact.requestHash !== job.requestHash || fact.jobHash !== locator.jobHash
      || fact.phase !== phase || fact.remoteEtag !== null || phaseRow.value.updated_at !== fact.recordedAt
      || sequence === 0 && fact.recordedAt !== job.preparedAt || publicationJson(fact) !== phaseRow.value.value) return fail('phase-chain')
    previousFactHash = publicationHash(phaseRow.value.value)
  }
  const originalJob = working.manifest.captures.find(row => row.jobSettingKey === jobKey)
  if (originalJob?.state !== 'captured' || originalJob.sourceRowId !== jobRow.original.sourceRowId
    || originalJob.originalRowHash !== root3SupplementOriginalRowHash3(raw, jobRow)) return fail('working-capture')
  const records = working.records.filter(row => row.jobSettingKey === jobKey && row.recordKey === locator.recordKey)
  const record = records[0], provenance = job.merges.find(row => row.key === locator.recordKey)
  if (records.length !== 1 || !record || !('replayedLocalFinal' in record) || !provenance || !same(record.provenance, provenance))
    return fail('working-record')
  const local = record.replayedLocalFinal
  const component = job.components.find(value => value.keys.includes(locator.recordKey))
  if (!local.localApply || local.remoteOnly || !local.entry || local.entry.record.kind !== 'document' || !component
    || !same(component.keys, [locator.recordKey]) || !same(local.component, component) || pendingLocalComponentHash5(component) !== locator.componentHash
    || local.planHash !== locator.planHash || local.entry.key !== locator.recordKey || local.entry.hash !== locator.localFinalHash
    || local.entry.hash !== provenance.resultHash || publicationHash(publicationJson(local.entry.record)) !== local.entry.hash
    || !same(local.entry.record, record.record)) return fail('local-final')
  const final = local.entry.record, documentId = locator.recordKey.slice(4), base = working.baseCommitment
  if (final.id !== documentId) return fail('document-key')
  const projected = projectCapturedBaseDocumentPortable5({ source: packet.source, referenceCapture: { ...base, version: 2 },
    binding: { baseProjectionManifestHash: base.baseManifestHash, baseProjectionMaterialHash: base.baseMaterialHash } }, documentId)
  if (!projected || publicationHash(publicationJson(projected.record)) !== provenance.localHash) return fail('original-local-record')
  const paragraph = singleParagraphDiff(projected.record, final)
  const original = graph3Rows(raw, 'blocks').find(row => row.value.id === paragraph.id)
  if (!original || original.value.document_id !== documentId || original.value.type !== 'paragraph'
    || typeof original.value.created_at !== 'string' || typeof original.value.content !== 'string') return fail('original-block')
  const previousProjection = projectWorkingAssetBodyCells5(projected.record.content.blocks, 'working')
  if ([...previousProjection.byBodyPosition.values()].some(value => value.blockId === paragraph.id)) return fail('original-cell-has-assets')
  const scopeSource = ['root5-merge-working-scope-v1', 'app_settings', jobKey, 'value', 'merges', locator.recordKey, 'working-record']
  const scope = working.observation.scopes.find(value => same(value.source, scopeSource))
  if (!scope || scope.evidenceKind !== 'replayed-original-working-inputs' || scope.jobHash !== locator.jobHash
    || scope.contextHash !== locator.contextHash || scope.resultHash !== local.entry.hash) return fail('original-asset-scope')
  const finalProjection = projectWorkingAssetBodyCells5(final.content.blocks, 'working'), assets: PendingBodyAsset5[] = []
  const bindings = working.observation.pendingPortableBindings.filter(value => same(value.scopeSource, scopeSource))
  const descriptorHash = publicationHash(publicationJson(job.descriptor))
  for (const destination of scope.destinations) if (destination.section === 'body') {
    const cell = finalProjection.byBodyPosition.get(workingAssetPosition5(destination))
    if (!cell || cell.raw !== destination.raw) return fail('physical-working-asset-range')
    if (cell.blockId !== paragraph.id) continue
    const portable = parseSyncedPortableAssetUri(destination.uri)
    const matches = bindings.filter(value => value.section === destination.section && value.from === destination.from && value.to === destination.to
      && value.sourceUri === destination.uri && value.contextHash === locator.contextHash)
    const proof = matches[0]
    if (matches.length !== 1 || !proof || proof.hash !== portable.hash || proof.name !== portable.name || proof.descriptorHash !== descriptorHash)
      return fail('asset-context-binding')
    assets.push({ from: cell.from, to: cell.to, raw: cell.raw, uri: cell.uri, kind: cell.kind, syntax: cell.syntax,
      scopeFrom: destination.from, scopeTo: destination.to, hash: proof.hash, name: proof.name, bytes: proof.bytes })
  }
  if (!assets.length) return fail('empty-working-cell-assets')
  return freezeCapsuleValue({ locator, sourceMaterialHash: packet.materialHash, sourceRowId: original.original.sourceRowId,
    documentId, documentBirth: final.createdAt, blockId: paragraph.id, blockBirth: original.value.created_at, before: original.value.content,
    after: paragraph.content, scopeSource, assets })
}
