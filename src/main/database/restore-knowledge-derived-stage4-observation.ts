import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { capsuleBytesHash, capsuleJson } from './restore-knowledge-capsule-model'
import { graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import { buildMerge3NavigationFinalIndex3 } from './restore-knowledge-navigation3-merge-context'
import { toReference3GraphInputs } from './restore-knowledge-reference3-model'
import { readRootRestoreReferenceGraphInputs3, type RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import type { reopenRootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { canonicalSearchOccurrencesSql, occurrenceFromCanonicalSearchRow,
  type CanonicalSearchOccurrenceRow } from './workspace-search-occurrences'

type Physical = Awaited<ReturnType<typeof reopenRootRestorePhysicalStage3>>
export type DerivedRoutePlan4 = Awaited<ReturnType<typeof deriveStage4Routes>>
const fail = (message: string): never => { throw new Error('恢复派生路由与搜索：' + message) }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const routeKey = (path: string, blockId: string) => capsuleJson([path, blockId])

/** Use the qualified original row/birth mapping already proved by Reference3.
 * A current path, a coincident slug or a bare block ID cannot mint a route. */
export async function deriveStage4Routes(reference: RootRestoreReferencePlan3, physical: Physical) {
  const original = await readRootRestoreReferenceGraphInputs3(reference)
  if (original.candidate.checkedCanonicalCandidateHash !== physical.value.checkedCanonicalCandidateHash)
    return fail('路由原件属于另一候选')
  const index = buildMerge3NavigationFinalIndex3(toReference3GraphInputs(original.data, original.allocation), physical.value.tables)
  if (index.indexHash !== physical.value.finalSyntaxIndexHash) return fail('重建的原导航索引与物理暂存不同')
  const blocks = new Map(index.physicalBlocks.map(block => [block.id, block]))
  const routes = new Map<string, { path: string; blockId: string; documentId?: string; createdAt?: string; currentRowId?: string }>()
  for (const route of index.routes) {
    const block = blocks.get(route.blockId), key = routeKey(route.path, route.blockId)
    if (!block || block.documentId !== route.documentId || block.groupId !== null || !block.birth)
      return fail('原历史路径缺同一普通块出生与宿主')
    const existing = routes.get(key)
    if (existing && (existing.documentId !== route.documentId || existing.createdAt !== block.birth)) return fail('同历史路径对指向不同实际块')
    routes.set(key, { path: route.path, blockId: route.blockId, documentId: route.documentId, createdAt: block.birth })
  }
  // Stage3 already certified its complete current route table and FK graph.
  // Retain each exact current row. The actual live physical identity check
  // below is independent from the selection index used for new aliases.
  const current = original.data.inputs.current.source.sourceContent
  const currentRoutes = graph3Rows(current, 'document_block_routes')
  for (const row of currentRoutes) {
    const { document_path: path, block_id: blockId } = row.value
    if (typeof path !== 'string' || typeof blockId !== 'string') return fail('原 current 路由不是准确 TEXT')
    const key = routeKey(path, blockId)
    routes.set(key, { ...routes.get(key), path, blockId, currentRowId: row.original.sourceRowId })
  }
  return { routes, witnessHash: capsuleBytesHash('knowbook.restore.derived-stage4.route-witness.v1\0'
    + capsuleJson([index.routes, currentRoutes.map(row => row.original)])) }
}

function actualRoutes(db: Database.Database, plan: DerivedRoutePlan4) {
  const encoding = db.pragma('main.encoding', { simple: true }) as string
  const rows = db.prepare(`SELECT r._rowid_ AS rowid,CAST(r.document_path AS BLOB) AS path,CAST(r.block_id AS BLOB) AS block,
    CAST(b.document_id AS BLOB) AS owner,CAST(b.created_at AS BLOB) AS birth,
    (i.state='live' AND i.last_owner_kind='document' AND i.last_owner_id=b.document_id AND i.created_at=b.created_at) AS live,
    (i.state='retained' OR (i.state='live' AND i.last_owner_kind='group' AND EXISTS(
      SELECT 1 FROM main.synced_group_blocks c WHERE c.id=i.id AND c.group_id=i.last_owner_id AND c.created_at=i.created_at))) AS dormant
    FROM main.document_block_routes r LEFT JOIN main.blocks b ON b.id=r.block_id
    LEFT JOIN main.block_identities i ON i.id=r.block_id
    ORDER BY r.document_path COLLATE BINARY,r.block_id COLLATE BINARY`).safeIntegers(true).all() as Array<{
      rowid: bigint; path: Buffer; block: Buffer; owner: Buffer | null; birth: Buffer | null; live: bigint | null; dormant: bigint | null
    }>
  const text = (bytes: Buffer) => graph3Text(['text', bytes.toString('base64')], encoding)
  const exact = new Map<string, { rowid: string; navigable: boolean }>()
  for (const row of rows) {
    const key = routeKey(text(row.path), text(row.block)), expected = plan.routes.get(key)
    if (!expected) return fail('实际旧路由键不在原路线闭集')
    const navigable = row.owner !== null && row.birth !== null
    if (navigable) {
      if (row.live !== 1n) return fail('可导航路由缺实际 live 普通块 ledger')
      if (expected.documentId !== undefined && text(row.owner!) !== expected.documentId
        || expected.createdAt !== undefined && text(row.birth!) !== expected.createdAt) return fail('实际旧路由出生或属主不同')
    } else if (row.owner !== null || row.birth !== null || row.dormant !== 1n || expected.currentRowId === undefined
      || expected.documentId !== undefined || expected.createdAt !== undefined) {
      return fail('休眠路由缺原 current 行和实际保留或 canonical ledger')
    }
    if (typeof row.rowid !== 'bigint' || exact.has(key)
      || expected.currentRowId !== undefined && row.rowid.toString() !== expected.currentRowId) return fail('实际旧路由 rowid 不同')
    exact.set(key, { rowid: row.rowid.toString(), navigable })
  }
  return exact
}

export function completeStage4Routes(db: Database.Database, plan: DerivedRoutePlan4) {
  const original = actualRoutes(db, plan)
  if (original.size !== [...plan.routes.values()].filter(route => route.currentRowId !== undefined).length
    || [...original.keys()].some(key => plan.routes.get(key)!.currentRowId === undefined)) return fail('原物理阶段的 current 路由闭集改变')
  const insert = db.prepare('INSERT INTO main.document_block_routes(_rowid_,document_path,block_id) VALUES(?,?,?)')
  const occupied = new Set([...original.values()].map(row => row.rowid))
  let nextRowId = 1n
  for (const [key, route] of [...plan.routes].sort(([left], [right]) => compare(left, right))) {
    if (original.has(key)) continue
    while (occupied.has(nextRowId.toString())) nextRowId++
    insert.run(nextRowId++, route.path, route.blockId)
  }
  const after = actualRoutes(db, plan)
  if (after.size !== plan.routes.size || [...original].some(([key, row]) => {
    const observed = after.get(key)
    return observed?.rowid !== row.rowid || observed.navigable !== row.navigable
  }))
    return fail('实际路由数量或原 rowid 改变')
}

export function observeStage4Routes(db: Database.Database, plan: DerivedRoutePlan4) {
  const actual = actualRoutes(db, plan)
  if (actual.size !== plan.routes.size) return fail('派生 SQL 缺已认证旧路由')
  const navigableRouteCount = [...actual.values()].filter(row => row.navigable).length
  return { routeCount: actual.size, navigableRouteCount, dormantRouteCount: actual.size - navigableRouteCount, routeWitnessHash: plan.witnessHash }
}

/** Canonical search is a live query, not a persistent FTS table. Run the real
 * projection and compare its complete expansion with strict group/host rows.
 * The caller has already authenticated its stage marker; normal search keeps
 * its original runtime admission check and will still reject a staged DB. */
export function observeStage4CanonicalSearch(db: Database.Database) {
  assertSyncedLifecycleCoverage(db)
  const ids = (db.prepare("SELECT group_id FROM main.synced_group_lifecycle WHERE state='active' ORDER BY group_id").all() as Array<{ group_id: string }>).map(row => row.group_id)
  const groups = readRawSyncedGroupSnapshotsOwned(db, ids)
  const states = new Map([...groups].map(([id, group]) => [id, { group,
    blocks: new Map(group.blocks.map(block => [block.id, block])), instances: new Map(group.instances.map(instance => [instance.instanceId, instance])) }]))
  const expected = [...states.values()].reduce((count, item) => count + item.blocks.size * item.instances.size, 0)
  if (!Number.isSafeInteger(expected)) return fail('搜索实例数量超出准确整数')
  const hostQuery = db.prepare(`SELECT d.title,d.path,d.updated_at,d.created_at,h.created_at AS instanceCreatedAt,h.sort_order
    FROM main.documents d JOIN main.blocks h ON h.document_id=d.id WHERE d.id=? AND h.id=?`)
  const hosts = new Map<string, { title: string; path: string; updated_at: string; created_at: string; instanceCreatedAt: string; sort_order: number }>()
  const hash = createHash('sha256').update('knowbook.restore.derived-stage4.canonical-search.v1\0')
  let count = 0, previous = ''
  const rows = db.prepare(`SELECT * FROM (${canonicalSearchOccurrencesSql})
    ORDER BY document_id COLLATE BINARY,instance_id COLLATE BINARY,group_id COLLATE BINARY,block_id COLLATE BINARY`).iterate()
  for (const row of rows as IterableIterator<CanonicalSearchOccurrenceRow>) {
    const occurrence = occurrenceFromCanonicalSearchRow(row), state = states.get(occurrence.groupId)
    const block = state?.blocks.get(occurrence.canonicalBlockId), instance = state?.instances.get(occurrence.instanceId)
    const key = capsuleJson([row.document_id, row.instance_id, row.group_id, row.block_id])
    const hostKey = capsuleJson([row.document_id, row.instance_id])
    let host = hosts.get(hostKey)
    if (!host) {
      host = hostQuery.get(row.document_id, row.instance_id) as typeof host
      if (!host) return fail('真实搜索 occurrence 缺宿主')
      hosts.set(hostKey, host)
    }
    if (key === previous || !state || !block || !instance || block.content !== row.content || block.type !== row.block_type
      || block.createdAt !== row.canonical_created_at || capsuleJson(block.tags ?? []) !== capsuleJson(JSON.parse(row.tags_json))
      || instance.hostDocumentId !== row.document_id || instance.bindingVersion !== row.binding_version
      || instance.parentBlockId !== row.parent_block_id || instance.depth !== row.instance_depth
      || host.title !== row.document_title || host.path !== row.document_path || host.updated_at !== row.updated_at
      || host.created_at !== row.host_created_at || host.instanceCreatedAt !== row.instance_created_at || host.sort_order !== row.instance_order
      || state.group.createdAt !== row.group_created_at || state.group.creationId !== row.creation_id
      || state.group.revision !== row.revision || state.group.topologyRevision !== row.topology_revision)
      return fail('真实 canonical 搜索 occurrence 与实际组/宿主不闭合')
    hash.update(capsuleJson([occurrence, row.document_title, row.document_path, row.content, row.tags_json, row.block_type,
      row.instance_order, row.block_order]) + '\n')
    previous = key; count++
  }
  if (count !== expected) return fail('搜索实际展开数量与精确活跃组正文乘真实实例不同')
  return { canonicalOccurrenceCount: count, canonicalSearchHash: hash.digest('hex') }
}
