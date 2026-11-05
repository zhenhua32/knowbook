import { createHeadingTitle3OriginalDecoder, type HeadingTitle3OriginalSource, type HeadingTitle3OriginalAccess } from './restore-knowledge-heading-title3-original'
import { decodeHeadingTitle3GroupHead, HEADING_TITLE3_GROUP_HEAD_PREFIX } from './synced-heading-title3-codec'
import { validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { knowledgeGroupComparisonKey, knowledgeHash, type KnowledgeGroup, type KnowledgeHistoricalMaterial, type KnowledgeHostJournal,
  type KnowledgeOriginalRow, type KnowledgeOriginalTable, type KnowledgeRowRef } from './restore-knowledge-payload-model'
import { decodeHostCreateJournal, type HostCreateJournal } from './synced-host-create-codec'
import { createRawHash } from './synced-host-create-plan'
import { hostHash, sameHostContent } from './synced-host-journal'
import { hostJson } from './synced-host-document-read'
import { decodeSyncedOperationAck } from './synced-host-operation-receipt'
import { decodeHeadingCreateBirthOriginalMaterial2, type HeadingCreateBirthOriginalAccess2,
  type HeadingCreateBirthOriginalSource2 } from './restore-knowledge-heading-create-birth-original2'
import { historicalOperationLocator, historicalRowLocator, type HistoricalOperationRow } from './synced-history-evidence-support'

interface OriginReferenceSource3 {
  readonly sourceId: string
  readonly status: 'proved-birth' | 'unresolved'
  readonly knownBirth: string | null
  readonly supports: readonly KnowledgeRowRef[]
  readonly reason: string | null
}
type Original = { readonly table: KnowledgeOriginalTable; readonly row: KnowledgeOriginalRow; readonly reference: KnowledgeRowRef }
const same = (left: unknown, right: unknown): boolean => capsuleJson(left) === capsuleJson(right)
const rowReference = (row: KnowledgeOriginalRow): KnowledgeRowRef => ({ table: row.table, key: row.key,
  occurrence: row.occurrence, rowHash: row.rowHash })
const unresolved = (sourceId: string, supports: readonly KnowledgeRowRef[], reason: string): OriginReferenceSource3 =>
  ({ sourceId, status: 'unresolved', knownBirth: null, supports, reason })

/** 只消费真实 Main owner 取得的同次完整输入。这里构造字段来源数据，
 * 不根据同 UUID、唯一已知出生或 captured state 补造历史身份，也不签发句柄。 */
export function deriveRootRestoreProvenanceSources3(data: Graph3Inputs) {
  const knowledge = data.inputs.source.knowledge
  const tables = new Map<string, KnowledgeOriginalTable>(), originals = new Map<string, Original>()
  const checked = new Set<KnowledgeOriginalRow>()
  for (const table of knowledge.originals) {
    if (tables.has(table.table)) return graph3Conflict('provenance-duplicate-original-table', table.table)
    tables.set(table.table, table)
    for (const row of table.rows) {
      if (row.table !== table.table) return graph3Conflict('provenance-original-table-mismatch', table.table)
      const reference = rowReference(row), key = capsuleJson(reference)
      // 相同哈希不表示同一来源；完整 key/occurrence 仍各自保留。
      if (originals.has(key)) return graph3Conflict('provenance-duplicate-original-occurrence', reference)
      originals.set(key, { table, row, reference })
    }
  }
  const text = (original: Original, column: string): string => {
    const position = original.table.columns.indexOf(column), cell = original.row.cells[position]
    if (position < 0 || !cell || cell[0] !== 'text') return graph3Conflict('provenance-original-text-column',
      { source: original.reference, column })
    return graph3Text(cell, knowledge.encoding)
  }
  const read = (reference: KnowledgeRowRef, tableName?: string): Original => {
    const original = originals.get(capsuleJson(reference))
    if (!original || tableName !== undefined && reference.table !== tableName)
      return graph3Conflict('provenance-original-row-reference', reference)
    if (!checked.has(original.row)) {
      const { table, row } = original
      if (row.cells.length !== table.columns.length) return graph3Conflict('provenance-original-row-width', reference)
      const fullColumns = capsuleBytesHash(capsuleJson(table.columns)) === table.fullColumnsHash
      if (table.disclosure === 'complete-evidence-rows' && !fullColumns)
        return graph3Conflict('provenance-incomplete-evidence-row', reference)
      if (fullColumns && row.rowHash !== knowledgeHash('knowbook.knowledge.sql-row.v1', {
        encoding: knowledge.encoding, table: table.table, columns: table.columns, cells: row.cells
      })) return graph3Conflict('provenance-original-row-hash', reference)
      if (table.primaryKey.length) {
        const key = table.primaryKey.map(column => {
          const index = table.columns.indexOf(column)
          if (index < 0) return graph3Conflict('provenance-original-primary-key-column', reference)
          return row.cells[index]
        })
        if (!same(key, row.key)) return graph3Conflict('provenance-original-primary-key', reference)
      }
      checked.add(row)
    }
    return original
  }
  const operationTable = tables.get('synced_operations')
  if (!operationTable) return graph3Conflict('provenance-missing-operation-table', null)
  const operationRows = new Map<string, Original[]>()
  for (const row of operationTable.rows) {
    const original = originals.get(capsuleJson(rowReference(row)))!, id = text(original, 'client_operation_id')
    const occurrences = operationRows.get(id) ?? []
    occurrences.push(original); operationRows.set(id, occurrences)
  }
  const materialByPrimary = new Map<string, KnowledgeHistoricalMaterial[]>()
  for (const material of knowledge.historicalMaterial) {
    const key = capsuleJson(material.primary), occurrences = materialByPrimary.get(key) ?? []
    occurrences.push(material); materialByPrimary.set(key, occurrences)
  }
  // 仅在本次完整重建内索引；重复来源保留为多项并由消费处拒绝。
  const journalsBySource = new Map<string, KnowledgeHostJournal[]>()
  for (const journal of knowledge.hostJournals) {
    const key = capsuleJson(journal.source), occurrences = journalsBySource.get(key) ?? []
    occurrences.push(journal); journalsBySource.set(key, occurrences)
  }
  const matchingJournal = (group: KnowledgeGroup, supports: KnowledgeRowRef[]): HostCreateJournal | null => {
    if (!group.createJournalSource) return null
    const bad = (reason: string): never => graph3Conflict('provenance-declared-create-journal-mismatch',
      { comparisonKey: group.comparisonKey, reason })
    if (!group.lifecycle || !group.lifecycleSource) return bad('missing-lifecycle')
    const lifecycle = read(group.lifecycleSource, 'synced_group_lifecycle')
    supports.push(group.lifecycleSource)
    if (text(lifecycle, 'group_id') !== group.tuple.groupId || text(lifecycle, 'creation_id') !== group.tuple.creationId
      || text(lifecycle, 'create_history_id') !== group.lifecycle.createHistoryId
      || group.lifecycle.groupId !== group.tuple.groupId || group.lifecycle.creationId !== group.tuple.creationId)
      return bad('lifecycle-stable-identity')
    const original = read(group.createJournalSource, 'synced_host_history')
    supports.push(group.createJournalSource)
    const token = text(original, 'id')
    if (!group.lifecycle.createHistoryId || token !== group.lifecycle.createHistoryId) return bad('create-history-id')
    const captured = journalsBySource.get(capsuleJson(group.createJournalSource)) ?? []
    if (captured.length !== 1 || captured[0].historyToken !== token || captured[0].kind !== 'host-command'
      || captured[0].decoded.kind !== 'finite' || !('create' in captured[0].decoded.value)) return bad('finite-create-source')
    let journal: HostCreateJournal
    try {
      journal = decodeHostCreateJournal({ id: token, action_json: text(original, 'action_json'),
        before_json: text(original, 'before_json'), after_json: text(original, 'after_json'),
        before_hash: text(original, 'before_hash'), after_hash: text(original, 'after_hash'), created_at: text(original, 'created_at') })
    } catch { return bad('invalid-original-create-journal') }
    if (!same(journal, captured[0].decoded.value)) return bad('decoded-source-mismatch')
    const wire = journal.create.wire
    if (!same({ groupId: wire.id, creationId: wire.creationId, createdAt: wire.createdAt, origin: wire.origin }, group.tuple)
      || journal.input.action.documentId !== group.tuple.origin.documentId
      || journal.input.action.instanceId !== group.tuple.origin.firstInstanceId
      || journal.create.wireHash !== createRawHash(wire)) return bad('original-group-tuple')
    return journal
  }
  const firstInstance = (group: KnowledgeGroup): OriginReferenceSource3 => {
    const sourceId = group.tuple.origin.firstInstanceId, supports: KnowledgeRowRef[] = [group.source]
    const journal = matchingJournal(group, supports)
    if (!journal) return unresolved(sourceId, supports, 'original-create-chain-unavailable')
    const candidates = operationRows.get(journal.input.clientOperationId) ?? []
    if (!candidates.length) return unresolved(sourceId, supports, 'initial-create-operation-missing')
    if (candidates.length !== 1) return graph3Conflict('contradictory-original-create-pair',
      { comparisonKey: group.comparisonKey, reason: 'duplicate-original-operation' })
    const original = read(candidates[0].reference, 'synced_operations')
    const materials = materialByPrimary.get(capsuleJson(original.reference)) ?? []
    if (!materials.length) return unresolved(sourceId, supports, 'initial-create-ack-fact-missing')
    const bad = (reason: string): never => graph3Conflict('contradictory-original-create-pair',
      { comparisonKey: group.comparisonKey, operationId: journal.input.clientOperationId, reason })
    const operation: HistoricalOperationRow = { client_operation_id: text(original, 'client_operation_id'),
      request_hash: text(original, 'request_hash'), result_json: text(original, 'result_json'), created_at: text(original, 'created_at') }
    const locator = historicalOperationLocator(operation)
    let ack: ReturnType<typeof decodeSyncedOperationAck>
    if (materials.some(material => material.fact.family === 'heading-create-birth')) {
      if (operation.request_hash !== hostHash({ method: 'applySyncedHostCommand', input: journal.input })) return bad('original-request-hash')
      const exactSet = (left: readonly unknown[], right: readonly unknown[]): boolean => {
        const a = left.map(value => capsuleJson(value)), b = right.map(value => capsuleJson(value))
        return new Set(a).size === a.length && new Set(b).size === b.length && same([...a].sort(), [...b].sort())
      }
      let selected: ReturnType<typeof decodeSyncedOperationAck> | undefined
      for (const material of materials) {
        if (material.fact.family !== 'heading-create-birth' || material.fact.version !== 1 || material.fact.evidenceClass !== 'durable-only'
          || !same(material.fact.locator, locator) || !same(material.primary, original.reference)) return bad('original-heading-birth-fact')
        // Every lookup is confined to THIS material's complete original supports.
        // No current DB, current point, partial identity projection or UUID-only
        // substitute can provide a missing old namespace or journal.
        const materialRows = material.supports.map(reference => read(reference))
        const complete = (value: Original, names: readonly string[]): HeadingCreateBirthOriginalSource2<Original> => {
          if (value.table.disclosure !== 'complete-evidence-rows' || value.table.columns.length !== names.length
            || new Set(value.table.columns).size !== value.table.columns.length || names.some(name => !value.table.columns.includes(name)))
            return bad('incomplete-heading-birth-original-columns')
          const checked = read(value.reference, value.table.table)
          return { value: Object.fromEntries(names.map(name => [name, text(checked, name)])), source: checked }
        }
        const operationColumns = ['client_operation_id', 'request_hash', 'result_json', 'created_at']
        const metadataColumns = ['key', 'value', 'updated_at']
        const journalColumns = ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at']
        const pinColumns = ['group_id', 'kind', 'pin_id', 'created_at']
        const select = (table: string, column: string, key: string, names: readonly string[]) => {
          const found = materialRows.filter(value => {
            const index = value.table.columns.indexOf(column), cell = value.row.cells[index]
            return value.table.table === table && index >= 0 && cell?.[0] === 'text' && graph3Text(cell, knowledge.encoding) === key
          })
          if (found.length !== 1) return bad('heading-birth-support-missing-or-duplicate')
          return complete(found[0], names)
        }
        const access: HeadingCreateBirthOriginalAccess2<Original> = {
          operation: id => id === operation.client_operation_id ? complete(original, operationColumns)
            : select('synced_operations', 'client_operation_id', id, operationColumns),
          metadata: key => select('app_settings', 'key', key, metadataColumns),
          journal: token => select('synced_host_history', 'id', token, journalColumns),
          pins: _token => materialRows.filter(value => value.table.table === 'synced_group_pins').map(value => complete(value, pinColumns))
        }
        let decoded: ReturnType<typeof decodeHeadingCreateBirthOriginalMaterial2<Original>>
        try { decoded = decodeHeadingCreateBirthOriginalMaterial2(operation.client_operation_id, access) }
        catch { return bad('invalid-original-heading-birth-material') }
        const references = decoded.supportSources.map(value => value.reference)
        if (!same(decoded.primarySource.reference, original.reference) || !same(decoded.journalSource.reference, group.createJournalSource)
          || !exactSet(material.supports, references) || !exactSet(material.fact.supports, decoded.supports)) return bad('heading-birth-exact-original-support-closure')
        if (selected && !same(selected, decoded.result)) return bad('contradictory-heading-birth-originals')
        selected = decoded.result
        for (const reference of [material.primary, ...references]) if (!supports.some(value => same(value, reference))) supports.push(reference)
      }
      if (!selected) return bad('heading-birth-original-ack-missing')
      ack = selected
    } else {
      for (const material of materials) {
        if (material.fact.family !== 'host-create-ack' || material.fact.version !== 1
          || !same(material.fact.locator, locator) || !same(material.primary, original.reference)
          // 此已知 family/version 的真实 producer 不声明其它支持边。
          || material.supports.length !== 0 || material.fact.supports.length !== 0) return bad('original-ack-fact')
        supports.push(material.primary)
      }
      if (operation.request_hash !== hostHash({ method: 'applySyncedHostCommand', input: journal.input })) return bad('original-request-hash')
      try { ack = decodeSyncedOperationAck(operation) } catch { return bad('invalid-original-ack') }
    }
    if (!('createdLifecycle' in ack)) return bad('original-ack-namespace')
    const life = ack.createdLifecycle
    if (life.state !== 'active' || ack.operationId !== journal.input.clientOperationId
      || ack.historyToken !== group.lifecycle!.createHistoryId || life.createHistoryId !== ack.historyToken
      || !same({ groupId: life.groupId, creationId: life.creationId, createdAt: life.createdAt, origin: life.origin }, group.tuple)
      || life.activationHash !== journal.create.wireHash) return bad('original-ack-stable-create-tuple')
    const own = ack.groups.find(item => item.groupId === group.tuple.groupId)
    if (!own || createRawHash({ kind: 'synced-group', id: own.groupId, creationId: own.creationId, createdAt: own.createdAt,
      origin: own.origin, blocks: own.blocks, bindings: own.bindings }) !== journal.create.wireHash) return bad('original-ack-wire')
    const host = ack.hosts[0]
    if (ack.hosts.length !== 1 || host.documentId !== group.tuple.origin.documentId || journal.before.length !== 1
      || journal.after.length !== 1 || journal.before[0].documentId !== host.documentId || journal.after[0].documentId !== host.documentId
      || !sameHostContent(host.logicalBefore, journal.before[0].content)
      || !sameHostContent({ title: host.after.title, summary: host.after.summary,
        blocks: host.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }, journal.after[0].content)) return bad('original-ack-working-and-after')
    const births = journal.births.filter(item => item.documentId === group.tuple.origin.documentId && item.blockId === sourceId)
    if (births.length !== 1 || births[0].createdAt !== journal.create.instanceCreatedAt) return bad('original-instance-birth')
    return { sourceId, status: 'proved-birth', knownBirth: births[0].createdAt, supports, reason: null }
  }
  // Every new transition fact is authenticated from THIS material's complete
  // original closure before any source provenance is returned. It does not
  // manufacture an initial instance birth, a current point, or a write permit.
  const titleOriginals=new Map<string,ReturnType<ReturnType<typeof createHeadingTitle3OriginalDecoder<Original>>>>()
  const sameSet3=(left:readonly unknown[],right:readonly unknown[])=>{
    const a=left.map(value=>capsuleJson(value)),b=right.map(value=>capsuleJson(value))
    return new Set(a).size===a.length&&new Set(b).size===b.length&&same([...a].sort(),[...b].sort())
  }
  const completeTitleOriginal=(value:Original,names:readonly string[]):HeadingTitle3OriginalSource<Original>=>{
    const checked=read(value.reference,value.table.table)
    if(checked.table.disclosure!=='complete-evidence-rows'||checked.table.columns.length!==names.length
      ||new Set(checked.table.columns).size!==checked.table.columns.length||names.some(name=>!checked.table.columns.includes(name)))
      return graph3Conflict('provenance-heading-title3-incomplete-original-columns',checked.reference)
    return{value:Object.fromEntries(names.map(name=>[name,text(checked,name)])),source:checked}
  }
  for(const material of knowledge.historicalMaterial)if(material.fact.family==='heading-title-transition'){
    const primary=read(material.primary,'synced_operations')
    const operation={client_operation_id:text(primary,'client_operation_id'),request_hash:text(primary,'request_hash'),
      result_json:text(primary,'result_json'),created_at:text(primary,'created_at')}
    if(material.fact.version!==3||material.fact.evidenceClass!=='durable-only'||!same(material.fact.locator,historicalOperationLocator(operation)))
      return graph3Conflict('provenance-heading-title3-original-fact',material.primary)
    const members=material.supports.map(reference=>read(reference))
    const operationColumns=['client_operation_id','request_hash','result_json','created_at'],metadataColumns=['key','value','updated_at']
    const journalColumns=['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],pinColumns=['group_id','kind','pin_id','created_at']
    const select=(table:string,column:string,key:string,names:readonly string[])=>{
      const found=members.filter(value=>value.table.table===table&&text(value,column)===key)
      if(found.length!==1)return graph3Conflict('provenance-heading-title3-missing-or-duplicate-support',{table,column,key})
      return completeTitleOriginal(found[0],names)
    }
    const access:HeadingTitle3OriginalAccess<Original>={
      operation:id=>id===operation.client_operation_id?completeTitleOriginal(primary,operationColumns):select('synced_operations','client_operation_id',id,operationColumns),
      metadata:key=>select('app_settings','key',key,metadataColumns),journal:id=>select('synced_host_history','id',id,journalColumns),
      pins:token=>members.filter(value=>value.table.table==='synced_group_pins'&&text(value,'kind')==='host-history'&&text(value,'pin_id')===token)
        .map(value=>completeTitleOriginal(value,pinColumns))
    }
    let decoded:ReturnType<ReturnType<typeof createHeadingTitle3OriginalDecoder<Original>>>
    try{decoded=createHeadingTitle3OriginalDecoder(access)(operation.client_operation_id)}
    catch{return graph3Conflict('provenance-heading-title3-invalid-original-closure',material.primary)}
    if(!same(decoded.primarySource.reference,material.primary)||!sameSet3(material.supports,decoded.supportSources.map(value=>value.reference))
      ||!sameSet3(material.fact.supports,decoded.supports))return graph3Conflict('provenance-heading-title3-exact-original-support-closure',material.primary)
    const address=capsuleJson(material.primary),previous=titleOriginals.get(address)
    if(previous&&!same(previous.envelope,decoded.envelope))return graph3Conflict('provenance-heading-title3-contradictory-originals',material.primary)
    titleOriginals.set(address,decoded)
  }
  for(const material of knowledge.historicalMaterial)if(material.fact.family==='heading-title-head'){
    const primary=read(material.primary,'app_settings'),source=completeTitleOriginal(primary,['key','value','updated_at'])
    const head=decodeHeadingTitle3GroupHead(hostJson(String(source.value.value))),supports=material.supports.map(reference=>read(reference))
    const operations=supports.filter(value=>value.table.table==='synced_operations'),metadata=supports.filter(value=>value.table.table==='app_settings')
    if(material.fact.version!==3||material.fact.evidenceClass!=='index-attempt-only'||supports.length!==2||operations.length!==1||metadata.length!==1)return graph3Conflict('provenance-heading-title3-head-fact',material.primary)
    const operation=operations[0],decoded=titleOriginals.get(capsuleJson(operation.reference)),member=decoded?.materials.find(item=>item.group.groupId===head.groupId)
    const companion=completeTitleOriginal(metadata[0],['key','value','updated_at'])
    const locator=historicalOperationLocator({client_operation_id:text(operation,'client_operation_id'),request_hash:text(operation,'request_hash'),
      result_json:text(operation,'result_json'),created_at:text(operation,'created_at')})
    if(!decoded||!member||source.value.key!==HEADING_TITLE3_GROUP_HEAD_PREFIX+head.groupId||source.value.value!==capsuleJson(head)
      ||!same(material.fact.locator,historicalRowLocator('app_settings',[String(source.value.key)],source.value))
      ||!sameSet3(material.fact.supports,[locator,historicalRowLocator('app_settings',[String(companion.value.key)],companion.value)])||!same(companion.value,decoded.metadata)
      ||head.operationId!==decoded.row.client_operation_id||head.companionHash!==decoded.companion.companionHash||head.creationId!==member.group.creationId
      ||head.groupCreatedAt!==member.group.createdAt||head.revision!==member.group.afterRevision||head.topologyRevision!==member.group.sourceTopologyRevision
      ||head.wireHash!==member.group.afterHash||head.historyCursor!==member.group.sourceHistoryCursor||source.value.updated_at!==decoded.companion.createdAt)
      return graph3Conflict('provenance-heading-title3-head-original-mismatch',material.primary)
  }

  const origins = knowledge.groups.map((group, occurrence) => {
    const original = read(group.source, 'synced_groups')
    if (group.lifecycleSource) read(group.lifecycleSource, 'synced_group_lifecycle')
    let origin: ReturnType<typeof validateSyncedOrigin>
    try { origin = validateSyncedOrigin(hostJson(text(original, 'origin_json'))) }
    catch { return graph3Conflict('provenance-invalid-original-origin', group.source) }
    if (text(original, 'id') !== group.tuple.groupId || text(original, 'creation_id') !== group.tuple.creationId
      || text(original, 'created_at') !== group.tuple.createdAt || text(original, 'origin_json') !== group.originalOriginJson
      || !same(origin, group.tuple.origin) || knowledgeGroupComparisonKey(group.tuple) !== group.comparisonKey)
      return graph3Conflict('provenance-original-group-tuple', group.source)
    return { occurrence, sourceWitness: data.value.sourceWitness, sourcePayload: data.value.sourcePayload,
      tuple: group.tuple, comparisonKey: group.comparisonKey, groupSource: group.source,
      originalOriginJson: group.originalOriginJson, origin: group.tuple.origin,
      lifecycleSource: group.lifecycleSource, createJournalSource: group.createJournalSource,
      // 现有 DocumentDetail/ACK 没有文档 createdAt，updatedAt 不是出生。
      document: unresolved(group.tuple.origin.documentId, [group.source], 'unresolved-historical-birth'), firstInstance: firstInstance(group) }
  })
  const capturedBindings = knowledge.bindings.map(capture => { read(capture.source); return capture })
  const body = { kind: 'complete-root-restore-provenance-sources' as const, version: 3 as const,
    scope: 'root-source-origin-and-captured-bindings' as const, root: data.inputs.knowledge.constraints.root,
    sourceWitness: data.value.sourceWitness, sourcePayload: data.value.sourcePayload,
    conservationHash: data.inputs.knowledge.conservationHash, identityAllocationHash: data.value.allocationHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    origins, capturedBindings, hintsOnly: true as const, ordinaryNavigationCaptured: false as const,
    sourceRewriting: false as const, provenanceReferencesRewritten: false as const, linkBindingsRewritten: false as const,
    templateStructureReferencesRewritten: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-provenance-source-budget', null)
  return freezeCapsuleValue({ ...body, provenanceSourceHash: capsuleBytesHash('knowbook.restore.provenance3.sources.v1\0' + encoded) })
}
