// Main-private draft. Pure validation/replay; these DTOs confer no FS authority.
import { TextDecoder } from 'node:util'
import { assertSyncedShape } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson } from './restore-knowledge-capsule-model'
import type { Capsule2RawContent } from './restore-knowledge-capsule2-raw-model'
import { graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import * as M from '../sync/synced-exchange-model'
import * as C from '../sync/synced-exchange-conflict-model'
import { planSyncedExchange, type ExchangePlanInput } from '../sync/synced-exchange-plan'
import { planSyncedKnowledgeConflicts } from '../sync/synced-exchange-knowledge-plan'
import { validateKnowledgeSource, type KnowledgePlanInput } from '../sync/synced-exchange-knowledge-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot, type SyncedProtocol5Snapshot } from '../sync/synced-protocol5-model'
import { mergeSyncedProtocol5Record } from '../sync/synced-merge'
import { decodeSyncedOperationAck } from './synced-host-operation-receipt'
import type { SyncedGroupOperationRow } from './synced-group-operation-receipt'
import { validateSyncedLogicalDeletionProof } from '../sync/synced-logical-deletion-model'
import { validateSyncedLogicalDeletionChoiceProof } from '../sync/synced-logical-deletion-choice-model'
import { validateSyncedRecoveryHistoryBoundary } from './synced-recovery-boundary-model'

/** Collector reads only genuine-root/storage/synced-exchanges-v1/<op>/<attempt>.
 * No persisted databasePath/request path is an FS root. Bytes live in independent
 * byhash originals, outside the compact archive JSON budget. Collector checks
 * regular files/no reparse/closed directory before minting its private evidence. */
/** Main's genuine context owner may hash a sealed binary by held FD instead
 * of buffering it. This pure DTO grants no blob/read authority; the weak owner
 * still mints a cap from the independently re-opened byhash original. */
export type Root3MergeContextBinary3 = Uint8Array | { readonly kind: 'main-stream-digest'; readonly sha256: string; readonly byteLength: number }
export interface Root3MergeContextBytes3 {
  readonly operationId: string; readonly attemptId: string
  readonly inputBytes: Uint8Array; readonly jobBytes: Uint8Array; readonly readyBytes: Uint8Array
  readonly manifestBytes?: Uint8Array
  readonly objects?: readonly { readonly hash: string; readonly bytes: Root3MergeContextBinary3 }[]
  readonly assets?: readonly { readonly hash: string; readonly names: readonly string[]; readonly bytes: Root3MergeContextBinary3 }[]
}
export interface Root3MergeContextLocator3 {
  readonly operationId: string; readonly attemptId: string; readonly jobSettingKey: string
  readonly sourceRowId: string; readonly originalRowHash: string
  readonly jobHash: string; readonly spoolHash: string; readonly descriptorHash: string; readonly version: 2 | 5
  readonly requiredFiles: readonly string[]
}
export interface Root3SettledWorkingEvidence3 {
  readonly job: M.ExchangeJob
  readonly merged: readonly { readonly recordKey: string; readonly record: SyncedProtocol5Snapshot['records'][number]['record'];
    readonly parts: readonly { readonly id: string; readonly text: string }[]; readonly provenance: C.ExchangeMergeProvenance }[]
  readonly contextHash: string; readonly binding: unknown
}
const fail = (reason: string): never => { throw new Error('Root3 supplemental merge context invalid: ' + reason) }
const same = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b)
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('expected object')
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : fail('expected array')
// Match parseExchangeStored's real maxDepth and original raw-byte budget. No
// new 128MiB input cap: that budget belongs to the compact capsule descriptor.
const parse = (value: Uint8Array) => M.parseExchangeStored(new TextDecoder('utf-8', { fatal: true }).decode(value))
export const root3SupplementSourceContentHash3 = (raw: Capsule2RawContent) =>
  capsuleBytesHash('knowbook.capsule2.workspace-history-source-content.v1\0' + capsuleJson(raw))
