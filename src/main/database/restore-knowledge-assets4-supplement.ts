// Separate supplemental observation domain. Never change the original v3
// asset observer, its source hash, coordinates, scope list or unresolved flags.
import { serializeMarkdownWithBlockRanges } from '../../shared/markdown'
import { collectStoredMarkdownAssetDestinations, parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { capsule2AssetReferenceProvenanceHash } from './restore-knowledge-capsule2-asset-provenance'
import type { readCapsule2BaseProjection4 } from './restore-knowledge-capsule2-base-projection4'
type BaseRead4 = Awaited<ReturnType<typeof readCapsule2BaseProjection4>>
import type { RawCapsule2AssetReferences } from './restore-knowledge-capsule2-assets-read'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { parseExchangeStored, validateExchangeJob, validateExchangeReceipt, exchangeJobKey, exchangeJobHash } from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { requiredRoot3MergeContextLocators3, replayRoot3MergeContext3, createRoot3MergeContextReplay3, deriveRoot3SettledWorkingEvidence3, root3CustomMergeParts3,
  root3SupplementOriginalRowHash3, root3SupplementSourceContentHash3, type Root3MergeContextBytes3, type Root3SettledWorkingEvidence3 } from './restore-knowledge-assets3-context'

export interface Root3SupplementalAssetScope4 {
  readonly source: readonly string[]; readonly contentHash: string; readonly bodyProjectionHash: string
  readonly destinations: readonly { readonly section: 'summary' | 'body'; readonly uri: string; readonly raw: string
    readonly from: number; readonly to: number; readonly kind: string; readonly syntax: string }[]
}
export interface Root3UnsupportedAssetHolder4 {
  readonly source: readonly string[]; readonly originalRowHash: string; readonly rawValueHash: string
  readonly operationId: string; readonly attemptId: string | null; readonly reason: string
}
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const fail = (reason: string): never => { throw new Error('Root3 supplemental assets invalid: ' + reason) }
const same = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b)
const opaque = new Set(['code', 'code-block', 'math', 'frontmatter', 'database-view', 'synced-block'])
type Replay = ReturnType<typeof replayRoot3MergeContext3>
type OriginalRow = ReturnType<typeof graph3Rows>[number]
interface OriginalHolder { readonly rank: number; readonly table: OriginalRow['table']; readonly original: OriginalRow['original']; readonly kind: 'job' | 'receipt'; readonly key: string | null }
export interface SettledPortableBinding4 {
  readonly scopeSource: readonly string[]; readonly section: 'summary' | 'body'; readonly from: number; readonly to: number
  readonly recordKey: string; readonly resultHash: string; readonly contextHash: string; readonly baseManifestHash: string
  readonly settledEvidenceHash: string; readonly sourceUri: string; readonly portableUri: string
  readonly hash: string; readonly bytes: number; readonly logicalName: string; readonly physicalName: string
  readonly baseReferenceIndex: number; readonly aliasIndex: number; readonly logicalRootUri: string | null
  readonly projectionHash: string; readonly originalScopeSource: readonly string[]; readonly originalScopeContentHash: string
}
type PortableMapping4 = Omit<SettledPortableBinding4, 'scopeSource' | 'section' | 'from' | 'to' | 'recordKey' | 'resultHash'
  | 'contextHash' | 'baseManifestHash' | 'settledEvidenceHash'>
