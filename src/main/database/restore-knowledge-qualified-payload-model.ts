import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { validateCoverageCapsuleReference, validateCoverageRootReference,
  type CoverageCapsuleReference, type CoverageInputBinding } from './restore-knowledge-coverage-model'
import { requiredDagInterpretationHash, type RequiredDagOrigin } from './restore-knowledge-required-dag-model'
import { knowledgeGroupComparisonKey, knowledgeDocumentComparisonKey, knowledgeHash, knowledgePayloadHash,
  type CapsuleKnowledgePayload, type KnowledgeRowRef, type KnowledgeSqlCell } from './restore-knowledge-payload-model'
import { validateObservedIncarnation, validateRemoteObservationMarker } from './synced-remote-observation-codec'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { RAW_SYNCED_HISTORICAL_FORMATS } from './synced-history-evidence-model'

export const QUALIFIED_KNOWLEDGE_MAX_INPUTS = 1024
export const QUALIFIED_KNOWLEDGE_MAX_JSON_BYTES = 128 * 1024 * 1024
const MAX_NODES = 1_000_000, MAX_DEPTH = 128
export interface QualifiedKnowledgePayload2 {
  readonly kind: 'qualified-durable-sql-knowledge-payload-diagnostic'; readonly version: 2
  readonly capsule: CoverageCapsuleReference
  readonly originalBinding: CoverageInputBinding; readonly originalOrigin: RequiredDagOrigin
  readonly projection: CapsuleKnowledgePayload; readonly projectionHash: string
  readonly projectionStructure: 'descriptor-safe-local-rows-only'; readonly projectionSemanticsAuthenticated: false
  readonly certified: false; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
export const qualifiedKnowledgeInvalid = (message: string): never => {
  throw new Error('qualified K2结构无效：' + message + '；caller DTO不授source/Root/accepted/effective/安装权。')
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const qname = (value: unknown): value is string => typeof value === 'string' && /^[a-z_][a-z0-9_]*$/.test(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
/** Dense own data elements only. This is not a caller-owned source list proof. */
export function qualifiedKnowledgeList(value: unknown, max = MAX_NODES): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return qualifiedKnowledgeInvalid('数组超预算/hole/额外字段')
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, index)
    return item?.enumerable && 'value' in item ? item.value : qualifiedKnowledgeInvalid('数组accessor/非data元素')
  })
}
/** Copy JSON data without invoking getters/toJSON. Nested finite historical
 * bodies remain complete data; this does NOT authenticate their SQL semantics. */
