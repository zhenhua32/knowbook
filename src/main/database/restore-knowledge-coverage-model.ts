import { createHash } from 'node:crypto'
import { parseStrictJson } from '../../shared/strictJson'

/** Pure coverage structure codec. Shape/hash equality never proves that SQL,
 * an origin interpreter, a DAG, a stage or an installed fence was authenticated. */
export const COVERAGE_SETTING_PREFIX = 'synced.restore.coverage.v1.'
export const COVERAGE_OPERATION_PREFIX = 'synced:restore-knowledge-coverage:v1:'
export const COVERAGE_RECEIPT_PREFIX = 'database.restore.receipt.v2.'
export const COVERAGE_ANCHOR_CHANNEL = 'recovery-knowledge-coverage-v1'
export const COVERAGE_MAX_REQUIRED_ROOTS = 256
export const COVERAGE_MAX_REQUIREMENT_ROWS = 100_000
export const COVERAGE_MAX_JSON_BYTES = 2 * 1024 * 1024
export const COVERAGE_MAX_REQUIREMENTS_BYTES = 64 * 1024 * 1024

/** Stored relative namespace only. A native capsule's physical location does
 * not identify the interpretation domain of references inside its original DB. */
export type CoverageNamespace = { readonly kind: 'native' } | {
  readonly kind: 'imported-bundle'; readonly mountId: string; readonly bundleDescriptorHash: string
}
export interface CoverageCapsuleReference {
  readonly kind: 'restore-knowledge-origin-capsule-ref'; readonly version: 1
  readonly namespace: CoverageNamespace; readonly operationId: string; readonly capsuleId: string; readonly manifestHash: string
  readonly readerVersion: 'knowbook-durable-sql-v1' | 'knowbook-durable-sql-coverage-v2'
}
/** This deliberately does not accept the prepared-only DAG v1 readerVersion.
 * No actual v2 producer/reopener is implemented by this pure codec candidate. */
export interface CoverageRootReference {
  readonly kind: 'restore-knowledge-origin-root-ref'; readonly version: 1
  readonly namespace: CoverageNamespace; readonly operationId: string; readonly dagId: string; readonly rootHash: string
  readonly readerVersion: 'knowbook-required-sql-knowledge-dag-v2'
}
export type CoverageCutReference = {
  readonly kind: 'ordinary-empty-epoch-cut'; readonly version: 1; readonly operationId: string
  readonly beforeWorkspaceScope: string; readonly afterWorkspaceScope: string
  readonly beforeEpoch: string; readonly afterEpoch: string; readonly documentBoundary: string; readonly acceptedAt: string
} | {
  readonly kind: 'synced-recovery-epoch-cut'; readonly version: 1; readonly operationId: string
  readonly workspaceScope: string; readonly beforeEpoch: string; readonly afterEpoch: string
  readonly documentBoundary: string; readonly acceptedAt: string; readonly boundaryHash: string
  /** Exact existing recoveryEpochRequestHash(R1), not a new R1 hash codec. */
  readonly epochRequestHash: string
}
/** Existing historical full-row locator hash domain. The real owned SQL reader
 * must fatal-decode/roundtrip original TEXT and bind the whole capsule inventory.
 * This scalar locator is not an original row or proof that the row was read. */
export interface CoverageSqlRowReference {
  readonly table: 'app_settings' | 'synced_operations' | 'synced_exposure_attempts'
  readonly key: readonly [string]; readonly rowHash: string
}
export interface RawCoverageRequirement {
  readonly operationId: string; readonly coverageHash: string; readonly receiptHash: string
  readonly root: CoverageRootReference; readonly cut: CoverageCutReference; readonly acceptedAt: string
  readonly supports: {
    readonly coverage: CoverageSqlRowReference; readonly link: CoverageSqlRowReference
    readonly receipt: CoverageSqlRowReference; readonly anchor: CoverageSqlRowReference
    readonly boundary: CoverageSqlRowReference | null; readonly epoch: CoverageSqlRowReference | null
  }
}
/** Fixed SQL extraction returns unresolved stored references. No native/imported
 * namespace is resolved and no empty/full-scan authority is minted by this DTO. */
