import { relative, sep } from 'node:path'
import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCertifiedDurableSqlCapsule, reopenCertifiedDurableSqlCapsule,
  type CertifiedDurableSqlCapsule } from './restore-knowledge-capsule-read'
import { canonicalDurableSqlDagProfileRoot, readDurableSqlDagNodeFile, writeDurableSqlDagNodeFile,
  type DurableSqlDagNodeFile } from './restore-knowledge-dag-files'
import { DURABLE_SQL_DAG_MAX_CAPSULES, DURABLE_SQL_DAG_MAX_DEPTH, DURABLE_SQL_DAG_MAX_NODES,
  DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES, DURABLE_SQL_DAG_MAX_PARENTS, DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES,
  durableSqlCapsuleLocator, durableSqlDagInvalid, durableSqlDagList, durableSqlDagLocator,
  validateDurableSqlCapsuleReference, validateDurableSqlDagNode, validateDurableSqlDagReference,
  type DurableSqlCapsuleReference, type DurableSqlDagReference } from './restore-knowledge-dag-model'

/** A closed, SQL-recertified immutable evidence graph only. It does not certify
 * a semantic K union, accepted coverage, publication or installation. */
export interface CertifiedDurableSqlDag { readonly kind: 'certified-durable-sql-dag' }
export interface ReopenCertifiedDurableSqlDagInput {
  readonly profileRoot: string; readonly operationId: string; readonly dagId: string; readonly expectedRootHash: string
}
export interface CaptureDurableSqlDagInput {
  readonly profileRoot: string; readonly operationId: string; readonly dagId: string
  readonly source: CertifiedDurableSqlCapsule; readonly current: CertifiedDurableSqlCapsule
  readonly parents: readonly CertifiedDurableSqlDag[]
}
type Node = { file: DurableSqlDagNodeFile; height: number }
type Capsule = { ref: DurableSqlCapsuleReference; capsule: CertifiedDurableSqlCapsule; originalBytes: number }
type Saved = { profileRoot: string; ref: DurableSqlDagReference; nodes: Map<string, Node>; capsules: Map<string, Capsule>;
  totalNodeBytes: number; totalOriginalBytes: number; height: number }
const certified = new WeakMap<CertifiedDurableSqlDag, Saved>()
const sameRoot = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function saved(handle: CertifiedDurableSqlDag): Saved {
  const value = certified.get(handle)
  return value ?? durableSqlDagInvalid('不是本Main认证的DAG句柄')
}

/** This path originates only from the existing private capsule registry. A
 * caller path/ref/manifest cannot stand in for a real certified handle. */
