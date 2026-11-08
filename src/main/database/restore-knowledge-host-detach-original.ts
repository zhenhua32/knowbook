import { assertSyncedShape } from '../../shared/syncedBlockValidation'
import type { Capsule2RawContent } from './restore-knowledge-capsule2-raw-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { decodeHostDetachOriginalRows } from './synced-host-detach-original'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import type { SyncedGroupOperationRow } from './synced-group-operation-receipt'
import { headingCreateBirthOriginalsFromRaw2 } from './restore-knowledge-heading-create-birth-original2'
import { headingTitle3OriginalsFromRaw } from './restore-knowledge-heading-title3-original'
import { assertDetachHeadingSource, headingDetachBirthSource, headingDetachTitleSource } from './synced-host-detach-heading'
import { decodeSyncedCanonicalBlockBirthOriginalRows } from './synced-canonical-block-birth'
import type { CreateJournalRow } from './synced-host-create-codec'
import type { HistoricalOperationRow } from './synced-history-evidence-support'
import { parseDetachedCanonicalDestination } from './synced-host-detach-canonical'

const operationFields = ['client_operation_id', 'request_hash', 'result_json', 'created_at']
const journalFields = ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at']
function invalid(): never { throw new Error('附件历史缺少同次解除同步的完整原始行。') }

function texts<T>(value: Record<string, unknown>, fields: readonly string[]): T {
  assertSyncedShape(value, fields)
  if (fields.some(field => typeof value[field] !== 'string')) return invalid()
  return value as T
}

/** The caller is already reading this authenticated original packet. It can
 * grant asset paths from exact bodies only after the receipt/journal joins. */
export function hostDetachOriginalsFromRaw(raw: Capsule2RawContent) {
  const rows = graph3Rows(raw, 'synced_host_history'), journals = new Map(rows.map(row => [String(row.value.id), row]))
  let operations: Map<string, (typeof rows)[number]> | undefined
  let births: ReturnType<typeof headingCreateBirthOriginalsFromRaw2> | undefined
  let transitions: ReturnType<typeof headingTitle3OriginalsFromRaw> | undefined
  if (journals.size !== rows.length) return invalid()
  return (value: Record<string, unknown>) => {
    const operation = texts<SyncedGroupOperationRow & { created_at: string }>(value, operationFields)
    const original = decodeHostDetachOriginalRows(operation, id => {
      const journal = journals.get(id)
      return journal && texts<SyncedHostHistoryBranchRow>(journal.value, journalFields)
    })
    if (!original) return invalid()
    const journalSource = journals.get(original.row.id) ?? invalid()
    const evidence = original.journal.detach, links = evidence.projection.links.filter(link => link.resolved.heading)
    const headingSources: Array<typeof journalSource> = []
    if (links.length) {
      const predecessor = links[0].resolved.heading!.original
      const decoded = predecessor.kind === 'heading-create-birth'
        ? (births ??= headingCreateBirthOriginalsFromRaw2(raw))(predecessor.operationId)
        : (transitions ??= headingTitle3OriginalsFromRaw(raw))(predecessor.operationId)
      const source = 'point' in decoded ? headingDetachBirthSource(decoded, evidence.wire.id) : headingDetachTitleSource(decoded, evidence.wire.id)
      for (const link of links) assertDetachHeadingSource(evidence, source, link.source, link.resolved)
      headingSources.push(decoded.primarySource, ...decoded.supportSources)
    }
    const canonicalSources = new Map<string, typeof journalSource>()
    const addCanonical = (source: typeof journalSource) => canonicalSources.set(JSON.stringify([source.table.name, source.original.sourceRowId]), source)
    const canonicalLinks = evidence.projection.links.filter(link => link.resolved.canonical)
    if (canonicalLinks.length) {
      if (!operations) {
        const operationRows = graph3Rows(raw, 'synced_operations')
        operations = new Map(operationRows.map(row => [String(row.value.client_operation_id), row]))
        if (operations.size !== operationRows.length) return invalid()
      }
      for (const { source, url, resolved } of canonicalLinks) {
        const address = parseDetachedCanonicalDestination(source.syntax, url), pointer = resolved.canonical?.original
        if (!address || !pointer) return invalid()
        const operationSource = operations.get(pointer.operationId), birthJournal = journals.get(pointer.historyToken)
        if (!operationSource || !birthJournal) return invalid()
        const birth = decodeSyncedCanonicalBlockBirthOriginalRows(address, pointer, {
          operation: id => id === pointer.operationId ? texts<HistoricalOperationRow>(operationSource.value, operationFields) : undefined,
          journal: id => id === pointer.historyToken ? texts<CreateJournalRow>(birthJournal.value, journalFields) : undefined,
          headingCreate: id => {
            const decoded = (births ??= headingCreateBirthOriginalsFromRaw2(raw))(id)
            for (const support of decoded.supportSources) addCanonical(support)
            return decoded
          }
        })
        if (birth.status !== 'proved') return invalid()
        addCanonical(operationSource); addCanonical(birthJournal)
      }
    }
    return { ...original, journalSource, headingSources, canonicalSources: [...canonicalSources.values()] }
  }
}