function recordWasProjected4(evidence: Root3SettledWorkingEvidence3, recordKey: string): boolean {
  const binding = evidence.binding as { sources?: unknown[] }
  return Array.isArray(binding.sources) && binding.sources.some(value => value && typeof value === 'object'
    && 'recordKey' in value && value.recordKey === recordKey && 'portableProjection' in value && value.portableProjection !== undefined)
}
function projectedMappings(base: Pick<BaseRead4,'commitment'|'baseAssets'|'baseProof'|'referenceUris'|'tree'>, evidence: Root3SettledWorkingEvidence3, recordKey: string): PortableMapping4[] {
  const binding = evidence.binding as { kind?: unknown; sourceContentHash?: unknown; sources?: unknown[] }
  if (binding.kind !== 'settled-original-working-record-portable-projection') return []
  if (binding.sourceContentHash !== base.commitment.sourceContentHash || !Array.isArray(binding.sources)) return fail('portable W evidence来源不符')
  const source = binding.sources.find(value => value && typeof value === 'object' && 'recordKey' in value && value.recordKey === recordKey) as { resultHash?: unknown; portableProjection?: unknown } | undefined
  if (!source?.portableProjection) return []
  const projection = source.portableProjection as { kind?: unknown; version?: unknown; portableRecordHash?: unknown; capturedProofHash?: unknown
    scopeSource?: unknown; scopeContentHash?: unknown; mappings?: unknown[] }
  if (projection.kind !== 'genuine-base-proof-portable-record' || projection.version !== 1 || projection.portableRecordHash !== source.resultHash
    || projection.capturedProofHash !== capsule2AssetReferenceProvenanceHash(base.baseProof) || !Array.isArray(projection.scopeSource)
    || projection.scopeSource.some(value => typeof value !== 'string') || typeof projection.scopeContentHash !== 'string' || !Array.isArray(projection.mappings)) return fail('portable W projection证明不完整')
  const originalScopeSource = projection.scopeSource as string[], originalScope = base.baseAssets.scopes.find(scope => capsuleJson(scope.source) === capsuleJson(originalScopeSource))
  if (!originalScope || originalScope.contentHash !== projection.scopeContentHash) return fail('portable projection不是精确原typed scope')
  return projection.mappings.map(value => {
    const row = capsuleRecord(value, value && typeof value === 'object' && 'logicalRootUri' in value
      ? ['sourceUri','hash','bytes','physicalName','logicalName','portableUri','referenceIndex','logicalRootUri']
      : ['sourceUri','hash','bytes','physicalName','logicalName','portableUri','referenceIndex'])
    if (typeof row.sourceUri !== 'string' || typeof row.portableUri !== 'string' || !originalScope.destinations.some(item => item.uri === row.sourceUri)
      || typeof row.referenceIndex !== 'number' || !Number.isSafeInteger(row.referenceIndex) || row.referenceIndex < 0
      || base.referenceUris[row.referenceIndex] !== row.sourceUri) return fail('portable mapping不是该精确原URI')
    const entry = base.baseProof.entries[row.referenceIndex]
    if (!entry || entry[0] !== row.referenceIndex || entry[1] === 'unresolved') return fail('portable mapping缺真实base file authority')
    const aliasIndex = entry[2], alias = base.tree.aliases[aliasIndex], portable = parseSyncedPortableAssetUri(row.portableUri)
    if (!alias || alias.hash !== row.hash || alias.bytes !== row.bytes || alias.name !== row.physicalName
      || portable.hash !== alias.hash || portable.name !== row.logicalName) return fail('portable mapping与实际FD/tree/hash/逻辑名不闭合')
    const logicalRootUri = entry[1] === 'file' ? base.baseProof.rootSpellings[entry[3]]?.uri : null
    if (entry[1] === 'file' && (!logicalRootUri || row.logicalRootUri !== logicalRootUri)
      || entry[1] === 'portable' && (row.logicalRootUri !== undefined || row.sourceUri !== row.portableUri || portable.name !== alias.name)) return fail('portable mapping与原root spelling或原portable alias不符')
    return { sourceUri: row.sourceUri, portableUri: row.portableUri, hash: alias.hash, bytes: alias.bytes, logicalName: portable.name,
      physicalName: alias.name, baseReferenceIndex: row.referenceIndex, aliasIndex, logicalRootUri,
      projectionHash: hash('knowbook.capsule4.settled-portable-record-projection.v1', source.portableProjection),
      originalScopeSource, originalScopeContentHash: originalScope.contentHash }
  })
}

interface HolderOutput {
  readonly scopes: Root3SupplementalAssetScope4[]; readonly unsupportedHolders: Root3UnsupportedAssetHolder4[]
  readonly holders: Array<{ source: readonly string[]; originalRowHash: string; rawValueHash: string; requestHash: string;
    jobHash: string; contextHash: string; evidenceKind: 'replayed-original-inputs' | 'settled-original-working-record' | 'settled-base-proof-portable-working-record';
    recordKey: string; resultHash: string; scopeSource: readonly string[]; customPartIds: readonly string[] }>
  readonly settledPortableBindings: SettledPortableBinding4[]
  readonly pendingPortableBindings: Array<{ scopeSource: readonly string[]; sourceUri: string; operationId: string; attemptId: string;
    contextHash: string; descriptorHash: string; hash: string; name: string; bytes: number }>
}
const emptyHolderOutput = (): HolderOutput => ({ scopes: [], holders: [], pendingPortableBindings: [], settledPortableBindings: [], unsupportedHolders: [] })
/** Pure fold over already verified per-context replays. Only genuine Main
 * owners call this from their sequential, fully checked visitor; no DTO or
 * this return value grants IO, scope authority, installation or acceptance.
 * accept retains only final scopes and compact commitments, never the replay,
 * its whole W, job, input headers, binary buffers or planner output. */