async function capsuleReference(profileRoot: string, capsule: CertifiedDurableSqlCapsule): Promise<DurableSqlCapsuleReference> {
  const seal = await readCertifiedDurableSqlCapsule(capsule)
  return capsuleSealReference(profileRoot, seal)
}
function capsuleSealReference(profileRoot: string, seal: Awaited<ReturnType<typeof readCertifiedDurableSqlCapsule>>): DurableSqlCapsuleReference {
  // Keep a finite DAG/capsule dispatch even if a later capsule service learns a
  // new SQL coverage codec. That format needs an actual required-parent reader;
  // this prepared-v1 graph must not silently certify an unclosed external K.
  if (seal.manifest.version !== 1 || seal.manifest.readerVersion !== 'knowbook-durable-sql-v1'
    || seal.manifest.material !== 'durable-sql-only') return durableSqlDagInvalid('DAG v1尚不支持该capsule依赖格式')
  const parts = relative(profileRoot, seal.manifestPath).split(sep)
  if (parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore'
    || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json') return durableSqlDagInvalid('原capsule不属于准确Main profile目录')
  return validateDurableSqlCapsuleReference({ kind: 'durable-sql-capsule-ref', version: 1,
    operationId: parts[2], capsuleId: parts[4], manifestHash: seal.manifestHash })
}
/** Private immutable-file checks only. Every started read settles (including
 * its awaited fd close) before ordered failure escapes or another batch starts. */
async function settledFreshBatch<T>(items: Iterable<T>, check: (item: T) => Promise<unknown>): Promise<void> {
  let pending: Promise<unknown>[] = []
  const complete = async (): Promise<void> => {
    const results = await Promise.allSettled(pending)
    pending = []
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  for (const item of items) {
    // Defer invocation so a synchronous throw is also a settled batch result.
    pending.push(Promise.resolve().then(() => check(item)))
    if (pending.length === 4) await complete()
  }
  if (pending.length) await complete()
}
async function assertFreshEntries(profileRoot: string, nodes: ReadonlyMap<string, Node>, capsules: ReadonlyMap<string, Capsule>): Promise<void> {
  await settledFreshBatch(nodes.values(), async ({ file }) => {
    const actual = await readDurableSqlDagNodeFile(profileRoot, file.ref)
    if (capsuleJson(actual.node) !== capsuleJson(file.node)) return durableSqlDagInvalid('已认证DAG node被替换')
  })
  await settledFreshBatch(capsules.values(), async item => {
    const actual = await capsuleReference(profileRoot, item.capsule)
    if (capsuleJson(actual) !== capsuleJson(item.ref)) return durableSqlDagInvalid('已认证原capsule身份变化')
  })
  // Artifacts are immutable and bounded. A final node pass also catches any
  // node replacement during the potentially long original inventory checks.
  await settledFreshBatch(nodes.values(), ({ file }) => readDurableSqlDagNodeFile(profileRoot, file.ref))
}
async function assertFresh(entry: Saved): Promise<void> {
  await assertFreshEntries(entry.profileRoot, entry.nodes, entry.capsules)
}
export async function reopenCertifiedDurableSqlDag(input: ReopenCertifiedDurableSqlDagInput): Promise<CertifiedDurableSqlDag> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'dagId', 'expectedRootHash'])
  const profileRoot = await canonicalDurableSqlDagProfileRoot(row.profileRoot as string)
  const root = validateDurableSqlDagReference({ kind: 'durable-sql-dag-ref', version: 1,
    operationId: row.operationId, dagId: row.dagId, rootHash: row.expectedRootHash })
  const nodes = new Map<string, Node>(), capsules = new Map<string, Capsule>(), active = new Set<string>()
  const nodeHashes = new Map<string, string>(), capsuleHashes = new Map<string, string>()
  let totalNodeBytes = 0, totalOriginalBytes = 0
  const capsule = async (ref: DurableSqlCapsuleReference): Promise<void> => {
    const key = durableSqlCapsuleLocator(ref), old = capsuleHashes.get(key)
    if (old && old !== ref.manifestHash) return durableSqlDagInvalid('同一原capsule locator出现矛盾manifest hash')
    if (capsules.has(key)) return
    if (capsules.size >= DURABLE_SQL_DAG_MAX_CAPSULES) return durableSqlDagInvalid('完整原capsule数量超预算')
    capsuleHashes.set(key, ref.manifestHash)
    // Always reopen into a new independent SQLite scratch and rerun the
    // existing strict durable SQL adapters. An index/hash inventory is not SQL.
    const handle = await reopenCertifiedDurableSqlCapsule({ profileRoot, operationId: ref.operationId,
      capsuleId: ref.capsuleId, expectedManifestHash: ref.manifestHash })
    const seal = await readCertifiedDurableSqlCapsule(handle)
    const originalBytes = seal.manifest.files.reduce((sum, file) => sum + file.bytes, 0)
    totalOriginalBytes += originalBytes
    if (!Number.isSafeInteger(totalOriginalBytes) || totalOriginalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)
      return durableSqlDagInvalid('完整原DB/WAL/SHM总字节超预算')
    const actual = await capsuleReference(profileRoot, handle)
    if (capsuleJson(actual) !== capsuleJson(ref)) return durableSqlDagInvalid('原capsule准确locator不匹配')
    capsules.set(key, { ref, capsule: handle, originalBytes })
  }
  const visit = async (ref: DurableSqlDagReference): Promise<Node> => {
    const key = durableSqlDagLocator(ref), old = nodeHashes.get(key)
    if (old && old !== ref.rootHash) return durableSqlDagInvalid('同一DAG locator出现矛盾root hash')
    if (active.has(key)) return durableSqlDagInvalid('DAG引用形成环')
    const prior = nodes.get(key)
    if (prior) return prior
    if (nodes.size + active.size >= DURABLE_SQL_DAG_MAX_NODES || active.size >= DURABLE_SQL_DAG_MAX_DEPTH)
      return durableSqlDagInvalid('完整DAG节点/深度超预算')
    nodeHashes.set(key, ref.rootHash); active.add(key)
    try {
      const file = await readDurableSqlDagNodeFile(profileRoot, ref)
      totalNodeBytes += file.bytes
      if (totalNodeBytes > DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES) return durableSqlDagInvalid('完整DAG node字节超预算')
      let height = 1
      for (const parent of file.node.parents) height = Math.max(height, (await visit(parent)).height + 1)
      // Memoized shared ancestors retain their complete height, so a second
      // longer path cannot evade the actual graph depth budget.
      if (height > DURABLE_SQL_DAG_MAX_DEPTH) return durableSqlDagInvalid('共享祖先形成的最长DAG路径超预算')
      await capsule(file.node.source); await capsule(file.node.current)
      const result = { file, height }
      nodes.set(key, result)
      return result
    } finally { active.delete(key) }
  }
  const head = await visit(root)
  const entry: Saved = { profileRoot, ref: root, nodes, capsules, totalNodeBytes, totalOriginalBytes, height: head.height }
  await assertFresh(entry)
  const handle: CertifiedDurableSqlDag = Object.freeze({ kind: 'certified-durable-sql-dag' })
  certified.set(handle, entry)
  return handle
}