export interface RawPriorCoverageRequirements {
  readonly kind: 'restore-knowledge-unresolved-required-roots'; readonly version: 1
  readonly schemaVersion: 26 | 27; readonly entries: readonly RawCoverageRequirement[]
}
export interface CoverageInputBinding {
  readonly capsule: CoverageCapsuleReference
  /** Commitment to a future real Main-owned original-reference interpreter.
   * Caller-supplied equality of this hash is never an interpretation permit. */
  readonly interpretationHash: string
  readonly rawRequirementsHash: string
  /** All roots after that fixed interpreter resolved every original SQL entry.
   * Only the future private owner can prove completeness, not this codec. */
  readonly requiredRoots: readonly CoverageRootReference[]
}
export interface CoverageTarget {
  readonly workspaceScope: string; readonly recoveryEpoch: string; readonly documentBoundary: string
}
export interface SyncedKnowledgeCoverageV1 {
  readonly kind: 'synced-restore-knowledge-coverage'; readonly version: 1
  readonly readerVersion: 'knowbook-accepted-coverage-structure-v1'; readonly material: 'durable-sql-only'
  readonly operationId: string; readonly stageBase: 'current'
  readonly source: CoverageInputBinding; readonly current: CoverageInputBinding
  readonly root: CoverageRootReference; readonly rootMaterialHash: string; readonly planHash: string
  readonly target: CoverageTarget; readonly cut: CoverageCutReference; readonly acceptedAt: string
}
export interface SyncedKnowledgeCoverageLinkV1 {
  readonly kind: 'synced-restore-knowledge-coverage-link'; readonly version: 1; readonly operationId: string
  readonly coverageHash: string; readonly root: CoverageRootReference; readonly rootMaterialHash: string; readonly planHash: string
  readonly cutHash: string; readonly target: CoverageTarget; readonly acceptedAt: string
}
/** The new receipt contains no local absolute path, clone-of-source claim,
 * self hash, final stage hash or new intent/fence hash. Intent3 is a later owner. */
export interface KnowledgeRestoreReceiptV2 {
  readonly kind: 'controlled-database-restore-receipt'; readonly version: 2; readonly material: 'durable-sql-only'
  readonly operationId: string; readonly stageBase: 'current'
  readonly source: CoverageCapsuleReference; readonly current: CoverageCapsuleReference
  readonly coverageHash: string; readonly root: CoverageRootReference; readonly rootMaterialHash: string; readonly planHash: string
  readonly cutHash: string; readonly target: CoverageTarget; readonly acceptedAt: string
}