function copyData(input: unknown): unknown {
  let nodes = 0, stringBytes = 0
  const active = new Set<object>()
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return qualifiedKnowledgeInvalid('结构节点/深度超准备预算')
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value)
      if (stringBytes > QUALIFIED_KNOWLEDGE_MAX_JSON_BYTES) return qualifiedKnowledgeInvalid('字符串超准备预算')
      return value
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || active.has(value)) return qualifiedKnowledgeInvalid('非JSON data/循环/非有限数')
    active.add(value)
    let result: unknown
    if (Array.isArray(value)) result = qualifiedKnowledgeList(value).map(item => copy(item, depth + 1))
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) return qualifiedKnowledgeInvalid('记录prototype无效')
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
      if (keys.some(key => typeof key !== 'string')) return qualifiedKnowledgeInvalid('记录symbol字段')
      result = Object.fromEntries((keys as string[]).map(key => {
        const item = descriptors[key]
        if (!item.enumerable || !('value' in item)) return qualifiedKnowledgeInvalid('记录accessor/非enumerable')
        return [key, copy(item.value, depth + 1)]
      }))
    }
    active.delete(value); return result
  }
  return copy(input, 0)
}
function cell(input: unknown, encoding: string): KnowledgeSqlCell {
  const values = qualifiedKnowledgeList(input, 2), [tag, value] = values
  if (tag === 'null' && values.length === 1) return ['null']
  if (values.length !== 2 || typeof value !== 'string') return qualifiedKnowledgeInvalid('原cell闭形无效')
  if (tag === 'integer' && value.length <= 20 && /^(?:0|-?[1-9][0-9]*)$/.test(value) && BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n) return ['integer', value]
  if (tag === 'real-ieee754-le' && /^[0-9a-f]{16}$/.test(value)) return ['real-ieee754-le', value]
  if (tag === 'text' || tag === 'blob') {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') === value) return rawRestoreSqlCell(tag, bytes, encoding)
  }
  return qualifiedKnowledgeInvalid('原cell tag/编码/INT64无效')
}
function rowRef(input: unknown, encoding: string, original = false): KnowledgeRowRef {
  const value = capsuleRecord(input, ['table', 'key', 'occurrence', 'rowHash', ...(original ? ['cells'] : [])])
  if (!qname(value.table) || !digest(value.rowHash) || typeof value.occurrence !== 'number'
    || !Number.isSafeInteger(value.occurrence) || value.occurrence < 0) return qualifiedKnowledgeInvalid('局部row ref无效')
  const key = qualifiedKnowledgeList(value.key, 512).map(item => cell(item, encoding))
  return { table: value.table, key, occurrence: value.occurrence, rowHash: value.rowHash }
}
const rowKey = (value: KnowledgeRowRef): string => capsuleJson([value.table, value.key, value.occurrence, value.rowHash])
const projectionLists = ['originals', 'groups', 'exposures', 'observations', 'denials', 'occupancy', 'identities', 'instances',
  'hostStates', 'pins', 'bindings', 'databaseViewReferences', 'hostJournals', 'exchangeCuts', 'recoveryBoundaries', 'restoreLineage',
  'groupHistories', 'archivedGroupHistories', 'historicalMaterial'] as const