/** Only already SQL-certified private handles enter this producer. No persisted
 * ref or caller map can stand in for those certificates. Current immutable bytes
 * are checked again before the resulting graph is registered below. */
async function producerCapsule(profileRoot: string, handle: CertifiedDurableSqlCapsule): Promise<Capsule> {
  const seal = await readCertifiedDurableSqlCapsule(handle), ref = capsuleSealReference(profileRoot, seal)
  return { ref, capsule: handle, originalBytes: seal.manifest.files.reduce((sum, file) => sum + file.bytes, 0) }
}
type ProducerParents = { nodes: Map<string, Node>; capsules: Map<string, Capsule> }
function producerParents(parents: readonly Saved[]): ProducerParents {
  const nodes = new Map<string, Node>(), capsules = new Map<string, Capsule>()
  for (const parent of parents) {
    for (const item of parent.nodes.values()) addProducerNode(nodes, item)
    for (const item of parent.capsules.values()) addProducerCapsule(capsules, item)
  }
  return { nodes, capsules }
}
function addProducerNode(nodes: Map<string, Node>, item: Node): void {
  const key = durableSqlDagLocator(item.file.ref), prior = nodes.get(key)
  if (prior && prior.file.ref.rootHash !== item.file.ref.rootHash) return durableSqlDagInvalid('同一DAG locator出现矛盾root hash')
  if (!prior) nodes.set(key, item)
  if (nodes.size > DURABLE_SQL_DAG_MAX_NODES) return durableSqlDagInvalid('完整DAG节点/深度超预算')
}
function addProducerCapsule(capsules: Map<string, Capsule>, item: Capsule): void {
  const key = durableSqlCapsuleLocator(item.ref), prior = capsules.get(key)
  if (prior && (prior.ref.manifestHash !== item.ref.manifestHash || prior.originalBytes !== item.originalBytes))
    return durableSqlDagInvalid('同一原capsule locator出现矛盾manifest hash')
  if (!prior) capsules.set(key, item)
  if (capsules.size > DURABLE_SQL_DAG_MAX_CAPSULES) return durableSqlDagInvalid('完整原capsule数量超预算')
}
function producerClosure(profileRoot: string, file: DurableSqlDagNodeFile, parents: ProducerParents, originals: readonly Capsule[]): Saved {
  const nodes = new Map(parents.nodes), capsules = new Map(parents.capsules)
  for (const item of originals) addProducerCapsule(capsules, item)
  addProducerNode(nodes, { file, height: 0 })
  const active = new Set<string>(), visited = new Set<string>(), usedCapsules = new Set<string>(), heights = new Map<string, number>()
  let totalNodeBytes = 0, totalOriginalBytes = 0
  const useCapsule = (ref: DurableSqlCapsuleReference): void => {
    const key = durableSqlCapsuleLocator(ref), item = capsules.get(key)
    if (!item || item.ref.manifestHash !== ref.manifestHash) return durableSqlDagInvalid('producer缺准确原capsule闭包')
    if (usedCapsules.has(key)) return
    usedCapsules.add(key); totalOriginalBytes += item.originalBytes
    if (!Number.isSafeInteger(totalOriginalBytes) || totalOriginalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)
      return durableSqlDagInvalid('完整原DB/WAL/SHM总字节超预算')
  }
  const visit = (ref: DurableSqlDagReference): number => {
    const key = durableSqlDagLocator(ref), item = nodes.get(key)
    if (!item || item.file.ref.rootHash !== ref.rootHash) return durableSqlDagInvalid('producer缺准确DAG parent闭包')
    if (active.has(key)) return durableSqlDagInvalid('DAG引用形成环')
    const prior = heights.get(key)
    if (prior !== undefined) return prior
    if (active.size >= DURABLE_SQL_DAG_MAX_DEPTH) return durableSqlDagInvalid('完整DAG节点/深度超预算')
    active.add(key)
    try {
      let height = 1
      for (const parent of item.file.node.parents) height = Math.max(height, visit(parent) + 1)
      if (height > DURABLE_SQL_DAG_MAX_DEPTH) return durableSqlDagInvalid('共享祖先形成的最长DAG路径超预算')
      useCapsule(item.file.node.source); useCapsule(item.file.node.current)
      totalNodeBytes += item.file.bytes
      if (!Number.isSafeInteger(totalNodeBytes) || totalNodeBytes > DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES)
        return durableSqlDagInvalid('完整DAG node字节超预算')
      visited.add(key); heights.set(key, height); nodes.set(key, { file: item.file, height })
      return height
    } finally { active.delete(key) }
  }
  const height = visit(file.ref)
  if (visited.size !== nodes.size || usedCapsules.size !== capsules.size) return durableSqlDagInvalid('producer含不可达或遗漏的原件闭包')
  return { profileRoot, ref: file.ref, nodes, capsules, totalNodeBytes, totalOriginalBytes, height }
}