function refused(message: string): never { throw new Error('恢复知识coverage结构无效：' + message + '；结构/hash相等不授接受或安装权。') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) return refused('须为普通闭形记录')
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors)
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return refused('未知/缺失字段')
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !('value' in descriptor)) return refused('记录含getter或非enumerable字段')
    result[key] = descriptor.value
  }
  return result
}
function list(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return refused('集合超预算/含hole/额外字段')
  const result: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor?.enumerable || !('value' in descriptor)) return refused('集合元素不是enumerable data descriptor')
    result.push(descriptor.value)
  }
  return result
}
function uuid(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : refused('UUID非canonical小写') }
function digest(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : refused('SHA256无效') }
function time(value: unknown): string {
  if (typeof value !== 'string') return refused('时点不是TEXT')
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : refused('时点不是准确UTC ISO')
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value) }
  return value
}
function budget<T>(value: T, max = COVERAGE_MAX_JSON_BYTES): T {
  if (Buffer.byteLength(canonical(value)) > max) return refused('完整记录超预算；不得截断')
  return frozen(value)
}
function domainHash(domain: string, value: unknown): string { return createHash('sha256').update(domain + '\0' + canonical(value)).digest('hex') }
function namespace(value: unknown): CoverageNamespace {
  if (!value || typeof value !== 'object') return refused('namespace缺失')
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  if (!kind || !('value' in kind)) return refused('namespace kind不是data字段')
  if (kind.value === 'native') { const row = record(value, ['kind']); return { kind: row.kind as 'native' } }
  if (kind.value !== 'imported-bundle') return refused('未知namespace版本/类型')
  const row = record(value, ['kind', 'mountId', 'bundleDescriptorHash'])
  return { kind: 'imported-bundle', mountId: uuid(row.mountId), bundleDescriptorHash: digest(row.bundleDescriptorHash) }
}
export function validateCoverageCapsuleReference(value: unknown): CoverageCapsuleReference {
  const row = record(value, ['kind', 'version', 'namespace', 'operationId', 'capsuleId', 'manifestHash', 'readerVersion'])
  if (row.kind !== 'restore-knowledge-origin-capsule-ref' || row.version !== 1
    || row.readerVersion !== 'knowbook-durable-sql-v1' && row.readerVersion !== 'knowbook-durable-sql-coverage-v2') return refused('未知capsule引用格式')
  return frozen({ kind: row.kind, version: 1 as const, namespace: namespace(row.namespace), operationId: uuid(row.operationId),
    capsuleId: uuid(row.capsuleId), manifestHash: digest(row.manifestHash), readerVersion: row.readerVersion })
}
export function validateCoverageRootReference(value: unknown): CoverageRootReference {
  const row = record(value, ['kind', 'version', 'namespace', 'operationId', 'dagId', 'rootHash', 'readerVersion'])
  if (row.kind !== 'restore-knowledge-origin-root-ref' || row.version !== 1 || row.readerVersion !== 'knowbook-required-sql-knowledge-dag-v2')
    return refused('未知required-root引用；prepared DAG v1不能升级接受')
  return frozen({ kind: row.kind, version: 1 as const, namespace: namespace(row.namespace), operationId: uuid(row.operationId),
    dagId: uuid(row.dagId), rootHash: digest(row.rootHash), readerVersion: row.readerVersion })
}
function rootLocator(root: CoverageRootReference): string { return canonical([root.namespace, root.operationId, root.dagId]) }
function capsuleLocator(capsule: CoverageCapsuleReference): string { return canonical([capsule.namespace, capsule.operationId, capsule.capsuleId]) }
function roots(value: unknown): readonly CoverageRootReference[] {
  const result = list(value, COVERAGE_MAX_REQUIRED_ROOTS).map(validateCoverageRootReference)
  for (let index = 1; index < result.length; index++) if (rootLocator(result[index - 1]) >= rootLocator(result[index])) return refused('roots未按准确namespace+locator排序或重复矛盾')
  return frozen(result)
}
function target(value: unknown): CoverageTarget {
  const row = record(value, ['workspaceScope', 'recoveryEpoch', 'documentBoundary'])
  return { workspaceScope: uuid(row.workspaceScope), recoveryEpoch: uuid(row.recoveryEpoch), documentBoundary: time(row.documentBoundary) }
}
function cut(value: unknown): CoverageCutReference {
  if (!value || typeof value !== 'object') return refused('cut缺失')
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  if (!descriptor || !('value' in descriptor)) return refused('cut含getter')
  const ordinary = descriptor.value === 'ordinary-empty-epoch-cut'
  if (!ordinary && descriptor.value !== 'synced-recovery-epoch-cut') return refused('未知cut格式')
  const common = ['kind', 'version', 'operationId', 'beforeEpoch', 'afterEpoch', 'documentBoundary', 'acceptedAt']
  const row = record(value, ordinary ? [...common, 'beforeWorkspaceScope', 'afterWorkspaceScope'] : [...common, 'workspaceScope', 'boundaryHash', 'epochRequestHash'])
  if (row.version !== 1) return refused('未知cut版本')
  const base = { version: 1 as const, operationId: uuid(row.operationId), beforeEpoch: uuid(row.beforeEpoch), afterEpoch: uuid(row.afterEpoch), documentBoundary: time(row.documentBoundary), acceptedAt: time(row.acceptedAt) }
  if (base.beforeEpoch === base.afterEpoch) return refused('epoch未推进')
  return ordinary ? { kind: 'ordinary-empty-epoch-cut', ...base, beforeWorkspaceScope: uuid(row.beforeWorkspaceScope), afterWorkspaceScope: uuid(row.afterWorkspaceScope) }
    : { kind: 'synced-recovery-epoch-cut', ...base, workspaceScope: uuid(row.workspaceScope), boundaryHash: digest(row.boundaryHash), epochRequestHash: digest(row.epochRequestHash) }
}
function cutScope(value: CoverageCutReference): string { return value.kind === 'ordinary-empty-epoch-cut' ? value.afterWorkspaceScope : value.workspaceScope }
function sqlReference(value: unknown, table: CoverageSqlRowReference['table'], key: string): CoverageSqlRowReference {
  const row = record(value, ['table', 'key', 'rowHash']), keys = list(row.key, 1)
  if (row.table !== table || keys.length !== 1 || keys[0] !== key) return refused('mandatory原SQL locator不闭合')
  return { table, key: [key], rowHash: digest(row.rowHash) }
}
export function validateRawPriorCoverageRequirements(value: unknown): RawPriorCoverageRequirements {
  const row = record(value, ['kind', 'version', 'schemaVersion', 'entries'])
  if (row.kind !== 'restore-knowledge-unresolved-required-roots' || row.version !== 1 || row.schemaVersion !== 26 && row.schemaVersion !== 27) return refused('未知raw requirements版本')
  let bytes = 0
  const entries = list(row.entries, COVERAGE_MAX_REQUIREMENT_ROWS).map(raw => {
    const item = record(raw, ['operationId', 'coverageHash', 'receiptHash', 'root', 'cut', 'acceptedAt', 'supports']), id = uuid(item.operationId)
    const support = record(item.supports, ['coverage', 'link', 'receipt', 'anchor', 'boundary', 'epoch']), boundary = cut(item.cut)
    const acceptedAt = time(item.acceptedAt)
    if (boundary.operationId !== id || boundary.acceptedAt !== acceptedAt) return refused('历史cut/coverage时点不闭合')
    const hasHistory = boundary.kind === 'synced-recovery-epoch-cut'
    if (!hasHistory && (support.boundary !== null || support.epoch !== null) || hasHistory && (support.boundary === null || support.epoch === null)) return refused('B/R支持不闭合；缺B不能推empty')
    const entry: RawCoverageRequirement = { operationId: id, coverageHash: digest(item.coverageHash), receiptHash: digest(item.receiptHash), root: validateCoverageRootReference(item.root), cut: boundary, acceptedAt,
      supports: { coverage: sqlReference(support.coverage, 'app_settings', COVERAGE_SETTING_PREFIX + id), link: sqlReference(support.link, 'synced_operations', COVERAGE_OPERATION_PREFIX + id),
        receipt: sqlReference(support.receipt, 'app_settings', COVERAGE_RECEIPT_PREFIX + id), anchor: sqlReference(support.anchor, 'synced_exposure_attempts', COVERAGE_OPERATION_PREFIX + id),
        boundary: hasHistory ? sqlReference(support.boundary, 'app_settings', 'synced.recovery.history.v1.' + id) : null,
        epoch: hasHistory ? sqlReference(support.epoch, 'synced_operations', 'synced:recovery-epoch:v1:' + id) : null } }
    if (entry.root.namespace.kind !== 'native' || entry.root.operationId !== id) return refused('原C root不是其所属解释域内本次native root')
    bytes += Buffer.byteLength(canonical(entry)); if (bytes > COVERAGE_MAX_REQUIREMENTS_BYTES) return refused('raw requirements完整原记录超预算')
    return entry
  })
  if (row.schemaVersion === 26 && entries.length) return refused('schema26不能声明27 coverage')
  const seenRoots = new Map<string, string>()
  for (let index = 0; index < entries.length; index++) {
    if (index && entries[index - 1].operationId >= entries[index].operationId) return refused('原coverage记录未按operation排序或重复')
    const root = entries[index].root, key = rootLocator(root), previous = seenRoots.get(key)
    if (previous && previous !== root.rootHash) return refused('同一原root locator出现不同hash')
    seenRoots.set(key, root.rootHash)
  }
  return budget({ kind: row.kind, version: 1 as const, schemaVersion: row.schemaVersion, entries }, COVERAGE_MAX_REQUIREMENTS_BYTES)
}
function inputBinding(value: unknown): CoverageInputBinding {
  const row = record(value, ['capsule', 'interpretationHash', 'rawRequirementsHash', 'requiredRoots'])
  return { capsule: validateCoverageCapsuleReference(row.capsule), interpretationHash: digest(row.interpretationHash), rawRequirementsHash: digest(row.rawRequirementsHash), requiredRoots: roots(row.requiredRoots) }
}
export function validateSyncedKnowledgeCoverageV1(value: unknown): SyncedKnowledgeCoverageV1 {
  const row = record(value, ['kind', 'version', 'readerVersion', 'material', 'operationId', 'stageBase', 'source', 'current', 'root', 'rootMaterialHash', 'planHash', 'target', 'cut', 'acceptedAt'])
  if (row.kind !== 'synced-restore-knowledge-coverage' || row.version !== 1 || row.readerVersion !== 'knowbook-accepted-coverage-structure-v1'
    || row.material !== 'durable-sql-only' || row.stageBase !== 'current') return refused('未知C1格式/非current stagebase')
  const operationId = uuid(row.operationId), source = inputBinding(row.source), current = inputBinding(row.current), root = validateCoverageRootReference(row.root)
  const destination = target(row.target), boundary = cut(row.cut), acceptedAt = time(row.acceptedAt)
  if (capsuleLocator(source.capsule) === capsuleLocator(current.capsule)) return refused('source/current需独立真实原件')
  if (root.namespace.kind !== 'native' || root.operationId !== operationId) return refused('新C根须为本次native producer原件；仍需外owner认证')
  if (boundary.operationId !== operationId || boundary.acceptedAt !== acceptedAt || boundary.afterEpoch !== destination.recoveryEpoch
    || cutScope(boundary) !== destination.workspaceScope || boundary.documentBoundary !== destination.documentBoundary) return refused('固定cut/target分配不闭合')
  const seen = new Map<string, string>()
  for (const parent of [...source.requiredRoots, ...current.requiredRoots]) {
    const locator = rootLocator(parent), old = seen.get(locator)
    if (locator === rootLocator(root) || old && old !== parent.rootHash) return refused('required-root自环/同locator异hash')
    seen.set(locator, parent.rootHash)
  }
  return budget({ kind: row.kind, version: 1 as const, readerVersion: row.readerVersion, material: row.material, operationId,
    stageBase: 'current' as const, source, current, root, rootMaterialHash: digest(row.rootMaterialHash), planHash: digest(row.planHash), target: destination, cut: boundary, acceptedAt })
}
export function validateSyncedKnowledgeCoverageLinkV1(value: unknown): SyncedKnowledgeCoverageLinkV1 {
  const row = record(value, ['kind', 'version', 'operationId', 'coverageHash', 'root', 'rootMaterialHash', 'planHash', 'cutHash', 'target', 'acceptedAt'])
  if (row.kind !== 'synced-restore-knowledge-coverage-link' || row.version !== 1) return refused('未知coverage link格式')
  const operationId = uuid(row.operationId), root = validateCoverageRootReference(row.root)
  if (root.namespace.kind !== 'native' || root.operationId !== operationId) return refused('link不属于本次native root')
  return budget({ kind: row.kind, version: 1 as const, operationId, coverageHash: digest(row.coverageHash), root,
    rootMaterialHash: digest(row.rootMaterialHash), planHash: digest(row.planHash), cutHash: digest(row.cutHash), target: target(row.target), acceptedAt: time(row.acceptedAt) })
}
export function validateKnowledgeRestoreReceiptV2(value: unknown): KnowledgeRestoreReceiptV2 {
  const row = record(value, ['kind', 'version', 'material', 'operationId', 'stageBase', 'source', 'current', 'coverageHash', 'root', 'rootMaterialHash', 'planHash', 'cutHash', 'target', 'acceptedAt'])
  if (row.kind !== 'controlled-database-restore-receipt' || row.version !== 2 || row.material !== 'durable-sql-only' || row.stageBase !== 'current') return refused('未知Receipt2格式/非current stagebase')
  const operationId = uuid(row.operationId), source = validateCoverageCapsuleReference(row.source), current = validateCoverageCapsuleReference(row.current), root = validateCoverageRootReference(row.root)
  if (capsuleLocator(source) === capsuleLocator(current) || root.namespace.kind !== 'native' || root.operationId !== operationId) return refused('Receipt2原件角色/新root不闭合')
  return budget({ kind: row.kind, version: 2 as const, material: row.material, operationId, stageBase: 'current' as const, source, current,
    coverageHash: digest(row.coverageHash), root, rootMaterialHash: digest(row.rootMaterialHash), planHash: digest(row.planHash), cutHash: digest(row.cutHash), target: target(row.target), acceptedAt: time(row.acceptedAt) })
}
export const coverageSettingKey = (id: string): string => COVERAGE_SETTING_PREFIX + uuid(id)
export const coverageOperationId = (id: string): string => COVERAGE_OPERATION_PREFIX + uuid(id)
export const coverageReceiptKey = (id: string): string => COVERAGE_RECEIPT_PREFIX + uuid(id)
export const rawPriorCoverageRequirementsHash = (value: RawPriorCoverageRequirements): string => domainHash('knowbook.restore-knowledge.required-sql.v1', validateRawPriorCoverageRequirements(value))
export const syncedKnowledgeCoverageHash = (value: SyncedKnowledgeCoverageV1): string => domainHash('knowbook.restore-knowledge.coverage.v1', validateSyncedKnowledgeCoverageV1(value))
export const syncedKnowledgeCoverageCutHash = (value: CoverageCutReference): string => domainHash('knowbook.restore-knowledge.cut.v1', cut(value))
export const syncedKnowledgeCoverageLinkHash = (value: SyncedKnowledgeCoverageLinkV1): string => domainHash('knowbook.restore-knowledge.link.v1', validateSyncedKnowledgeCoverageLinkV1(value))
export const knowledgeRestoreReceiptHash = (value: KnowledgeRestoreReceiptV2): string => domainHash('knowbook.restore-knowledge.receipt.v2', validateKnowledgeRestoreReceiptV2(value))

