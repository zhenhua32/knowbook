import type Database from 'better-sqlite3'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import type { DocumentBlockDraft } from '../../shared/contracts'
import { serializeMarkdownWithBlockRanges } from '../../shared/markdown'
import { collectStoredMarkdownAssetDestinations } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { readRawCapsule2PhysicalGraphOwned } from './restore-knowledge-capsule2-physical-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from './restore-knowledge-capsule2-workspace-history-read'
import { decodeHostJournal, hostJournalKind, validateHostSides } from './synced-host-journal'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { decodeSyncedOperationAck } from './synced-host-operation-receipt'
import type { SyncedGroupOperationRow } from './synced-group-operation-receipt'
import { validateExchangeJob } from '../sync/synced-exchange-model'
import type { SyncedProtocol5Record } from '../sync/synced-protocol5-model'
import { validateSyncedLogicalDeletionProof } from '../sync/synced-logical-deletion-model'
import { validateSyncedLogicalDeletionChoiceProof } from '../sync/synced-logical-deletion-choice-model'
import { RECOVERY_BOUNDARY_PREFIX, validateSyncedRecoveryHistoryBoundary } from './synced-recovery-boundary-model'

type Body = { summary: string; blocks: Array<DocumentBlockDraft | SyncedStableBlockDraft> }
type Destination = { section: 'summary' | 'body'; uri: string; raw: string; from: number; to: number; kind: string; syntax: string }
type AssistantPart = { eventId: string; seq: number; turnId: string; text: string }
type AssistantSource = { kind: 'message' | 'retained-stream'; sessionId: string; stepId: string;
  parts: Array<{ eventId: string; seq: number; turnId: string; from: number; to: number }> }
type Scope = { source: string[]; contentHash: string; bodyProjectionHash: string; destinations: Destination[]; assistant?: AssistantSource }
export interface RawCapsule2AssetReferences {
  readonly kind: 'capsule2-known-markdown-asset-references'; readonly version: 3
  readonly state: 'source-markdown-destinations-only'; readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly sourceFileOwnershipVerified: false; readonly sourceFileBytesVerified: false
  readonly destinationCoordinates: 'original-summary-or-masked-body-or-source-assistant-markdown-utf16'
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string
  readonly scopes: readonly Scope[]; readonly observationHash: string
  readonly unresolved: readonly ['remaining-policy-held-payload-asset-scopes', 'source-file-ownership-and-bytes', 'durable-asset-originals', 'complete-private-capsule2-certifier']
}
const bad = (message: string): never => { throw new Error('capsule2 asset references无效：' + message + '；不访问资产文件，不授认证或安装权。') }
const opaque = new Set(['code', 'code-block', 'math', 'frontmatter', 'database-view', 'synced-block'])

/** Known ordinary/synced/assistant Markdown holders from the same actual readonly
 * snapshot, after full source/history checks. No caller IDs, URLs, paths, asset
 * roots, group DTOs or filesystem capability are accepted. Only the validated
 * formats' explicit bodies are visited, never arbitrary JSON strings/paths.
 * Remaining policy and all file authority stay explicitly uncertified. */