const entryFields: Record<typeof projectionLists[number], readonly string[]> = {
  originals: ['table', 'columns', 'primaryKey', 'fullColumnsHash', 'disclosure', 'rows'],
  groups: ['tuple', 'comparisonKey', 'originalOriginJson', 'source', 'lifecycle', 'guards', 'lifecycleSource', 'retirement', 'createJournalSource'],
  exposures: ['attempt', 'kind', 'members', 'source'], observations: ['marker', 'source'],
  denials: ['proof', 'comparisonKey', 'source', 'receipt', 'job', 'mandatoryMaterial'],
  occupancy: ['namespace', 'id', 'kind', 'ownerKind', 'ownerId', 'knownBirth', 'source', 'incarnationKey'],
  identities: ['id', 'ownerKind', 'ownerId', 'state', 'createdAt', 'source'],
  instances: ['instanceId', 'groupId', 'hostDocumentId', 'bindingVersion', 'parentBlockId', 'depth', 'source'],
  hostStates: ['documentId', 'cursor', 'position', 'source'], pins: ['groupId', 'kind', 'pinId', 'createdAt', 'source'],
  bindings: ['binding', 'source', 'provenance'], databaseViewReferences: ['databaseId', 'viewId', 'fieldIds', 'source'],
  hostJournals: ['historyToken', 'kind', 'documentIds', 'source', 'mappings', 'decoded'],
  exchangeCuts: ['cut', 'source', 'journalSource'], recoveryBoundaries: ['boundary', 'source', 'markerSource', 'anchorSource'],
  restoreLineage: ['lineage', 'kind', 'sourceDatabaseId', 'sourceId', 'state', 'targetId', 'source'],
  groupHistories: ['historyId', 'groupId', 'position', 'before', 'after', 'source'],
  archivedGroupHistories: ['archive', 'operationId', 'archivedAt', 'historyId', 'groupId', 'position', 'before', 'after', 'source'],
  historicalMaterial: ['fact', 'primary', 'supports']
}
function projection(input: unknown): CapsuleKnowledgePayload {
  const value = capsuleRecord(input, ['kind', 'version', 'material', 'capsule', 'schemaVersion', 'workspaceScope', 'recoveryEpoch',
    'schemaHash', 'inventoryHash', 'encoding', 'lifecycleAvailability', ...projectionLists])
  const reference = capsuleRecord(value.capsule, ['kind', 'version', 'operationId', 'capsuleId', 'manifestHash'])
  if (value.kind !== 'durable-sql-knowledge-payload' || value.version !== 1 || value.material !== 'durable-sql-only'
    || reference.kind !== 'durable-sql-capsule-ref' || reference.version !== 1 || !uuid(reference.operationId) || !uuid(reference.capsuleId) || !digest(reference.manifestHash)
    || value.schemaVersion !== 26 && value.schemaVersion !== 27 || !digest(value.schemaHash) || !digest(value.inventoryHash)
    || !['UTF-8', 'UTF-16le', 'UTF-16be'].includes(value.encoding as string)
    || value.workspaceScope !== null && typeof value.workspaceScope !== 'string' || value.recoveryEpoch !== null && typeof value.recoveryEpoch !== 'string'
    || value.lifecycleAvailability !== (value.schemaVersion === 26 ? 'not-in-schema26' : 'schema27')) return qualifiedKnowledgeInvalid('完整K1 projection头无效')
  const encoding = value.encoding as string, localRows = new Map<string, KnowledgeRowRef>(), tables = new Set<string>()
  for (const item of qualifiedKnowledgeList(value.originals)) {
    const table = capsuleRecord(item, entryFields.originals), columns = qualifiedKnowledgeList(table.columns, 512), primaryKey = qualifiedKnowledgeList(table.primaryKey, 512)
    if (!qname(table.table) || tables.has(table.table) || !columns.length || columns.some(name => !qname(name)) || new Set(columns).size !== columns.length
      || primaryKey.some(name => !columns.includes(name)) || new Set(primaryKey).size !== primaryKey.length || !digest(table.fullColumnsHash)
      || table.disclosure !== 'complete-evidence-rows' && table.disclosure !== 'identity-projection') return qualifiedKnowledgeInvalid('完整originals表摘要无效')
    tables.add(table.table)
    for (const source of qualifiedKnowledgeList(table.rows)) {
      const ref = rowRef(source, encoding, true), raw = source as Record<string, unknown>, cells = qualifiedKnowledgeList(raw.cells, 512)
      if (ref.table !== table.table || cells.length !== columns.length || localRows.has(rowKey(ref))) return qualifiedKnowledgeInvalid('原行表/列宽/occurrence重复')
      cells.forEach(item => cell(item, encoding)); localRows.set(rowKey(ref), ref)
    }
  }
  // Follow only the fixed K1 typed reference edges, never duck-type arbitrary
  // old opaque receipt/job/body objects by matching table/key/rowHash fields.
  // RawHistoricalEvidenceLocator has its different hash/key domain below.
  const local = (input: unknown): KnowledgeRowRef => {
    const ref = rowRef(input, encoding)
    if (!localRows.has(rowKey(ref))) return qualifiedKnowledgeInvalid('局部source/support缺同一envelope原行')
    return ref
  }
  for (const name of projectionLists) for (const source of qualifiedKnowledgeList(value[name])) {
    const item = capsuleRecord(source, entryFields[name])
    if (name === 'originals') continue
    for (const field of ['source', 'primary', 'journalSource', 'markerSource', 'anchorSource', 'lifecycleSource', 'createJournalSource'])
      if (entryFields[name].includes(field) && !(name === 'groups' && ['lifecycleSource', 'createJournalSource'].includes(field) && item[field] === null)) local(item[field])
    for (const field of ['mandatoryMaterial', 'mappings', 'supports']) if (entryFields[name].includes(field)) qualifiedKnowledgeList(item[field]).forEach(local)
  }
  const result = value as unknown as CapsuleKnowledgePayload
  for (const group of result.groups) {
    const tuple = validateObservedIncarnation(group.tuple)
    if (group.comparisonKey !== knowledgeGroupComparisonKey(tuple) || typeof group.originalOriginJson !== 'string'
      || capsuleJson(JSON.parse(group.originalOriginJson)) !== capsuleJson(tuple.origin)) return qualifiedKnowledgeInvalid('原group稳定tuple/comparisonKey不闭合')
    if (group.lifecycle !== null && !['never', 'unknown', 'possible', 'confirmed'].includes(group.lifecycle.exposure)) return qualifiedKnowledgeInvalid('原exposure枚举无效')
    if (group.retirement !== null) local(capsuleRecord(group.retirement, ['wire', 'semanticHash', 'retiredAt', 'createHistoryId', 'source']).source)
  }
  for (const exposure of result.exposures) {
    capsuleRecord(exposure.attempt, ['id', 'requestHash', 'channel', 'targetFingerprint', 'publicationHash', 'state', 'createdAt', 'confirmedAt'])
    if (exposure.attempt.state !== 'possible' && exposure.attempt.state !== 'confirmed') return qualifiedKnowledgeInvalid('原attempt状态无效')
    for (const member of qualifiedKnowledgeList(exposure.members)) {
      const item = capsuleRecord(member, ['tuple', 'comparisonKey', 'revision', 'topologyRevision', 'semanticHash', 'source'])
      if (item.comparisonKey !== knowledgeGroupComparisonKey(validateObservedIncarnation(item.tuple))) return qualifiedKnowledgeInvalid('member稳定tuple变化')
      local(item.source)
    }
  }
  for (const observation of result.observations) validateRemoteObservationMarker(observation.marker)
  for (const denial of result.denials) {
    const before = denial.proof.before
    const key = before.kind === 'synced-group' ? knowledgeGroupComparisonKey({ groupId: before.id, creationId: before.creationId, createdAt: before.createdAt, origin: before.origin })
      : before.kind === 'document' ? knowledgeDocumentComparisonKey(before.id, before.createdAt) : qualifiedKnowledgeInvalid('denial before格式无效')
    if (denial.comparisonKey !== key) return qualifiedKnowledgeInvalid('denial稳定comparisonKey变化')
  }
  for (const item of result.occupancy) if (!['document', 'block', 'group', 'instance', 'database', 'column', 'view', 'entity'].includes(item.namespace)
    || typeof item.id !== 'string' || [item.ownerKind, item.ownerId, item.knownBirth, item.incarnationKey].some(value => value !== null && typeof value !== 'string')) return qualifiedKnowledgeInvalid('occupancy known/unknown无效')
  const parameter = (value: unknown): KnowledgeSqlCell => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return ['integer', String(value)]
    if (typeof value !== 'string') return qualifiedKnowledgeInvalid('历史SQL locator key不是原TEXT/整数')
    const bytes = Buffer.from(value, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
    if (encoding === 'UTF-16be') bytes.swap16()
    return rawRestoreSqlCell('text', bytes, encoding)
  }
  for (const item of result.historicalMaterial) {
    const fact = capsuleRecord(item.fact, ['family', 'version', 'evidenceClass', 'locator', 'supports'])
    const formats = Object.getOwnPropertyDescriptor(RAW_SYNCED_HISTORICAL_FORMATS, String(fact.family))
    if (!formats || !formats.value.includes(fact.version) || !['durable-only', 'index-attempt-only'].includes(fact.evidenceClass as string)) return qualifiedKnowledgeInvalid('不是原K1 finite history family/version')
    const originals = [item.primary, ...item.supports], locators = [fact.locator, ...qualifiedKnowledgeList(fact.supports)]
    if (originals.length !== locators.length) return qualifiedKnowledgeInvalid('历史primary/support全集缺项')
    locators.forEach((input, index) => {
      const locator = capsuleRecord(input, ['table', 'key', 'rowHash']), ref = local(originals[index])
      if (!digest(locator.rowHash) || locator.table !== ref.table || capsuleJson(qualifiedKnowledgeList(locator.key).map(parameter)) !== capsuleJson(ref.key)) return qualifiedKnowledgeInvalid('历史SQL locator与局部typed row key不对应')
    })
  }
  return result
}
/** Local locator only; equal strings cannot establish a true owner domain. */
export const qualifiedKnowledgeLocalLocator = (value: CoverageCapsuleReference): string => capsuleJson([value.namespace, value.operationId, value.capsuleId])
export function validateQualifiedKnowledgePayload2(input: unknown): QualifiedKnowledgePayload2 {
  const copied = copyData(input), value = capsuleRecord(copied, ['kind', 'version', 'capsule', 'originalBinding', 'originalOrigin', 'projection', 'projectionHash',
    'projectionStructure', 'projectionSemanticsAuthenticated', 'certified', 'acceptedCoverage', 'effective', 'permit'])
  if (value.kind !== 'qualified-durable-sql-knowledge-payload-diagnostic' || value.version !== 2 || value.projectionStructure !== 'descriptor-safe-local-rows-only'
    || value.projectionSemanticsAuthenticated !== false || value.certified !== false || value.acceptedCoverage !== false || value.effective !== false || value.permit !== false)
    return qualifiedKnowledgeInvalid('不是固定未认证诊断状态')
  const capsule = validateCoverageCapsuleReference(value.capsule), binding = capsuleRecord(value.originalBinding, ['capsule', 'interpretationHash', 'rawRequirementsHash', 'requiredRoots'])
  const original = validateCoverageCapsuleReference(binding.capsule), raw = projection(value.projection)
  if (capsule.readerVersion !== 'knowbook-durable-sql-v1' || original.readerVersion !== 'knowbook-durable-sql-v1') return qualifiedKnowledgeInvalid('当前只有实际K1/v1投影；不能伪填capsule2')
  for (const field of ['operationId', 'capsuleId', 'manifestHash'] as const) if (capsule[field] !== original[field] || original[field] !== raw.capsule[field]) return qualifiedKnowledgeInvalid('outer/binding/inner原op/capsule/hash不一致')
  const origin = value.originalOrigin as RequiredDagOrigin
  if (!digest(binding.rawRequirementsHash) || binding.interpretationHash !== requiredDagInterpretationHash(origin)
    || binding.rawRequirementsHash !== origin.rawRequirementsHash) return qualifiedKnowledgeInvalid('原binding/origin结构hash不闭合')
  const roots = qualifiedKnowledgeList(binding.requiredRoots, 256).map(validateCoverageRootReference)
  for (let index = 1; index < roots.length; index++) if (capsuleJson([roots[index - 1].namespace, roots[index - 1].operationId, roots[index - 1].dagId])
    >= capsuleJson([roots[index].namespace, roots[index].operationId, roots[index].dagId])) return qualifiedKnowledgeInvalid('原requiredRoots未准确排序或局部重复')
  if (origin.kind === 'no-prior-coverage-references' && roots.length) return qualifiedKnowledgeInvalid('无prior原声明含roots')
  if (!digest(value.projectionHash) || value.projectionHash !== knowledgePayloadHash(raw)) return qualifiedKnowledgeInvalid('完整原K1 projectionHash不一致')
  const result = value as unknown as QualifiedKnowledgePayload2
  if (Buffer.byteLength(capsuleJson(result)) > QUALIFIED_KNOWLEDGE_MAX_JSON_BYTES) return qualifiedKnowledgeInvalid('完整outer JSON超准备预算')
  return freezeCapsuleValue(result)
}
export const qualifiedKnowledgePayload2Hash = (value: QualifiedKnowledgePayload2): string => knowledgeHash('knowbook.knowledge.qualified-payload.v2', validateQualifiedKnowledgePayload2(value))
export const qualifiedKnowledgeCompare = compare