/** Pure SQL expected bytes/fields only; not evidence that a row was persisted. */
export function coverageAnchorExpectation(value: SyncedKnowledgeCoverageLinkV1) {
  const link = validateSyncedKnowledgeCoverageLinkV1(value)
  return frozen({ id: coverageOperationId(link.operationId), request_hash: syncedKnowledgeCoverageLinkHash(link),
    channel: COVERAGE_ANCHOR_CHANNEL, target_fingerprint: domainHash('knowbook.restore-knowledge.target.v1', link.target),
    publication_hash: link.coverageHash, state: 'possible' as const, created_at: link.acceptedAt, confirmed_at: null })
}
/** Exact structure and backward hash links only. Every input can be caller-made;
 * no opaque accepted handle/context/installation/publication permit is returned. */
export function validateCoverageStructureTuple(value: unknown) {
  const row = record(value, ['coverage', 'link', 'receipt']), coverage = validateSyncedKnowledgeCoverageV1(row.coverage)
  const link = validateSyncedKnowledgeCoverageLinkV1(row.link), receipt = validateKnowledgeRestoreReceiptV2(row.receipt)
  const coverageHash = syncedKnowledgeCoverageHash(coverage), cutHash = syncedKnowledgeCoverageCutHash(coverage.cut)
  for (const item of [link, receipt]) if (item.operationId !== coverage.operationId || item.coverageHash !== coverageHash
    || canonical(item.root) !== canonical(coverage.root) || item.rootMaterialHash !== coverage.rootMaterialHash || item.planHash !== coverage.planHash
    || item.cutHash !== cutHash || canonical(item.target) !== canonical(coverage.target) || item.acceptedAt !== coverage.acceptedAt) return refused('C/link/Receipt2原像互证失败')
  if (canonical(receipt.source) !== canonical(coverage.source.capsule) || canonical(receipt.current) !== canonical(coverage.current.capsule)) return refused('Receipt2两侧原件不属于C')
  return frozen({ kind: 'coverage-structure-only' as const, version: 1 as const, coverage, link, receipt })
}
export const serializeSyncedKnowledgeCoverage = (value: SyncedKnowledgeCoverageV1): string => canonical(validateSyncedKnowledgeCoverageV1(value))
export const serializeSyncedKnowledgeCoverageLink = (value: SyncedKnowledgeCoverageLinkV1): string => canonical(validateSyncedKnowledgeCoverageLinkV1(value))
export const serializeKnowledgeRestoreReceipt = (value: KnowledgeRestoreReceiptV2): string => canonical(validateKnowledgeRestoreReceiptV2(value))
export const serializeRawPriorCoverageRequirements = (value: RawPriorCoverageRequirements): string => canonical(validateRawPriorCoverageRequirements(value))
function parsed(source: string, max: number): unknown { return parseStrictJson(source, { maxBytes: max, maxDepth: 16 }) }
export function parseSyncedKnowledgeCoverage(source: string): SyncedKnowledgeCoverageV1 {
  const value = validateSyncedKnowledgeCoverageV1(parsed(source, COVERAGE_MAX_JSON_BYTES))
  if (canonical(value) !== source) return refused('C1不是准确canonical JSON')
  return value
}
export function parseSyncedKnowledgeCoverageLink(source: string): SyncedKnowledgeCoverageLinkV1 {
  const value = validateSyncedKnowledgeCoverageLinkV1(parsed(source, COVERAGE_MAX_JSON_BYTES))
  if (canonical(value) !== source) return refused('link不是准确canonical JSON')
  return value
}
export function parseKnowledgeRestoreReceipt(source: string): KnowledgeRestoreReceiptV2 {
  const value = validateKnowledgeRestoreReceiptV2(parsed(source, COVERAGE_MAX_JSON_BYTES))
  if (canonical(value) !== source) return refused('Receipt2不是准确canonical JSON')
  return value
}
export function parseRawPriorCoverageRequirements(source: string): RawPriorCoverageRequirements {
  const value = validateRawPriorCoverageRequirements(parsed(source, COVERAGE_MAX_REQUIREMENTS_BYTES))
  if (canonical(value) !== source) return refused('raw requirements不是准确canonical JSON')
  return value
}