export function root3SupplementOriginalRowHash3(raw: Capsule2RawContent, row: ReturnType<typeof graph3Rows>[number]) {
  return capsuleBytesHash('knowbook.restore.merge3.original-row.v1\0' + capsuleJson({ table: row.table.name,
    columns: row.table.columns, primaryKey: row.table.primaryKey, encoding: raw.encoding,
    sourceRowId: row.original.sourceRowId, cells: row.original.cells }))
}
export function root3CustomMergeParts3(request: M.ExchangeRequest) {
  return request.method === 'resolveSyncedExchangeConflicts' ? request.decisions.flatMap(decision =>
    decision.choice === 'merge' ? decision.records.flatMap(record => record.parts.flatMap(part => part.value.choice === 'custom'
      ? [{ componentId: decision.componentId, recordKey: record.key, partId: part.id, text: part.value.text }] : [])) : []) : []
}
export function requiredRoot3MergeContextLocators3(raw: Capsule2RawContent, options: { includeSettled?: boolean } = {}): Root3MergeContextLocator3[] {
  const rows = graph3Rows(raw, 'app_settings'), found: Root3MergeContextLocator3[] = []
  for (const row of rows) {
    if (typeof row.value.key !== 'string' || !row.value.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')) continue
    if (typeof row.value.value !== 'string') return fail('SQL job is not text')
    const job = M.validateExchangeJob(M.parseExchangeStored(row.value.value))
    const custom = root3CustomMergeParts3(job.request)
    // A custom title itself is opaque, but the selected W record still has a
    // real body/summary. Full working-record support needs its original context.
    if (!custom.length) continue
    if (job.version !== 2 && job.version !== 5) return fail('custom request in unsupported job version')
    if (row.value.key !== M.exchangeJobKey(job.request.operationId, job.attemptId)) return fail('SQL job locator mismatch')
    found.push({ operationId: job.request.operationId, attemptId: job.attemptId, jobSettingKey: row.value.key,
      sourceRowId: row.original.sourceRowId, originalRowHash: root3SupplementOriginalRowHash3(raw, row),
      jobHash: M.exchangeJobHash(job), spoolHash: job.spoolHash, descriptorHash: publicationHash(publicationJson(job.descriptor)), version: job.version,
      requiredFiles: ['inputs.json', 'job.json', 'ready.json', 'manifest.json',
        ...new Set(job.descriptor.next.objects.map(item => item.path)), ...job.descriptor.next.assets.map(item => item.path)] })
  }
  found.sort((a, b) => a.jobSettingKey < b.jobSettingKey ? -1 : a.jobSettingKey > b.jobSettingKey ? 1 : 0)
  if (new Set(found.map(row => row.jobSettingKey)).size !== found.length) return fail('repeated SQL job')
  const settled = options.includeSettled ? null : deriveRoot3SettledWorkingEvidence3(raw)
  return settled ? found.filter(row => !settled.has(row.jobSettingKey)) : found
}

/** Reuse only complete ORIGINAL typed W whose whole canonical record hash
 * equals the immutable settled receipt/job resultHash. A same ID, partial ACK,
 * summary literal, local URL filename or today's baseline hash is insufficient.
 * This path authenticates an already retained W, not a fabricated B/L/R replay.
 * The source's total certifier also validates its actual historical receipts;
 * here the relevant original SQL request/job/phase pair is checked again. */
export function deriveRoot3SettledWorkingEvidence3(raw: Capsule2RawContent): Map<string, Root3SettledWorkingEvidence3> {
  const settings = graph3Rows(raw, 'app_settings'), operations = graph3Rows(raw, 'synced_operations')
  const receipts = new Map<string, { row: typeof operations[number]; receipt: M.ExchangeReceipt }>()
  const jobs = new Map<string, { row: typeof settings[number]; job: M.ExchangeJob }>()
  const wanted = new Set<string>()
  for (const row of settings) if (typeof row.value.key === 'string' && row.value.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')) {
    if (typeof row.value.value !== 'string') return fail('original job is not text')
    const job = M.validateExchangeJob(M.parseExchangeStored(row.value.value))
    if ((job.version === 2 || job.version === 5) && root3CustomMergeParts3(job.request).length) {
      jobs.set(row.value.key, { row, job }); for (const merge of job.merges ?? []) wanted.add(merge.resultHash)
    }
  }
  if (!jobs.size) return new Map()
  const sourceContentHash = root3SupplementSourceContentHash3(raw)
  const phasesByJob = new Map<string, Array<{ row: typeof settings[number]; fact: M.ExchangeJobPhaseFact }>>()
  for (const row of settings) if (String(row.value.key).startsWith('sync.webdav.protocol5.exchange-job-phase.v1.')) {
    const fact = M.validateExchangeJobPhase(M.parseExchangeStored(String(row.value.value))), key = M.exchangeJobKey(fact.operationId, fact.attemptId)
    if (!jobs.has(key)) continue
    const list = phasesByJob.get(key) ?? []; list.push({ row, fact }); phasesByJob.set(key, list)
  }
  for (const row of operations) {
    if (typeof row.value.result_json !== 'string') return fail('original operation is not text')
    const value = object(M.parseExchangeStored(row.value.result_json))
    if (value.kind !== 'synced-exchange-operation') continue
    const receipt = M.validateExchangeReceipt(value)
    if ((receipt.version === 2 || receipt.version === 5) && root3CustomMergeParts3(receipt.request).length && receipt.provenance.attemptId)
      receipts.set(M.exchangeJobKey(receipt.request.operationId, receipt.provenance.attemptId), { row, receipt })
  }
  const originals = new Map<string, { record: SyncedProtocol5Snapshot['records'][number]['record']; source: readonly string[]; originalRowsHash: string }>()
  const add = (value: unknown, source: readonly string[], rows: readonly ReturnType<typeof graph3Rows>[number][]) => {
    const candidate = object(value), key = candidate.kind === 'document' ? 'doc:' + candidate.id : candidate.kind === 'synced-group' ? 'group:' + candidate.id : null
    if (!key) return
    const hash = publicationHash(publicationJson(candidate)); if (!wanted.has(hash)) return
    const record = validateSyncedProtocol5Record(candidate, key)
    if (publicationHash(publicationJson(record)) !== hash) return fail('retained W candidate is not exact canonical typed record')
    const proof = { record, source, originalRowsHash: capsuleBytesHash('knowbook.restore.assets3.settled-original-W-rows.v1\0'
      + capsuleJson(rows.map(row => ({ table: row.table.name, rowId: row.original.sourceRowId, hash: root3SupplementOriginalRowHash3(raw, row) })))) }
    const previous = originals.get(hash)
    if (!previous || capsuleJson(source) < capsuleJson(previous.source)) originals.set(hash, proof)
  }
  const wire = (snapshot: Extract<ReturnType<typeof decodeSyncedOperationAck>, { snapshot: unknown }>['snapshot']) => ({ kind: 'synced-group', id: snapshot.groupId,
    creationId: snapshot.creationId, createdAt: snapshot.createdAt, origin: snapshot.origin, bindings: snapshot.bindings, blocks: snapshot.blocks })
  for (const row of operations) {
    const value = object(M.parseExchangeStored(String(row.value.result_json))), source = ['synced_operations', String(row.value.client_operation_id), 'result_json']
    if (value.kind === 'synced-logical-deletion-proof') {
      const proof = value.version === 2 ? validateSyncedLogicalDeletionChoiceProof(value) : validateSyncedLogicalDeletionProof(value)
      add(proof.before, [...source, 'before'], [row]); if ('base' in proof) add(proof.base, [...source, 'base'], [row])
    } else if (value.kind === undefined || value.kind === 'synced-host-operation' || value.kind === 'synced-host-create-operation') {
      const ack = decodeSyncedOperationAck(row.value as unknown as SyncedGroupOperationRow)
      if ('snapshot' in ack) add(wire(ack.snapshot), [...source, 'snapshot'], [row])
      else for (const group of ack.groups) add(wire(group), [...source, 'result', 'groups', group.groupId], [row])
      // Host ACK.after lacks original document birth/parent/sort envelope, so
      // it can never be upgraded into a complete protocol record by today's ID.
    }
  }
  for (const row of settings) {
    const key = String(row.value.key), source = ['app_settings', key, 'value']
    if (key.startsWith('sync.webdav.protocol5.exchange-job.v1.')) {
      const job = M.validateExchangeJob(M.parseExchangeStored(String(row.value.value)))
      if (job.version === 4 || job.version === 7) for (const item of job.deletions) {
        add(item.before, [...source, 'deletions', item.key, 'before'], [row]); if ('base' in item) add(item.base, [...source, 'deletions', item.key, 'base'], [row])
      }
      if (job.version === 7) {
        for (const side of ['localPhysical', 'localKnowledge', 'remote'] as const) for (const item of job.decisionSource[side].records)
          add(item.record, [...source, 'decisionSource', side, 'records', item.key], [row])
        for (const item of job.decisionSource.baseRecords) add(item.record, [...source, 'decisionSource', 'baseRecords', item.key], [row])
      }
    } else if (key.startsWith('synced.recovery.history.v1.')) {
      const boundary = validateSyncedRecoveryHistoryBoundary(M.parseExchangeStored(String(row.value.value)))
      for (const group of boundary.groups) for (const history of group.rows) for (const side of ['before_json', 'after_json'] as const)
        add(M.parseExchangeStored(history[side]), [...source, 'groups', group.groupId, 'rows', history.id, side], [row])
    } else if (key.startsWith('sync.webdav.protocol5.exchange-history-row.v1.')) {
      const history = object(object(M.parseExchangeStored(String(row.value.value))).row)
      for (const side of ['before_json', 'after_json'] as const) add(M.parseExchangeStored(String(history[side])), [...source, 'row', side], [row])
    }
  }
  for (const table of ['synced_group_history', 'synced_group_retirements']) if (raw.tables.some(value => value.name === table))
    for (const row of graph3Rows(raw, table)) for (const column of table === 'synced_group_history' ? ['before_json', 'after_json'] : ['wire_json'])
      add(M.parseExchangeStored(String(row.value[column])), [table, String(row.value.id ?? row.value.group_id), column], [row])
  // A complete current original is reusable ONLY if every original field/birth
  // and whole record hash already equals historical W. We do not rewrite local
  // file URLs to portable placeholders, and do not reject native outside-wire
  // ranges merely because they cannot supply this optional historical proof.
  const numeric = (value: unknown) => typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  const blocksByOwner = (table: string, column: string, canonical: boolean) => {
    const groups = new Map<string, Array<{ row: ReturnType<typeof graph3Rows>[number]; block: Record<string, unknown> }>>()
    for (const row of graph3Rows(raw, table)) {
      const value = row.value, depth = numeric(value.depth), checked = value.checked === 0n ? false : value.checked === 1n ? true : null
      if (depth === null || checked === null) continue
      const block = { id: value.id, type: value.type, content: value.content, checked, depth, parentBlockId: value.parent_block_id,
        ...(value.tags_json === null ? {} : { tags: M.parseExchangeStored(String(value.tags_json)) }),
        ...(value.language === null ? {} : { language: value.language }), ...(value.list_start === null ? {} : { listStart: numeric(value.list_start) }),
        ...(value.markdown_format_json === null ? {} : { markdownFormat: M.parseExchangeStored(String(value.markdown_format_json)) }),
        ...(value.highlight === null ? {} : { highlight: value.highlight }), ...(canonical ? { createdAt: value.created_at } : {}) }
      const id = String(value[column]), list = groups.get(id) ?? []; list.push({ row, block }); groups.set(id, list)
    }
    for (const list of groups.values()) list.sort((a, b) => {
      const x = a.row.value.sort_order as bigint, y = b.row.value.sort_order as bigint
      return x < y ? -1 : x > y ? 1 : String(a.block.id) < String(b.block.id) ? -1 : 1 })
    return groups
  }
  const hosts = blocksByOwner('blocks', 'document_id', false), groups = blocksByOwner('synced_group_blocks', 'group_id', true)
  for (const row of graph3Rows(raw, 'documents')) {
    const value = row.value, sortOrder = numeric(value.sort_order), blocks = hosts.get(String(value.id)) ?? []
    if (sortOrder !== null) add({ kind: 'document', id: value.id, parentId: value.parent_id, sortOrder, createdAt: value.created_at,
      content: { title: value.title, summary: value.summary, blocks: blocks.map(value => value.block) } }, ['documents', String(value.id), 'complete-original-protocol-record'], [row, ...blocks.map(value => value.row)])
  }
  for (const row of graph3Rows(raw, 'synced_groups')) {
    const value = row.value, blocks = groups.get(String(value.id)) ?? []
    add({ kind: 'synced-group', id: value.id, creationId: value.creation_id, createdAt: value.created_at,
      origin: M.parseExchangeStored(String(value.origin_json)), bindings: M.parseExchangeStored(String(value.bindings_json)), blocks: blocks.map(value => value.block) },
    ['synced_groups', String(value.id), 'complete-original-protocol-record'], [row, ...blocks.map(value => value.row)])
  }
  const evidence = new Map<string, Root3SettledWorkingEvidence3>()
  for (const [key, saved] of jobs) {
    const accepted = receipts.get(key); if (!accepted) continue
    const { job, row } = saved, { receipt, row: receiptRow } = accepted, proof = receipt.provenance
    if (job.version !== receipt.version || !same(job.request, receipt.request) || proof.attemptId !== job.attemptId || proof.planHash !== job.descriptor.planHash
      || proof.afterManifestHash !== job.descriptor.next.manifestHash || proof.beforeManifestHash !== job.descriptor.expectedRemote.manifestHash
      || proof.beforeManifestEtag !== job.descriptor.expectedRemote.etag || !same(job.merges ?? [], proof.merges ?? [])
      || !same(job.resolution, proof.resolution) || row.value.key !== M.exchangeJobKey(job.request.operationId, job.attemptId)
      || receiptRow.value.client_operation_id !== job.request.operationId || receipt.result.operationId !== job.request.operationId || receipt.result.replayed
      || receipt.result.workspaceScope !== job.workspaceScope || receipt.result.recoveryEpoch !== job.recoveryEpoch || receipt.result.remoteWorkspaceId !== job.remoteWorkspaceId
      || job.version === 5 && (receipt.version !== 5 || job.knowledgeHash !== receipt.provenance.knowledgeHash)
      || receiptRow.value.request_hash !== M.exchangeRequestHash(receipt.request) || receiptRow.value.created_at !== receipt.result.acceptedAt
      || row.value.updated_at !== job.preparedAt || row.value.value !== publicationJson(job)) return fail('settled receipt/job source mismatch')
    const phases = (phasesByJob.get(key) ?? []).map(({ row, fact }) => {
        if (row.value.key !== M.exchangeJobPhaseKey(job.request.operationId, job.attemptId, fact.sequence) || row.value.updated_at !== fact.recordedAt
          || row.value.value !== publicationJson(fact) || fact.jobHash !== M.exchangeJobHash(job) || fact.requestHash !== job.requestHash) return fail('settled phase original mismatch')
        return { row, fact } }).sort((a, b) => a.fact.sequence - b.fact.sequence)
    let previous: string | null = null
    for (const [index, { fact }] of phases.entries()) { if (fact.sequence !== index || fact.previousFactHash !== previous) return fail('settled phase chain mismatch'); previous = publicationHash(publicationJson(fact)) }
    if (!phases.length || phases[0].fact.phase !== 'prepared' || phases[0].fact.recordedAt !== job.preparedAt
      || phases.at(-1)!.fact.phase !== 'settled' || phases.at(-1)!.fact.remoteEtag !== proof.afterManifestEtag) return fail('complete prepared/settled phase proof missing')
    const custom = root3CustomMergeParts3(job.request), keys = [...new Set(custom.map(value => value.recordKey))]
    if (keys.some(key => !job.merges?.some(value => value.key === key && originals.has(value.resultHash)))) continue
    const sources = [], merged = []
    for (const recordKey of keys) {
      const provenance = job.merges!.find(value => value.key === recordKey)!, retained = originals.get(provenance.resultHash)!, record = retained.record
      if (record.kind !== 'document' && record.kind !== 'synced-group') return fail('settled W is not live typed record')
      const parts = custom.filter(value => value.recordKey === recordKey).map(part => {
        const blockId = /^block:(.+):content$/.exec(part.partId)?.[1], blocks = record.kind === 'document' ? record.content.blocks : record.blocks
        const block = blockId ? blocks.find(value => value.id === blockId) : null
        const text = part.partId === 'title' && record.kind === 'document' ? record.content.title
          : part.partId === 'summary' && record.kind === 'document' ? record.content.summary
          : block && block.type !== 'database-view' && block.type !== 'synced-block' ? block.content : null
        if (text !== part.text) return fail('settled W custom text/semantic holder mismatch')
        return { id: part.partId, text: part.text }
      })
      merged.push({ recordKey, record, parts, provenance }); sources.push({ recordKey, resultHash: provenance.resultHash, source: retained.source, originalRowsHash: retained.originalRowsHash })
    }
    const binding = { kind: 'settled-original-working-record' as const, sourceContentHash,
      jobSettingKey: key, jobHash: M.exchangeJobHash(job), jobOriginalRowHash: root3SupplementOriginalRowHash3(raw, row),
      receiptOriginalRowHash: root3SupplementOriginalRowHash3(raw, receiptRow), phaseRowsHash: capsuleBytesHash('knowbook.restore.assets3.settled-phase-rows.v1\0'
        + capsuleJson(phases.map(value => root3SupplementOriginalRowHash3(raw, value.row)))), sources }
    evidence.set(key, { job, merged, binding, contextHash: capsuleBytesHash('knowbook.restore.assets3.settled-working-evidence.v1\0' + capsuleJson(binding)) })
  }
  return evidence
}
function snapshot(value: unknown): SyncedProtocol5Snapshot {
  assertSyncedShape(value, ['manifest', 'records'])
  const entries = list(value.records).map(row => { assertSyncedShape(row, ['key', 'hash', 'record'])
    if (typeof row.key !== 'string' || typeof row.hash !== 'string' || publicationHash(publicationJson(row.record)) !== row.hash)
      return fail('snapshot raw record hash mismatch')
    return { key: row.key, record: row.record } })
  return validateSyncedProtocol5Snapshot(value.manifest, entries)
}
function normalizedPlan(value: ReturnType<typeof planSyncedExchange> | ReturnType<typeof planSyncedKnowledgeConflicts>) {
  const wire = (value: SyncedProtocol5Snapshot) => ({ manifest: value.manifest, records: value.records })
  return 'localPhysicalFinal' in value ? { ...value, localFinal: wire(value.localPhysicalFinal), nextRemote: wire(value.nextRemote),
    localKnowledgeFinal: wire(value.localKnowledgeFinal), localPhysicalFinal: wire(value.localPhysicalFinal) }
    : { ...value, nextRemote: wire(value.nextRemote), localFinal: wire(value.localFinal) }
}
/** Authenticate every original byte/hash first, then run the SAME pure planner
 * and merge codec as the original service. Replaying today's SQL records is
 * forbidden: block role/skeleton/birth come exclusively from the sealed inputs. */
type OriginalRowPointer3 = Pick<ReturnType<typeof graph3Rows>[number], 'table' | 'original'>
function replayContext(raw: Capsule2RawContent, locator: Root3MergeContextLocator3, bytes: Root3MergeContextBytes3,
  originalRows: ReadonlyMap<string, readonly OriginalRowPointer3[]>) {
  if (bytes.operationId !== locator.operationId || bytes.attemptId !== locator.attemptId) return fail('context identity mismatch')
  const matches = (originalRows.get(locator.jobSettingKey) ?? []).map(row => graph3Rows({ encoding: raw.encoding,
    tables: [{ ...row.table, rows: [row.original] }] }, row.table.name)[0])
  if (matches.length !== 1 || matches[0].original.sourceRowId !== locator.sourceRowId
    || root3SupplementOriginalRowHash3(raw, matches[0]) !== locator.originalRowHash || typeof matches[0].value.value !== 'string')
    return fail('context is not this original SQL row')
  const job = M.validateExchangeJob(M.parseExchangeStored(matches[0].value.value))
  if ((job.version !== 2 && job.version !== 5) || job.version !== locator.version || M.exchangeJobHash(job) !== locator.jobHash
    || job.spoolHash !== locator.spoolHash || publicationHash(publicationJson(job.descriptor)) !== locator.descriptorHash)
    return fail('SQL job hash/descriptor mismatch')
  if (!same(M.validateExchangeJob(parse(bytes.jobBytes)), job)) return fail('spool job differs from SQL job')
  const ready = parse(bytes.readyBytes); assertSyncedShape(ready, ['jobHash', 'spoolHash'])
  if (ready.jobHash !== locator.jobHash || ready.spoolHash !== job.spoolHash) return fail('ready pair mismatch')
  if (publicationHash(publicationJson({ inputHash: publicationHash(bytes.inputBytes), descriptor: job.descriptor })) !== job.spoolHash)
    return fail('raw inputs spool hash mismatch')
  const input = parse(bytes.inputBytes)
  assertSyncedShape(input, ['kind', 'version', 'request', 'target', 'local', 'remote', 'state', 'baseRecords', 'authority', 'keyGuards', 'stateRaw', 'plan',
    'plannerVersion', 'resolution', 'conflictSelections', ...(job.version === 5 ? ['localPhysical', 'knowledgeSource', 'knowledgeHash'] : [])])
  if (input.kind !== 'synced-exchange-private-inputs' || input.version !== job.version || !same(input.request, job.request)
    || input.plannerVersion !== job.plannerVersion || !same(C.validateExchangeResolutionBinding(input.resolution), job.resolution))
    return fail('inputs request/engine/resolution mismatch')
  const target = object(input.target)
  if (M.exchangeTargetFingerprint(target as unknown as Parameters<typeof M.exchangeTargetFingerprint>[0]) !== job.request.targetFingerprint)
    return fail('original target fingerprint mismatch')
  const local = snapshot(input.local), remote = snapshot(input.remote), state = M.validateAnyExchangeState(input.state)
  if (local.manifest.workspaceId !== job.workspaceScope || remote.manifest.workspaceId !== job.remoteWorkspaceId
    || state.workspaceScope !== job.workspaceScope || state.recoveryEpoch !== job.recoveryEpoch || state.databasePath !== job.request.databasePath
    || state.targetFingerprint !== job.request.targetFingerprint) return fail('original snapshot/state identity mismatch')
  const baseRecords = list(input.baseRecords).map(row => { assertSyncedShape(row, ['key', 'hash', 'record'])
    if (typeof row.key !== 'string' || typeof row.hash !== 'string' || publicationHash(publicationJson(row.record)) !== row.hash)
      return fail('base original hash mismatch')
    return { key: row.key, hash: row.hash, record: validateSyncedProtocol5Record(row.record, row.key) } })
  if (new Set(baseRecords.map(row => row.key)).size !== baseRecords.length) return fail('duplicate base record')
  assertSyncedShape(input.authority, ['catalogId', 'identities', 'occupiedDocumentIds', 'historyComponents', 'pinnedGroupIds', 'knownGroupIds', 'missingBaseKeys',
    'deferredKeys', ...(job.version === 5 ? ['deletedFacts', 'pins', 'deletionProofReferences'] : [])], ['keyGuards'])
  const authority = object(input.authority)
  const guards = list(authority.keyGuards ?? []).map(value => object(value))
  assertSyncedShape(input.keyGuards, guards.map(value => String(value.key)))
  if (!same(input.keyGuards, Object.fromEntries(guards.map(row => [row.key, row.fingerprint])))
    || input.stateRaw !== null && typeof input.stateRaw !== 'string') return fail('original guards/state raw mismatch')
  const selections = list(input.conflictSelections).map(row => { assertSyncedShape(row, ['preview', 'decision'])
    const preview = C.validateConflictPreviewComponent(row.preview), decision = C.validateConflictDecisions([row.decision])[0]
    if (preview.componentId !== decision.componentId) return fail('component selector identity mismatch')
    return { preview, decision } })
  if (job.request.method !== 'resolveSyncedExchangeConflicts' || !same(C.validateConflictDecisions(selections.map(row => row.decision)), job.request.decisions))
    return fail('complete request selectors mismatch')
  let plan: ReturnType<typeof planSyncedExchange> | ReturnType<typeof planSyncedKnowledgeConflicts>
  if (job.version === 2) {
    const legacy = state.version === 1 ? state : M.validateExchangeState({ ...state, version: 1, baseline: state.baseline.map(row => {
      if (row.local.kind !== 'live') return fail('legacy plan cannot reinterpret absent knowledge')
      return { key: row.key, localHash: row.local.hash, remoteHash: row.remoteHash, commonHash: row.commonHash,
        dependencyKeys: row.dependencyKeys, dependencySignature: row.dependencySignature, acceptedOperationId: row.acceptedOperationId } }) })
    plan = planSyncedExchange({ operationId: locator.operationId, local, remote, baseRecords, state: legacy,
      localFingerprint: job.descriptor.localFingerprint, authority: authority as unknown as ExchangePlanInput['authority'], conflictSelections: selections })
  } else if (job.version === 5) {
    const localPhysical = snapshot(input.localPhysical)
    if (!same(validateKnowledgeSource(input.knowledgeSource), job.knowledgeSource) || input.knowledgeHash !== job.knowledgeHash)
      return fail('knowledge selection source mismatch')
    plan = planSyncedKnowledgeConflicts({ operationId: locator.operationId, localPhysical, localKnowledge: local, remote, baseRecords,
      state: M.validateTombstoneExchangeState(state), localFingerprint: job.descriptor.localFingerprint,
      authority: authority as unknown as KnowledgePlanInput['authority'], conflictSelections: selections })
    if (!('knowledgeHash' in plan) || plan.knowledgeHash !== job.knowledgeHash || !same(plan.knowledgeSource, job.knowledgeSource))
      return fail('replayed knowledge selection mismatch')
  } else return fail('unsupported original conflict job version')
  if (!same(input.plan, normalizedPlan(plan)) || plan.planHash !== job.descriptor.planHash || !same(plan.merges ?? [], job.merges ?? []))
    return fail('complete replayed planner differs from original immutable job')
  if (!bytes.manifestBytes || publicationHash(bytes.manifestBytes) !== job.descriptor.next.manifestHash
    || !same(parse(bytes.manifestBytes), plan.nextRemote.manifest)) return fail('next manifest original mismatch')
  const binary = (value: Root3MergeContextBinary3) => {
    if (value instanceof Uint8Array) return { sha256: publicationHash(value), byteLength: value.byteLength }
    assertSyncedShape(value, ['kind', 'sha256', 'byteLength'])
    if (value.kind !== 'main-stream-digest' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) return fail('invalid internal stream digest')
    return { sha256: value.sha256, byteLength: value.byteLength }
  }
  const objects = new Map<string, ReturnType<typeof binary>>(), assets = new Map<string, { hash: string; names: readonly string[]; digest: ReturnType<typeof binary> }>()
  for (const item of bytes.objects ?? []) { if (objects.has(item.hash)) return fail('repeated object original'); objects.set(item.hash, binary(item.bytes)) }
  for (const item of bytes.assets ?? []) { if (assets.has(item.hash)) return fail('repeated asset original'); assets.set(item.hash, { hash: item.hash, names: item.names, digest: binary(item.bytes) }) }
  if (objects.size !== new Set(job.descriptor.next.objects.map(item => item.hash)).size || assets.size !== job.descriptor.next.assets.length)
    return fail('original object/asset inventory is not closed')
  const nextRows = new Map(plan.nextRemote.records.map(row => [row.key, row]))
  for (const item of job.descriptor.next.objects) { const original = objects.get(item.hash)
    // Snapshot/planner validation already authenticates the exact canonical
    // record hash. Equal held-FD object digest+length proves those same bytes;
    // no second full object parse/buffer is needed or trusted as a capability.
    if (!original || original.byteLength !== item.bytes || original.sha256 !== item.hash || nextRows.get(item.key)?.hash !== item.hash)
      return fail('original object bytes/record mismatch') }
  for (const item of job.descriptor.next.assets) { const original = assets.get(item.hash)
    if (!original || original.digest.byteLength !== item.bytes || original.digest.sha256 !== item.hash || !same(original.names, item.names))
      return fail('original pending asset bytes/names mismatch') }
  const base = new Map(baseRecords.map(row => [row.key, row])), left = new Map(local.records.map(row => [row.key, row])), right = new Map(remote.records.map(row => [row.key, row]))
  const merged = []
  for (const selection of selections) if (selection.decision.choice === 'merge') for (const chosen of selection.decision.records) {
    const custom = chosen.parts.filter(part => part.value.choice === 'custom')
    if (!custom.length) continue
    const before = base.get(chosen.key), a = left.get(chosen.key), b = right.get(chosen.key)
    const provenance = job.merges?.find(row => row.key === chosen.key), preview = selection.preview.records.find(row => row.key === chosen.key)
    if (!before || !a || !b || !preview || !provenance || provenance.baseHash !== before.hash || provenance.localHash !== a.hash || provenance.remoteHash !== b.hash
      || preview.baseHash !== before.hash || preview.localHash !== a.hash || preview.remoteHash !== b.hash) return fail('actual selected B/L/R provenance missing')
    const replay = mergeSyncedProtocol5Record(before.record, a.record, b.record, Object.fromEntries(chosen.parts.map(part => [part.id, part.value])))
    if (!replay || replay.unresolved.length || publicationHash(publicationJson(replay.record)) !== provenance.resultHash
      || nextRows.get(chosen.key)?.hash !== provenance.resultHash) return fail('selected merge working record does not reproduce original result')
    for (const part of custom) {
      const semantic = replay.conflicts.find(value => value.id === part.id)
      if (!semantic || !semantic.canEditText || !['title', 'summary', 'block-content'].includes(semantic.field)) return fail('custom field is not a real editable text part')
    }
    merged.push({ componentId: selection.decision.componentId, recordKey: chosen.key, record: replay.record,
      parts: custom.map(part => ({ id: part.id, text: part.value.choice === 'custom' ? part.value.text : fail('custom discriminant'),
        semantic: replay.conflicts.find(value => value.id === part.id)! })), provenance })
  }
  const byteInventory = { inputHash: publicationHash(bytes.inputBytes), jobBytesHash: publicationHash(bytes.jobBytes), readyBytesHash: publicationHash(bytes.readyBytes),
    manifestHash: publicationHash(bytes.manifestBytes), objects: [...objects].map(([hash, value]) => ({ hash, bytes: value.byteLength })).sort((a, b) => a.hash < b.hash ? -1 : 1),
    assets: [...assets.values()].map(value => ({ hash: value.hash, names: value.names, bytes: value.digest.byteLength })).sort((a, b) => a.hash < b.hash ? -1 : 1) }
  return { locator, job, merged, byteInventory, contextHash: capsuleBytesHash('knowbook.restore.assets3.genuine-merge-context.v1\0' + capsuleJson({ locator, byteInventory })) }
}
/** Per-fresh-read raw-cell index only. Do not decode/cache every SQL job's
 * request/descriptor strings while the sequential context visitor is live. */
export function createRoot3MergeContextReplay3(raw: Capsule2RawContent) {
  const table = raw.tables.find(value => value.name === 'app_settings')
  if (!table) return fail('missing original app_settings')
  const keyColumn = table.columns.indexOf('key')
  if (keyColumn < 0) return fail('missing original setting key column')
  const rows = new Map<string, OriginalRowPointer3[]>()
  for (const original of table.rows) {
    const cell = original.cells[keyColumn]
    if (cell[0] !== 'text') continue
    const key = graph3Text(cell, raw.encoding), list = rows.get(key) ?? []
    list.push({ original, table }); rows.set(key, list)
  }
  return (locator: Root3MergeContextLocator3, bytes: Root3MergeContextBytes3) => replayContext(raw, locator, bytes, rows)
}
export function replayRoot3MergeContext3(raw: Capsule2RawContent, locator: Root3MergeContextLocator3, bytes: Root3MergeContextBytes3) {
  return createRoot3MergeContextReplay3(raw)(locator, bytes)
}