export function createRootRestoreSupplementalAssetObserver4(base: BaseRead4) {
  const sourceContent = base.sourceContent, baseAssets = base.baseAssets
  const sourceContentHash = root3SupplementSourceContentHash3(sourceContent)
  if (baseAssets && baseAssets.sourceContentHash !== sourceContentHash) return fail('base observer is not the same complete raw SQL source')
  const baseAssetReferencesObservationHash = baseAssets?.observationHash ?? null
  const originals: OriginalHolder[] = [], byKey = new Map<string, OriginalHolder[]>()
  const remember = (row: OriginalRow, kind: OriginalHolder['kind'], key: string | null) => {
    // Keep raw source cells by reference, not all decoded SQL/job/request JSON.
    const holder = { rank: originals.length, table: row.table, original: row.original, kind, key }
    originals.push(holder)
    if (key !== null) { const list = byKey.get(key) ?? []; list.push(holder); byKey.set(key, list) }
  }
  for (const row of graph3Rows(sourceContent, 'app_settings')) {
    if (typeof row.value.key !== 'string' || !row.value.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')) continue
    if (typeof row.value.value !== 'string') return fail('actual SQL job value is not text')
    const job = validateExchangeJob(parseExchangeStored(row.value.value))
    if (root3CustomMergeParts3(job.request).length) remember(row, 'job', exchangeJobKey(job.request.operationId, job.attemptId))
  }
  for (const row of graph3Rows(sourceContent, 'synced_operations')) {
    if (typeof row.value.result_json !== 'string' || typeof row.value.client_operation_id !== 'string') return fail('actual SQL operation result is not text')
    const envelope = parseExchangeStored(row.value.result_json)
    if (!envelope || typeof envelope !== 'object' || !('kind' in envelope) || envelope.kind !== 'synced-exchange-operation') continue
    const receipt = validateExchangeReceipt(envelope)
    if (root3CustomMergeParts3(receipt.request).length) remember(row, 'receipt', receipt.provenance.attemptId ? exchangeJobKey(receipt.request.operationId, receipt.provenance.attemptId) : null)
  }
  const outputs: Array<HolderOutput | undefined> = new Array(originals.length), seen = new Set<string>()
  const originalJobs = new Map(graph3Rows(sourceContent, 'app_settings').flatMap(row => typeof row.value.key === 'string'
    && typeof row.value.value === 'string' && row.value.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')
    ? [[row.value.key, validateExchangeJob(parseExchangeStored(row.value.value))] as const] : []))
  const settled = new Map<string, Root3SettledWorkingEvidence3>(base.settledEvidence.jobs.map(value => {
    const job = originalJobs.get(value.jobSettingKey)
    if (!job || exchangeJobHash(job) !== value.jobHash) return fail('settled projection不是该同次genuine SQL job')
    return [value.jobSettingKey, { job, merged: value.merged, contextHash: value.contextHash, binding: value.binding }] as const
  }))
  const wanted = new Map(requiredRoot3MergeContextLocators3(sourceContent, { includeSettled: true })
    .filter(value => !settled.has(value.jobSettingKey)).map(value => [value.jobSettingKey, value]))
  const contextBindings: Array<{ locator: Replay['locator']; contextHash: string; byteInventory: Replay['byteInventory'] }> = []
  const settledBindings = [...settled].map(([jobSettingKey, value]) => ({ jobSettingKey, contextHash: value.contextHash, binding: value.binding }))
    .sort((a, b) => a.jobSettingKey < b.jobSettingKey ? -1 : 1)
  let state: 'open' | 'finished' | 'failed' = 'open'
  function observe(holder: OriginalHolder, replay: Replay | Root3SettledWorkingEvidence3 | undefined,
    replayed: boolean, assetIndex?: ReadonlyMap<string, Replay['job']['descriptor']['next']['assets'][number]>): HolderOutput {
    const { scopes, holders, pendingPortableBindings, settledPortableBindings, unsupportedHolders } = emptyHolderOutput(), scopeKeys = new Set<string>()
    const visit = (row: ReturnType<typeof graph3Rows>[number], source: readonly string[], value: string,
      request: Parameters<typeof root3CustomMergeParts3>[0], attemptId: string | null, receipt?: ReturnType<typeof validateExchangeReceipt>) => {
      const custom = root3CustomMergeParts3(request); if (!custom.length) return
      const originalRowHash = root3SupplementOriginalRowHash3(sourceContent, row), rawValueHash = hash('knowbook.restore.assets3.typed-holder-raw-value.v1', value)
      const bad = (reason: string) => { unsupportedHolders.push({ source, originalRowHash, rawValueHash, operationId: request.operationId, attemptId, reason }) }
      if (!attemptId) { bad('actual-custom-merge-holder-has-no-original-attempt'); return }
      const key = exchangeJobKey(request.operationId, attemptId)
      if (!replay) { bad(wanted.has(key) ? 'genuine-original-merge-context-unavailable' : 'actual-custom-merge-holder-has-no-original-SQL-job'); return }
      const settledWorking = 'binding' in replay ? replay : null
      if (replayed !== (settledWorking === null)) return fail('replayed and settled evidence kinds differ')
      if (!same(replay.job.request, request)) return fail('receipt/request does not match exact original job request')
      if (receipt && (receipt.provenance.planHash !== replay.job.descriptor.planHash || !same(receipt.provenance.merges ?? [], replay.job.merges ?? [])))
        return fail('receipt selected working record provenance differs from original job')
      const selected = new Map(replay.merged.map(item => [item.recordKey, item]))
      const customByRecord = new Map<string, typeof custom>()
      for (const part of custom) { const list = customByRecord.get(part.recordKey) ?? []; list.push(part); customByRecord.set(part.recordKey, list) }
      for (const [recordKey, parts] of customByRecord) {
        const selectedRecord = selected.get(recordKey)
        if (!selectedRecord || !same(parts.map(part => ({ id: part.partId, text: part.text })).sort((a, b) => a.id < b.id ? -1 : 1),
          selectedRecord.parts.map(part => ({ id: part.id, text: part.text })).sort((a, b) => a.id < b.id ? -1 : 1)))
          return fail('full custom parts do not match actual replayed record')
        const record = selectedRecord.record
        if (record.kind !== 'document' && record.kind !== 'synced-group') return fail('custom merge did not produce a live typed record')
        // Existing consumers restore/use full merged records, not naked request
        // fragments. planSyncedExchange/KnowledgeConflicts -> nextRemote/localFinal
        // -> materialize/apply. Keep full W body+summary with actual definition/
        // footnote context, even when summary was chosen local/remote. Title is
        // never scanned; only body/summary of this actually custom-selected W.
        const body = record.kind === 'document' ? record.content : { summary: '', blocks: record.blocks }
        const blocks = body.blocks.map(block => opaque.has(block.type) ? { ...block, type: 'paragraph', content: '' } : block)
        const markdown = serializeMarkdownWithBlockRanges(blocks as SyncedStableBlockDraft[]).markdown
        const scopeSource = ['root3-assets-supplement-v2', ...source, 'request', 'decisions', parts[0].componentId, 'records', recordKey, 'working-record']
        const scopeKey = capsuleJson(scopeSource); if (scopeKeys.has(scopeKey)) return fail('repeated supplemental scope source'); scopeKeys.add(scopeKey)
        const binding = { source, originalRowHash, rawValueHash, requestHash: replay.job.requestHash, jobHash: exchangeJobHash(replay.job),
          contextHash: replay.contextHash, evidenceKind: replayed ? 'replayed-original-inputs' as const : settledWorking && recordWasProjected4(settledWorking, recordKey) ? 'settled-base-proof-portable-working-record' as const : 'settled-original-working-record' as const,
          descriptorHash: publicationHash(publicationJson(replay.job.descriptor)), recordKey, merge: selectedRecord.provenance,
          customPartIds: parts.map(part => part.partId).sort() }
        const projected = settledWorking ? projectedMappings(base, settledWorking, recordKey) : []
        const destinations: Root3SupplementalAssetScope4['destinations'][number][] = []
        for (const [section, text] of [['summary', body.summary], ['body', markdown]] as const)
          for (const item of collectStoredMarkdownAssetDestinations(text)) {
            const destination = { section, uri: item.url, raw: text.slice(item.start, item.end), from: item.start, to: item.end,
              kind: item.kind, syntax: item.syntax ?? 'markdown' }; destinations.push(destination)
            if (!item.url.startsWith('knowbook-asset://')) continue
            const portable = parseSyncedPortableAssetUri(item.url), asset = assetIndex?.get(capsuleJson([portable.hash, portable.name]))
            for (const mapping of projected) if (mapping.portableUri === item.url) settledPortableBindings.push({
              scopeSource, section, from: item.start, to: item.end, recordKey, resultHash: selectedRecord.provenance.resultHash,
              contextHash: replay.contextHash, baseManifestHash: base.commitment.baseManifestHash,
              settledEvidenceHash: base.settledEvidence.evidenceHash, ...mapping })
            // Only descriptor-bound pending portable originals can receive the
            // separate spool-portable proof. A file URI or another domain's hash
            // never acquires this binding. Managed alias fallback is authority's
            // distinct genuine ownership rule, not a scope-selection permission.
            if (asset) pendingPortableBindings.push({ scopeSource, sourceUri: item.url, operationId: request.operationId, attemptId,
              contextHash: replay.contextHash, descriptorHash: binding.descriptorHash, hash: asset.hash, name: portable.name, bytes: asset.bytes })
          }
        scopes.push({ source: scopeSource, contentHash: hash('knowbook.restore.assets3.supplemental-scope-content.v2', { binding, body }),
          bodyProjectionHash: hash('knowbook.restore.assets3.supplemental-body-projection.v2', { binding, markdown }), destinations })
        holders.push({ source, originalRowHash, rawValueHash, requestHash: replay.job.requestHash, jobHash: exchangeJobHash(replay.job),
          contextHash: replay.contextHash, evidenceKind: binding.evidenceKind, recordKey, resultHash: selectedRecord.provenance.resultHash, scopeSource, customPartIds: binding.customPartIds })
      }
    }
    // Hydrate only this original holder; no decoded job/receipt is cached.
    const row = graph3Rows({ encoding: sourceContent.encoding, tables: [{ ...holder.table, rows: [holder.original] }] }, holder.table.name)[0]
    if (holder.kind === 'job') {
      if (typeof row.value.key !== 'string' || typeof row.value.value !== 'string') return fail('original job holder changed')
      const job = validateExchangeJob(parseExchangeStored(row.value.value))
      visit(row, ['app_settings', row.value.key, 'value'], row.value.value, job.request, job.attemptId)
    } else {
      if (typeof row.value.result_json !== 'string' || typeof row.value.client_operation_id !== 'string') return fail('original receipt holder changed')
      const receipt = validateExchangeReceipt(parseExchangeStored(row.value.result_json))
      visit(row, ['synced_operations', row.value.client_operation_id, 'result_json'], row.value.result_json,
        receipt.request, receipt.provenance.attemptId ?? null, receipt)
    }
    return { scopes, holders, pendingPortableBindings, settledPortableBindings, unsupportedHolders }
  }
  // Settled evidence is a distinct original-SQL proof, not a fabricated replay.
  // Consume it now and release complete W/job objects before returning the fold.
  for (const [key, evidence] of settled) for (const holder of byKey.get(key) ?? []) outputs[holder.rank] = observe(holder, evidence, false)
  settled.clear()
  const accept = (replay: Replay): void => {
    if (state !== 'open') return fail('observer is not open')
    try {
      const key = exchangeJobKey(replay.job.request.operationId, replay.job.attemptId), locator = wanted.get(key)
      if (!locator || seen.has(key) || !same(locator, replay.locator) || exchangeJobHash(replay.job) !== locator.jobHash
        || replay.job.spoolHash !== locator.spoolHash || publicationHash(publicationJson(replay.job.descriptor)) !== locator.descriptorHash
        || replay.contextHash !== hash('knowbook.restore.assets3.genuine-merge-context.v1', { locator: replay.locator, byteInventory: replay.byteInventory }))
        return fail('unrequested, repeated or wrong-original context replay')
      const originalJob = (byKey.get(key) ?? []).find(holder => holder.kind === 'job')
      if (!originalJob) return fail('context replay has no exact original SQL job')
      const row = graph3Rows({ encoding: sourceContent.encoding, tables: [{ ...originalJob.table, rows: [originalJob.original] }] }, originalJob.table.name)[0]
      if (row.original.sourceRowId !== locator.sourceRowId || root3SupplementOriginalRowHash3(sourceContent, row) !== locator.originalRowHash
        || typeof row.value.value !== 'string' || !same(validateExchangeJob(parseExchangeStored(row.value.value)), replay.job)) return fail('context replay differs from fixed raw SQL job')
      const customKeys = new Set(root3CustomMergeParts3(replay.job.request).map(part => part.recordKey))
      if (replay.merged.length !== customKeys.size || new Set(replay.merged.map(item => item.recordKey)).size !== customKeys.size) return fail('context replay selected record set is not closed')
      for (const item of replay.merged) if (!customKeys.has(item.recordKey)
        || publicationHash(publicationJson(item.record)) !== item.provenance.resultHash
        || !same(replay.job.merges?.find(value => value.key === item.recordKey), item.provenance)) return fail('context replay selected W differs from original result hash')
      const assetIndex = new Map(replay.job.descriptor.next.assets.flatMap(asset => asset.names.map(name => [capsuleJson([asset.hash, name]), asset] as const)))
      // Build atomically per context. Only compact output values escape this call.
      const prepared = (byKey.get(key) ?? []).map(holder => ({ rank: holder.rank, output: observe(holder, replay, true, assetIndex) }))
      for (const item of prepared) outputs[item.rank] = item.output
      contextBindings.push({ locator: replay.locator, contextHash: replay.contextHash, byteInventory: replay.byteInventory }); seen.add(key)
    } catch (error) { state = 'failed'; throw error }
  }
  const finish = () => {
    if (state !== 'open') return fail('observer is not open')
    state = 'failed'
    if (root3SupplementSourceContentHash3(sourceContent) !== sourceContentHash) return fail('raw SQL source changed during context observation')
    const result = emptyHolderOutput()
    // Preserve original jobs-then-receipts SQL row order independently of the
    // visitor/context arrival order, including pending bindings and diagnostics.
    for (const holder of originals) {
      const observed = outputs[holder.rank] ?? observe(holder, undefined, false)
      // Do not impose the engine's function-argument limit on legal large
      // destination/holder collections by spreading them into push().
      for (const value of observed.scopes) result.scopes.push(value)
      for (const value of observed.holders) result.holders.push(value)
      for (const value of observed.pendingPortableBindings) result.pendingPortableBindings.push(value)
      for (const value of observed.settledPortableBindings) result.settledPortableBindings.push(value)
      for (const value of observed.unsupportedHolders) result.unsupportedHolders.push(value)
    }
    const { scopes, holders, pendingPortableBindings, settledPortableBindings, unsupportedHolders } = result
    scopes.sort((a, b) => capsuleJson(a.source) < capsuleJson(b.source) ? -1 : 1)
    if (new Set(scopes.map(scope => capsuleJson(scope.source))).size !== scopes.length) return fail('repeated supplemental scope source')
    contextBindings.sort((a, b) => a.locator.jobSettingKey < b.locator.jobSettingKey ? -1 : 1)
    const body = { kind: 'root-restore-assets3-supplemental-scopes' as const, version: 2 as const, observerVersion: 2 as const,
      sourceContentHash, baseAssetReferencesObservationHash,
      destinationCoordinates: 'replayed-original-selected-working-record-summary-or-masked-body-utf16' as const,
      scopes, holders, contextBindings, settledBindings, pendingPortableBindings, settledPortableBindings, unsupportedHolders,
      baseManifestHash: base.commitment.baseManifestHash, settledEvidenceHash: base.settledEvidence.evidenceHash }
    const observation = freezeCapsuleValue({ ...body, observationHash: hash('knowbook.restore.assets3.supplemental-observation.v2', body) })
    outputs.length = 0; originals.length = 0; byKey.clear(); wanted.clear(); seen.clear(); state = 'finished'
    return observation
  }
  return { accept, finish }
}

export type Root3SupplementalAssetObservation4 = ReturnType<ReturnType<typeof createRootRestoreSupplementalAssetObserver4>['finish']>

/** Pure same-source mapping validator only; no owner or IO rights. */
export const root4SettledPortableMappingsForMain5 = projectedMappings