export function readRawCapsule2AssetReferencesOwned(db: Database.Database): RawCapsule2AssetReferences {
  const history = readRawCapsule2WorkspaceHistoryOwned(db), physical = readRawCapsule2PhysicalGraphOwned(db)
  const scopes: Scope[] = [], keys = new Set<string>()
  let bytes = 0
  const add = (source: string[], body: Body) => {
    const key = capsuleJson(source)
    if (keys.has(key)) return bad('原scope定位重复')
    keys.add(key)
    const contentHash = capsuleBytesHash('knowbook.capsule2.asset-scope-content.v1\0' + capsuleJson(body))
    // The actual ordinary serializer supplies cross-block reference/footnote
    // scope. Literal nodes and saved opaque template references cannot expose
    // their content or format/config strings as Markdown destinations.
    const blocks = body.blocks.map(block => opaque.has(block.type)
      ? { id: block.id, type: 'paragraph', content: '', checked: false, depth: block.depth, parentBlockId: block.parentBlockId ?? null }
      : block)
    const markdown = serializeMarkdownWithBlockRanges(blocks).markdown
    const bodyProjectionHash = capsuleBytesHash('knowbook.capsule2.asset-body-discovery-projection.v1\0' + markdown)
    const destinations: Destination[] = []
    for (const [section, text] of [['summary', body.summary], ['body', markdown]] as const) {
      for (const item of collectStoredMarkdownAssetDestinations(text)) {
        const destination: Destination = { section, uri: item.url, raw: text.slice(item.start, item.end), from: item.start, to: item.end, kind: item.kind, syntax: item.syntax ?? 'markdown' }
        bytes += Buffer.byteLength(capsuleJson(destination))
        if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整目标集合超准备预算，不能截断')
        destinations.push(destination)
      }
    }
    const scope = { source, contentHash, bodyProjectionHash, destinations }
    bytes += Buffer.byteLength(capsuleJson({ ...scope, destinations: [] }))
    if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整scope集合超准备预算，不能截断')
    scopes.push(scope)
  }
  for (const document of physical.documents) add(['documents', document.documentId], { summary: document.summary, blocks: document.blocks })
  for (const group of physical.groups) if (group.snapshot) add(['synced_groups', group.groupId], { summary: '', blocks: group.snapshot.blocks })
  // Every table/order below is a fixed local selector after the complete raw
  // SQL/history preflight, never caller-controlled SQL or a row allowlist.
  const rows = <T = Record<string, string>>(table: string, order = 'id') => db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).all() as T[]
  for (const row of rows('document_history')) add(['document_history', row.id, 'content_json'], JSON.parse(row.content_json) as Body)
  for (const row of rows('document_trash')) add(['document_trash', row.id, 'snapshot_json', 'content'], (JSON.parse(row.snapshot_json) as { content: Body }).content)
  for (const row of rows('document_block_moves')) for (const side of ['before_json', 'after_json'] as const) {
    for (const item of JSON.parse(row[side]) as Array<{ documentId: string; content: Body }>) add(['document_block_moves', row.id, side, item.documentId], item.content)
  }
  for (const row of rows('document_templates')) add(['document_templates', row.id], { summary: row.summary, blocks: JSON.parse(row.blocks_json) as DocumentBlockDraft[] })
  const body = (source: string[], value: Body) => add(source, { summary: value.summary, blocks: value.blocks })
  const group = (source: string[], value: Pick<Body, 'blocks'>) => add(source, { summary: '', blocks: value.blocks })
  const record = (source: string[], value: SyncedProtocol5Record) => {
    if (value.kind === 'document') body(source, value.content)
    else if (value.kind === 'synced-group') group(source, value)
    // Catalogs, tombstones, guards, paths and hashes are not Markdown bodies.
  }
  for (const row of rows('synced_group_history')) for (const side of ['before_json', 'after_json'] as const) {
    group(['synced_group_history', row.id, side], JSON.parse(row[side]) as Pick<Body, 'blocks'>)
  }
  for (const row of rows<SyncedHostHistoryBranchRow>('synced_host_history')) {
    const kind = hostJournalKind(row), journal = kind === 'bare-create' ? null : decodeHostJournal(row)
    for (const side of ['before_json', 'after_json'] as const) {
      const values = journal ? side === 'before_json' ? journal.before : journal.after : validateHostSides(JSON.parse(row[side]))
      for (const item of values) body(['synced_host_history', row.id, side, item.documentId], item.content)
    }
    if (journal) {
      for (const item of journal.persisted) body(['synced_host_history', row.id, 'action_json', 'persisted', item.documentId], item.content)
      for (const item of journal.input.hostsWorkingBefore) body(['synced_host_history', row.id, 'action_json', 'input', 'hostsWorkingBefore', item.documentId], item.workingBefore)
      if (journal.input.mode === 'host-final') for (const item of journal.input.finalAfter) {
        body(['synced_host_history', row.id, 'action_json', 'input', 'finalAfter', item.documentId], item)
      }
      if ('create' in journal) group(['synced_host_history', row.id, 'action_json', 'create', 'wire'], journal.create.wire)
    }
  }
  for (const row of rows<SyncedGroupOperationRow>('synced_operations', 'client_operation_id')) {
    const value = JSON.parse(row.result_json) as { kind?: string; version?: number }
    const source = ['synced_operations', row.client_operation_id, 'result_json']
    if (value.kind === undefined || value.kind === 'synced-host-operation' || value.kind === 'synced-host-create-operation') {
      const ack = decodeSyncedOperationAck(row)
      if ('snapshot' in ack) group([...source, 'snapshot'], ack.snapshot)
      else {
        for (const host of ack.hosts) {
          body([...source, 'result', 'hosts', host.documentId, 'logicalBefore'], host.logicalBefore)
          body([...source, 'result', 'hosts', host.documentId, 'after'], host.after)
        }
        for (const item of ack.groups) group([...source, 'result', 'groups', item.groupId], item)
        if ('createdLifecycle' in ack && ack.createdLifecycle.state === 'retired-create') {
          group([...source, 'result', 'createdLifecycle', 'wire'], ack.createdLifecycle.wire)
        }
      }
    } else if (value.kind === 'synced-logical-deletion-proof') {
      const proof = value.version === 2 ? validateSyncedLogicalDeletionChoiceProof(value) : validateSyncedLogicalDeletionProof(value)
      record([...source, 'before'], proof.before)
      if ('base' in proof) record([...source, 'base'], proof.base)
    }
  }
  if (physical.schemaVersion === 27) for (const row of rows<{ group_id: string; wire_json: string }>('synced_group_retirements', 'group_id')) {
    group(['synced_group_retirements', row.group_id, 'wire_json'], JSON.parse(row.wire_json) as Pick<Body, 'blocks'>)
  }
  for (const row of rows<{ key: string; value: string }>('app_settings', 'key')) {
    const source = ['app_settings', row.key, 'value']
    if (row.key.startsWith(RECOVERY_BOUNDARY_PREFIX)) {
      const boundary = validateSyncedRecoveryHistoryBoundary(JSON.parse(row.value))
      for (const archive of boundary.groups) for (const item of archive.rows) for (const side of ['before_json', 'after_json'] as const) {
        group([...source, 'groups', archive.groupId, 'rows', item.id, side], JSON.parse(item[side]) as Pick<Body, 'blocks'>)
      }
    } else if (row.key.startsWith('sync.webdav.protocol5.exchange-history-row.v1.')) {
      const archived = (JSON.parse(row.value) as { row: { before_json: string; after_json: string } }).row
      for (const side of ['before_json', 'after_json'] as const) group([...source, 'row', side], JSON.parse(archived[side]) as Pick<Body, 'blocks'>)
    } else if (row.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')) {
      const job = validateExchangeJob(JSON.parse(row.value))
      if (job.version === 4 || job.version === 7) for (const item of job.deletions) {
        record([...source, 'deletions', item.key, 'before'], item.before)
        if ('base' in item) record([...source, 'deletions', item.key, 'base'], item.base)
      }
      if (job.version === 7) {
        for (const part of ['localPhysical', 'localKnowledge', 'remote'] as const) for (const item of job.decisionSource[part].records) {
          record([...source, 'decisionSource', part, 'records', item.key, 'record'], item.record)
        }
        for (const item of job.decisionSource.baseRecords) record([...source, 'decisionSource', 'baseRecords', item.key, 'record'], item.record)
      }
    }
  }
  const assistantScope = (sessionId: string, stepId: string, kind: AssistantSource['kind'], parts: AssistantPart[]) => {
    const source = ['assistant_events', parts[0].eventId, 'payload_json', 'text', ...(kind === 'retained-stream' ? ['retained-stream'] : [])]
    const key = capsuleJson(source)
    if (keys.has(key)) return bad('原助手scope定位重复')
    // Check a lower bound incrementally before duplicating large source IDs
    // into the complete metadata/hash frames. The final accounting below is
    // exact and shared with every existing document/history scope.
    const assistant: AssistantSource = { kind, sessionId, stepId, parts: [] }
    let minimum = Buffer.byteLength(key) + Buffer.byteLength(capsuleJson(assistant)), position = 0
    if (bytes + minimum > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整助手定位超准备预算，不能截断')
    for (const part of parts) {
      const span = { eventId: part.eventId, seq: part.seq, turnId: part.turnId, from: position, to: position + part.text.length }
      minimum += Buffer.byteLength(capsuleJson(span))
      if (bytes + minimum > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整助手贡献集合超准备预算，不能截断')
      assistant.parts.push(span); position = span.to
    }
    keys.add(key)
    const contentHash = capsuleBytesHash('knowbook.capsule2.asset-assistant-content.v1\0' + capsuleJson({ kind, sessionId, stepId,
      parts: parts.map(part => capsuleBytesHash('knowbook.capsule2.asset-assistant-part.v1\0' + capsuleJson(part))) }))
    const markdown = parts.map(part => part.text).join('')
    const bodyProjectionHash = capsuleBytesHash('knowbook.capsule2.asset-assistant-markdown-projection.v1\0' + capsuleJson(markdown))
    const destinations: Destination[] = []
    bytes += Buffer.byteLength(capsuleJson({ source, contentHash, bodyProjectionHash, destinations: [], assistant }))
    if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整助手scope超准备预算，不能截断')
    for (const item of collectStoredMarkdownAssetDestinations(markdown)) {
      const destination: Destination = { section: 'body', uri: item.url, raw: markdown.slice(item.start, item.end), from: item.start, to: item.end, kind: item.kind, syntax: item.syntax ?? 'markdown' }
      bytes += Buffer.byteLength(capsuleJson(destination))
      if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整助手目标集合超准备预算，不能截断')
      destinations.push(destination)
    }
    scopes.push({ source, contentHash, bodyProjectionHash, destinations, assistant })
  }
  // Full source/history preflight above already validates and bounds every
  // event. Use the actual renderer's per-session, literal stepId accumulation,
  // including legacy reuse across turns. A final message replaces that visible
  // stream; its prior complete Markdown is still retained historical data.
  // Do not parse individual fragments, clamp provider context, strip legacy
  // provider-looking tags or interpret other payload strings as Markdown.
  let sessionId: string | undefined
  const streams = new Map<string, AssistantPart[]>()
  const finish = (stepId: string) => {
    const parts = streams.get(stepId)
    if (parts) { assistantScope(sessionId!, stepId, 'retained-stream', parts); streams.delete(stepId) }
  }
  for (const row of rows<{ id: string; session_id: string; seq: number; type: string; payload_json: string }>('assistant_events', 'session_id,seq')) {
    if (row.session_id !== sessionId) {
      for (const stepId of streams.keys()) finish(stepId)
      sessionId = row.session_id
    }
    if (row.type !== 'assistant.chunk' && row.type !== 'assistant.message') continue
    // Match the existing stored Main JSON.parse semantics after its complete
    // typed payload check; original SQL spelling is bound by sourceContentHash.
    const payload = JSON.parse(row.payload_json) as { turnId: string; stepId: string; text: string }
    const part: AssistantPart = { eventId: row.id, seq: row.seq, turnId: payload.turnId, text: payload.text }
    if (row.type === 'assistant.chunk') {
      const parts = streams.get(payload.stepId)
      if (parts) parts.push(part)
      else streams.set(payload.stepId, [part])
    } else {
      finish(payload.stepId)
      assistantScope(row.session_id, payload.stepId, 'message', [part])
    }
  }
  for (const stepId of streams.keys()) finish(stepId)
  scopes.sort((a, b) => { const left = capsuleJson(a.source), right = capsuleJson(b.source); return left < right ? -1 : left > right ? 1 : 0 })
  const value = { kind: 'capsule2-known-markdown-asset-references' as const, version: 3 as const,
    state: 'source-markdown-destinations-only' as const, certified: false as const, semanticValidationComplete: false as const, permit: false as const,
    sourceFileOwnershipVerified: false as const, sourceFileBytesVerified: false as const,
    destinationCoordinates: 'original-summary-or-masked-body-or-source-assistant-markdown-utf16' as const,
    sourceContentHash: history.sourceContentHash, workspaceHistoryObservationHash: history.observationHash, scopes,
    unresolved: ['remaining-policy-held-payload-asset-scopes', 'source-file-ownership-and-bytes', 'durable-asset-originals', 'complete-private-capsule2-certifier'] as const }
  const encoded = capsuleJson(value)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整观察超准备预算，不能截断')
  return freezeCapsuleValue({ ...value, observationHash: capsuleBytesHash('knowbook.capsule2.known-markdown-asset-references.v3\0' + encoded) })
}
