// Separate supplemental observation domain. Never change the original v3
// asset observer, its source hash, coordinates, scope list or unresolved flags.
import { serializeMarkdownWithBlockRanges } from '../../shared/markdown'
import { collectStoredMarkdownAssetDestinations, parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import type { Capsule2RawContent } from './restore-knowledge-capsule2-raw-model'
import type { RawCapsule2AssetReferences } from './restore-knowledge-capsule2-assets-read'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { parseExchangeStored, validateExchangeJob, validateExchangeReceipt, exchangeJobKey, exchangeJobHash } from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { requiredRoot3MergeContextLocators3, replayRoot3MergeContext3, createRoot3MergeContextReplay3, deriveRoot3SettledWorkingEvidence3, root3CustomMergeParts3,
  root3SupplementOriginalRowHash3, root3SupplementSourceContentHash3, type Root3MergeContextBytes3, type Root3SettledWorkingEvidence3 } from './restore-knowledge-assets3-context'

export interface Root3SupplementalAssetScope3 {
  readonly source: readonly string[]; readonly contentHash: string; readonly bodyProjectionHash: string
  readonly destinations: readonly { readonly section: 'summary' | 'body'; readonly uri: string; readonly raw: string
    readonly from: number; readonly to: number; readonly kind: string; readonly syntax: string }[]
}
export interface Root3UnsupportedAssetHolder3 {
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
interface HolderOutput {
  readonly scopes: Root3SupplementalAssetScope3[]; readonly unsupportedHolders: Root3UnsupportedAssetHolder3[]
  readonly holders: Array<{ source: readonly string[]; originalRowHash: string; rawValueHash: string; requestHash: string;
    jobHash: string; contextHash: string; evidenceKind: 'replayed-original-inputs' | 'settled-original-working-record';
    recordKey: string; resultHash: string; scopeSource: readonly string[]; customPartIds: readonly string[] }>
  readonly pendingPortableBindings: Array<{ scopeSource: readonly string[]; sourceUri: string; operationId: string; attemptId: string;
    contextHash: string; descriptorHash: string; hash: string; name: string; bytes: number }>
}
const emptyHolderOutput = (): HolderOutput => ({ scopes: [], holders: [], pendingPortableBindings: [], unsupportedHolders: [] })
/** Pure fold over already verified per-context replays. Only genuine Main
 * owners call this from their sequential, fully checked visitor; no DTO or
 * this return value grants IO, scope authority, installation or acceptance.
 * accept retains only final scopes and compact commitments, never the replay,
 * its whole W, job, input headers, binary buffers or planner output. */
export function createRootRestoreSupplementalAssetObserver3(sourceContent: Capsule2RawContent,
  baseAssets?: RawCapsule2AssetReferences) {
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
  const settled = deriveRoot3SettledWorkingEvidence3(sourceContent)
  const wanted = new Map(requiredRoot3MergeContextLocators3(sourceContent, { includeSettled: true })
    .filter(value => !settled.has(value.jobSettingKey)).map(value => [value.jobSettingKey, value]))
  const contextBindings: Array<{ locator: Replay['locator']; contextHash: string; byteInventory: Replay['byteInventory'] }> = []
  const settledBindings = [...settled].map(([jobSettingKey, value]) => ({ jobSettingKey, contextHash: value.contextHash, binding: value.binding }))
    .sort((a, b) => a.jobSettingKey < b.jobSettingKey ? -1 : 1)
  let state: 'open' | 'finished' | 'failed' = 'open'
  function observe(holder: OriginalHolder, replay: Replay | Root3SettledWorkingEvidence3 | undefined,
    replayed: boolean, assetIndex?: ReadonlyMap<string, Replay['job']['descriptor']['next']['assets'][number]>): HolderOutput {
    const { scopes, holders, pendingPortableBindings, unsupportedHolders } = emptyHolderOutput(), scopeKeys = new Set<string>()
    const visit = (row: ReturnType<typeof graph3Rows>[number], source: readonly string[], value: string,
      request: Parameters<typeof root3CustomMergeParts3>[0], attemptId: string | null, receipt?: ReturnType<typeof validateExchangeReceipt>) => {
      const custom = root3CustomMergeParts3(request); if (!custom.length) return
      const originalRowHash = root3SupplementOriginalRowHash3(sourceContent, row), rawValueHash = hash('knowbook.restore.assets3.typed-holder-raw-value.v1', value)
      const bad = (reason: string) => { unsupportedHolders.push({ source, originalRowHash, rawValueHash, operationId: request.operationId, attemptId, reason }) }
      if (!attemptId) { bad('actual-custom-merge-holder-has-no-original-attempt'); return }
      const key = exchangeJobKey(request.operationId, attemptId)
      if (!replay) { bad(wanted.has(key) ? 'genuine-original-merge-context-unavailable' : 'actual-custom-merge-holder-has-no-original-SQL-job'); return }
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
        const scopeSource = ['root3-assets-supplement-v1', ...source, 'request', 'decisions', parts[0].componentId, 'records', recordKey, 'working-record']
        const scopeKey = capsuleJson(scopeSource); if (scopeKeys.has(scopeKey)) return fail('repeated supplemental scope source'); scopeKeys.add(scopeKey)
        const binding = { source, originalRowHash, rawValueHash, requestHash: replay.job.requestHash, jobHash: exchangeJobHash(replay.job),
          contextHash: replay.contextHash, evidenceKind: replayed ? 'replayed-original-inputs' as const : 'settled-original-working-record' as const,
          descriptorHash: publicationHash(publicationJson(replay.job.descriptor)), recordKey, merge: selectedRecord.provenance,
          customPartIds: parts.map(part => part.partId).sort() }
        const destinations: Root3SupplementalAssetScope3['destinations'][number][] = []
        for (const [section, text] of [['summary', body.summary], ['body', markdown]] as const)
          for (const item of collectStoredMarkdownAssetDestinations(text)) {
            const destination = { section, uri: item.url, raw: text.slice(item.start, item.end), from: item.start, to: item.end,
              kind: item.kind, syntax: item.syntax ?? 'markdown' }; destinations.push(destination)
            if (!item.url.startsWith('knowbook-asset://')) continue
            const portable = parseSyncedPortableAssetUri(item.url), asset = assetIndex?.get(capsuleJson([portable.hash, portable.name]))
            // Only descriptor-bound pending portable originals can receive the
            // separate spool-portable proof. A file URI or another domain's hash
            // never acquires this binding. Managed alias fallback is authority's
            // distinct genuine ownership rule, not a scope-selection permission.
            if (asset) pendingPortableBindings.push({ scopeSource, sourceUri: item.url, operationId: request.operationId, attemptId,
              contextHash: replay.contextHash, descriptorHash: binding.descriptorHash, hash: asset.hash, name: portable.name, bytes: asset.bytes })
          }
        scopes.push({ source: scopeSource, contentHash: hash('knowbook.restore.assets3.supplemental-scope-content.v1', { binding, body }),
          bodyProjectionHash: hash('knowbook.restore.assets3.supplemental-body-projection.v1', { binding, markdown }), destinations })
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
    return { scopes, holders, pendingPortableBindings, unsupportedHolders }
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
      for (const value of observed.unsupportedHolders) result.unsupportedHolders.push(value)
    }
    const { scopes, holders, pendingPortableBindings, unsupportedHolders } = result
    scopes.sort((a, b) => capsuleJson(a.source) < capsuleJson(b.source) ? -1 : 1)
    if (new Set(scopes.map(scope => capsuleJson(scope.source))).size !== scopes.length) return fail('repeated supplemental scope source')
    contextBindings.sort((a, b) => a.locator.jobSettingKey < b.locator.jobSettingKey ? -1 : 1)
    const body = { kind: 'root-restore-assets3-supplemental-scopes' as const, version: 1 as const, observerVersion: 1 as const,
      sourceContentHash, baseAssetReferencesObservationHash,
      destinationCoordinates: 'replayed-original-selected-working-record-summary-or-masked-body-utf16' as const,
      scopes, holders, contextBindings, settledBindings, pendingPortableBindings, unsupportedHolders }
    const observation = freezeCapsuleValue({ ...body, observationHash: hash('knowbook.restore.assets3.supplemental-observation.v1', body) })
    outputs.length = 0; originals.length = 0; byKey.clear(); wanted.clear(); seen.clear(); state = 'finished'
    return observation
  }
  return { accept, finish }
}
/** Compatibility wrapper for pure byte callers. Genuine Main producers use
 * the sequential visitor plus accept(replay), then finish only after both
 * original-file/SQL inventory tails have verified successfully. */
export function deriveRootRestoreSupplementalAssetScopes3(sourceContent: Capsule2RawContent,
  baseAssets?: RawCapsule2AssetReferences, contexts: readonly Root3MergeContextBytes3[] = []) {
  const observer = createRootRestoreSupplementalAssetObserver3(sourceContent, baseAssets)
  const replayContext = createRoot3MergeContextReplay3(sourceContent)
  const wanted = new Map(requiredRoot3MergeContextLocators3(sourceContent).map(locator => [locator.jobSettingKey, locator]))
  for (const context of contexts) {
    const locator = wanted.get(exchangeJobKey(context.operationId, context.attemptId))
    if (!locator) return fail('unrequested or repeated context original')
    observer.accept(replayContext(locator, context))
  }
  return observer.finish()
}
export type Root3SupplementalAssetObservation3 = ReturnType<typeof deriveRootRestoreSupplementalAssetScopes3>