/** Capture is fed only actual private capsule/DAG handles. Source/current may
 * have different scopes, epochs, content and knowledge. No equality shortcut
 * is involved. Persisting this prepared node does not accept source knowledge. */
export async function captureDurableSqlDag(input: CaptureDurableSqlDagInput): Promise<CertifiedDurableSqlDag> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'dagId', 'source', 'current', 'parents'])
  const profileRoot = await canonicalDurableSqlDagProfileRoot(row.profileRoot as string)
  const [sourceResult, currentResult] = await Promise.allSettled([
    producerCapsule(profileRoot, row.source as CertifiedDurableSqlCapsule),
    producerCapsule(profileRoot, row.current as CertifiedDurableSqlCapsule)
  ] as const)
  if (sourceResult.status === 'rejected') throw sourceResult.reason
  if (currentResult.status === 'rejected') throw currentResult.reason
  const source = sourceResult.value, current = currentResult.value
  const parents: DurableSqlDagReference[] = [], parentEntries: Saved[] = []
  for (const handle of durableSqlDagList(row.parents, DURABLE_SQL_DAG_MAX_PARENTS)) {
    const entry = saved(handle as CertifiedDurableSqlDag)
    if (!sameRoot(entry.profileRoot, profileRoot)) return durableSqlDagInvalid('parent不属于本Main profile；须显式原件bundle导入')
    parents.push(entry.ref); parentEntries.push(entry)
  }
  // Parents come only from the private registry. Shared nodes/originals are
  // freshly checked once here, still before any new persistent root is written.
  const parentClosure = producerParents(parentEntries)
  await assertFreshEntries(profileRoot, parentClosure.nodes, parentClosure.capsules)
  parents.sort((a, b) => durableSqlDagLocator(a) < durableSqlDagLocator(b) ? -1 : durableSqlDagLocator(a) > durableSqlDagLocator(b) ? 1 : 0)
  const node = validateDurableSqlDagNode({ kind: 'restore-durable-sql-dag-node', version: 1,
    readerVersion: 'knowbook-durable-sql-dag-v1', material: 'durable-sql-only', source: source.ref, current: current.ref, parents })
  const file = await writeDurableSqlDagNodeFile(profileRoot, row.operationId as string, row.dagId as string, node)
  // Reuse only these actual private SQL certificates, with full graph accounting
  // and current immutable-byte verification. Persisted reopen still rebuilds
  // every original through a fresh SQL scratch, without this producer path.
  const entry = producerClosure(profileRoot, file, parentClosure, [source, current])
  await assertFresh(entry)
  const handle: CertifiedDurableSqlDag = Object.freeze({ kind: 'certified-durable-sql-dag' })
  certified.set(handle, entry)
  return handle
}

export async function readCertifiedDurableSqlDag(handle: CertifiedDurableSqlDag) {
  const entry = saved(handle)
  await assertFresh(entry)
  return freezeCapsuleValue({ kind: 'durable-sql-dag-diagnostic' as const, root: entry.ref,
    material: 'durable-sql-only' as const, closure: 'all-referenced-originals-sql-recertified' as const,
    nodes: entry.nodes.size, capsules: entry.capsules.size, height: entry.height,
    nodeBytes: entry.totalNodeBytes, originalBytes: entry.totalOriginalBytes,
    semanticKnowledgeExtracted: false as const, acceptedSqlCoverage: false as const, certifiedForInstallation: false as const })
}
