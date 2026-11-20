import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { capsuleJson } from './restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { withStoredMerge3NavigationFinalIndex3, type Navigation3FinalIndex, type StoredNavigation3Index } from './restore-knowledge-navigation3-merge-context'
import { createNavigation3RangeProjection, type Navigation3TextEdit } from './restore-knowledge-navigation3-rewrite-cells'
import { toReference3GraphInputs, type Reference3Allocation } from './restore-knowledge-reference3-model'
import { readRootRestoreStageInputs5, type RootRestoreReferencePlan3, type RootRestoreStageInputs5 } from './restore-knowledge-reference3-read'
import type { reopenRootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import type { Navigation3TableSource } from './restore-knowledge-navigation3-tables'
import type { MarkdownDestination } from '../../shared/markdownLinks'
import { withStoredRestoreScopes } from './restore-knowledge-stored-scopes'
import { iterateRawActiveSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { canonicalSearchOccurrencesSql, occurrenceFromCanonicalSearchRow,
  type CanonicalSearchOccurrenceRow } from './workspace-search-occurrences'

type Physical = Awaited<ReturnType<typeof reopenRootRestorePhysicalStage3>>
type AliasNavigationEdit = Navigation3TextEdit & { uri: string; kind: MarkdownDestination['kind']; syntax?: MarkdownDestination['syntax']; destination?: string }
export interface Stage4AliasNavigationInput {
  data: Graph3Inputs; allocation: Reference3Allocation
  physical: Pick<Physical['value'], 'tables' | 'finalSyntaxIndexHash'>
  tables: readonly Navigation3TableSource[]
  navigationEdits: readonly { table: 'blocks' | 'documents'; targetRowId: string; column: 'content' | 'summary'; edits: readonly AliasNavigationEdit[] }[]
}
type FinalScope = Navigation3FinalIndex['scopes'][number]
export type DerivedRoutePlan4 = Awaited<ReturnType<typeof deriveStage4Routes>>
const fail = (message: string): never => { throw new Error('恢复派生路由与搜索：' + message) }
const routeKey = (path: string, blockId: string) => capsuleJson([path, blockId])
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)

/** Use the qualified original row/birth mapping already proved by Reference3.
 * A current path, a coincident slug or a bare block ID cannot mint a route. */
export async function deriveStage4Routes(reference: RootRestoreReferencePlan3, physical: Physical, scope: RootRestoreStageInputs5) {
  const { actual: original } = await readRootRestoreStageInputs5(reference, scope)
  if (original.candidate.checkedCanonicalCandidateHash !== physical.value.checkedCanonicalCandidateHash)
    return fail('路由原件属于另一候选')
  return withStoredMerge3NavigationFinalIndex3(toReference3GraphInputs(original.data, original.allocation), physical.value.tables, index => {
    if (index.indexHash !== physical.value.finalSyntaxIndexHash) return fail('重建的原导航索引与物理暂存不同')
    return routesFromIndex(index, original.data.inputs.current.source.sourceContent)
  })
}

function routesFromIndex(index: Pick<StoredNavigation3Index, 'physicalLocations' | 'routes'>, current: Graph3Inputs['inputs']['current']['source']['sourceContent']) {
  const blocks = new Map(index.physicalLocations.map(block => [block.id, block]))
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
  const currentRoutes = current.tables.find(table => table.name === 'document_block_routes') ?? fail('缺原 current 路由表')
  const pathIndex = currentRoutes.columns.indexOf('document_path'), blockIndex = currentRoutes.columns.indexOf('block_id')
  if (pathIndex < 0 || blockIndex < 0) return fail('缺原 current 路由字段')
  for (const row of currentRoutes.rows) {
    const pathCell = row.cells[pathIndex], blockCell = row.cells[blockIndex]
    if (pathCell[0] !== 'text' || blockCell[0] !== 'text') return fail('原 current 路由不是准确 TEXT')
    const path = graph3Text(pathCell, current.encoding), blockId = graph3Text(blockCell, current.encoding)
    const key = routeKey(path, blockId)
    routes.set(key, { ...routes.get(key), path, blockId, currentRowId: row.sourceRowId })
  }
  const witnessHash = hashBoundedCapsuleJson([index.routes, currentRoutes.rows], Number.MAX_SAFE_INTEGER,
    'knowbook.restore.derived-stage4.route-witness.v1\0') ?? fail('原路由见证大小超出准确整数')
  return { routes, witnessHash }
}

/** The readback rows, not a computed post-edit DTO, drive the new index.
 * Prove that exact address edits preserve other scoped navigation. */
export function deriveStage4AliasNavigation(source: Stage4AliasNavigationInput) {
  const graph = toReference3GraphInputs(source.data, source.allocation)
  const key = (cell: Pick<FinalScope['blocks'][number]['cell'], 'table' | 'targetRowId' | 'column'>) =>
    capsuleJson([cell.table, cell.targetRowId, cell.column])
  const destinationKey = (from: number, to: number, raw: string) => capsuleJson([from, to, raw])
  const edited = new Map(source.navigationEdits.map(cell => {
    const project = createNavigation3RangeProjection(cell.edits)
    const html = new Map(cell.edits.flatMap(edit => {
      if (edit.syntax !== 'html' || !edit.uri.startsWith('knowbook-asset://')) return []
      const range = project(edit.from, edit.to) ?? fail('HTML 附件地址超出原范围')
      return [[destinationKey(range.from, range.to, edit.after), edit] as const]
    }))
    return [key(cell), { edits: new Map(cell.edits.map(edit => [destinationKey(edit.from, edit.to, edit.before), edit])), project, html }]
  }))
  const scope = (value: FinalScope, project: boolean) => {
    const cells = new Map(value.blocks.map(block => [block.occurrenceKey, block.cell]))
    function range<T extends { blockId: string; from: number; to: number }>(value: T) {
      const cell = cells.get(value.blockId) ?? fail('导航范围缺实际 SQL 单元格')
      const change = project ? edited.get(key(cell)) : undefined
      const next = change ? change.project(value.from, value.to) : { from: value.from, to: value.to }
      if (!next) return fail('地址改写穿过实际导航范围')
      return { ...value, ...next }
    }
    const destinations = value.destinations.flatMap(({ key: original, url, cell, ...facts }) => {
      const change = edited.get(key(cell)), address = destinationKey(original.from, original.to, original.raw)
      const localizedHtml = !project && facts.grammar.syntax === 'html' && change?.html.get(address)
      // Native HTML navigation starts reporting the destination after the
      // portable asset is localized. Its exact typed range was checked by the alias stage.
      if (localizedHtml && localizedHtml.kind === facts.grammar.kind && localizedHtml.destination === url) return []
      const edit = project ? change?.edits.get(address) : undefined
      const { text: _text, ...identity } = cell
      return [{ ...facts, cell: identity, url: edit?.destination ?? edit?.after ?? url, key: { ...range(original), raw: edit?.after ?? original.raw } }]
    })
    return { scopeId: value.scopeId, field: value.field, finalDocumentId: value.finalDocumentId, path: value.path, title: value.title,
      blocks: value.blocks.map(({ occurrenceKey, finalOccurrenceKey, location }) => [occurrenceKey, finalOccurrenceKey, location]),
      destinations, definitions: value.definitions.map(range),
      effectiveDefinitions: value.effectiveDefinitions.map(({ key, definition }) => ({ key, definition: range(definition) })), uses: value.uses }
  }
  const heading = ({ document, headings }: Navigation3FinalIndex['headingNamespaces'][number]) => [document.id, headings] as const
  type ComparisonRow = ReturnType<typeof heading> | Navigation3FinalIndex['routes'][number] | ReturnType<typeof scope>

  // Spool the ordered navigation comparison and close the original index
  // before decoding the rewritten physical bodies.
  return withStoredRestoreScopes((append: (id: string, row: ComparisonRow) => void) =>
    withStoredMerge3NavigationFinalIndex3(graph, source.physical.tables, before => {
      if (before.indexHash !== source.physical.finalSyntaxIndexHash) return fail('原导航索引与物理暂存不同')
      for (const [ordinal, item] of before.headingNamespaces.entries()) append(`heading:${ordinal}`, heading(item))
      for (const [ordinal, route] of before.routes.entries()) append(`route:${ordinal}`, route)
      for (const item of before.scopes()) append(`scope:${item.scopeId}`, scope(item, true))
      return { headings: before.headingNamespaces.length, routes: before.routes.length, scopes: before.scopeCount }
    }), (counts, expected) => withStoredMerge3NavigationFinalIndex3(graph, source.tables, after => {
    if (counts.headings !== after.headingNamespaces.length || counts.routes !== after.routes.length || counts.scopes !== after.scopeCount)
      return fail('地址改写改变标题或原路由')
    const rows = expected.iterateEncoded()
    const sameNext = (value: ComparisonRow) => {
      const next = rows.next()
      return !next.done && next.value === capsuleJson(value)
    }
    try {
      for (const item of after.headingNamespaces)
        if (!sameNext(heading(item))) return fail('地址改写改变标题或原路由')
      for (const route of after.routes)
        if (!sameNext(route)) return fail('地址改写改变标题或原路由')
      for (const item of after.scopes()) {
        const next = rows.next()
        if (next.done) return fail('地址改写改变实际导航范围')
        if (next.value !== capsuleJson(scope(item, false))) return fail('地址改写改变实际导航或有效定义')
      }
      if (!rows.next().done) return fail('地址改写改变实际导航或有效定义')
    } finally { rows.return?.() }
    return { routes: routesFromIndex(after, source.data.inputs.current.source.sourceContent), syntaxIndexHash: after.indexHash }
  }))
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
    ORDER BY r.document_path COLLATE BINARY,r.block_id COLLATE BINARY`).safeIntegers(true).iterate() as IterableIterator<{
      rowid: bigint; path: Buffer; block: Buffer; owner: Buffer | null; birth: Buffer | null; live: bigint | null; dormant: bigint | null
    }>
  const text = (bytes: Buffer) => graph3Text(['text', bytes.toString('base64')], encoding)
  const originalRows = createHash('sha256')
  let previousKey: string | undefined, routeCount = 0, currentCount = 0, navigableRouteCount = 0
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
    if (typeof row.rowid !== 'bigint' || previousKey === key
      || expected.currentRowId !== undefined && row.rowid.toString() !== expected.currentRowId) return fail('实际旧路由 rowid 不同')
    if (expected.currentRowId !== undefined) {
      originalRows.update(capsuleJson([key, row.rowid.toString(), navigable]) + '\n')
      currentCount++
    }
    previousKey = key
    routeCount++
    if (navigable) navigableRouteCount++
  }
  return { routeCount, currentCount, navigableRouteCount, currentHash: originalRows.digest('hex') }
}

export function completeStage4Routes(db: Database.Database, plan: DerivedRoutePlan4) {
  const original = actualRoutes(db, plan)
  let expectedCurrentCount = 0
  for (const route of plan.routes.values()) if (route.currentRowId !== undefined) expectedCurrentCount++
  if (original.routeCount !== expectedCurrentCount || original.currentCount !== expectedCurrentCount)
    return fail('原物理阶段的 current 路由闭集改变')
  if (original.routeCount === plan.routes.size) return

  // Big-endian UTF-16 keys preserve the existing JavaScript lexical order,
  // including surrogate pairs. SQLite's file-backed TEMP index owns the sort.
  db.exec('CREATE TEMP TABLE stage4_new_routes(sort_key BLOB PRIMARY KEY, path TEXT NOT NULL, block_id TEXT NOT NULL) WITHOUT ROWID')
  try {
    const enqueue = db.prepare('INSERT INTO temp.stage4_new_routes(sort_key,path,block_id) VALUES(?,?,?)')
    for (const [key, route] of plan.routes) if (route.currentRowId === undefined)
      enqueue.run(Buffer.from(key, 'utf16le').swap16(), route.path, route.blockId)
    appendStage4Routes(db)
  } finally { db.exec('DROP TABLE temp.stage4_new_routes') }

  const after = actualRoutes(db, plan)
  if (after.routeCount !== plan.routes.size || after.currentCount !== original.currentCount || after.currentHash !== original.currentHash)
    return fail('实际路由数量或原 rowid 改变')
}

function appendStage4Routes(db: Database.Database) {
  const page = db.prepare('SELECT sort_key,path,block_id FROM temp.stage4_new_routes WHERE sort_key>? ORDER BY sort_key LIMIT 256')
  const occupied = db.prepare('SELECT 1 FROM main.document_block_routes WHERE _rowid_=?')
  const insert = db.prepare('INSERT INTO main.document_block_routes(_rowid_,document_path,block_id) VALUES(?,?,?)')
  let nextRowId = 1n
  let lastKey: Buffer = Buffer.alloc(0)
  for (;;) {
    // Finish each cursor before writing to main on the same connection.
    const rows = page.all(lastKey) as Array<{ sort_key: Buffer; path: string; block_id: string }>
    if (!rows.length) return
    for (const row of rows) {
      while (occupied.get(nextRowId)) nextRowId++
      insert.run(nextRowId++, row.path, row.block_id)
    }
    lastKey = rows[rows.length - 1].sort_key
  }
}

export function observeStage4Routes(db: Database.Database, plan: DerivedRoutePlan4) {
  const { routeCount, navigableRouteCount } = actualRoutes(db, plan)
  if (routeCount !== plan.routes.size) return fail('派生 SQL 缺已认证旧路由')
  return { routeCount, navigableRouteCount, dormantRouteCount: routeCount - navigableRouteCount, routeWitnessHash: plan.witnessHash }
}

function prepareStage4CanonicalComparison(db: Database.Database, scratch: Database.Database) {
  scratch.exec(`CREATE TEMP TABLE stage4_search_groups(id TEXT PRIMARY KEY, facts TEXT NOT NULL) WITHOUT ROWID;
    CREATE TEMP TABLE stage4_search_blocks(group_id TEXT, id TEXT, content TEXT NOT NULL, facts TEXT NOT NULL,
      PRIMARY KEY(group_id,id)) WITHOUT ROWID;
    CREATE TEMP TABLE stage4_search_instances(group_id TEXT, id TEXT, facts TEXT NOT NULL,
      PRIMARY KEY(group_id,id)) WITHOUT ROWID;`)
  scratch.pragma('temp.cache_size=-2048')
  const groupRow = scratch.prepare('INSERT INTO temp.stage4_search_groups VALUES(?,?)')
  const blockRow = scratch.prepare('INSERT INTO temp.stage4_search_blocks VALUES(?,?,?,?)')
  const instanceRow = scratch.prepare('INSERT INTO temp.stage4_search_instances VALUES(?,?,?)')
  return scratch.transaction(() => {
    let expected = 0
    for (const group of iterateRawActiveSyncedGroupSnapshotsOwned(db)) {
      expected += group.blocks.length * group.instances.length
      if (!Number.isSafeInteger(expected)) return fail('搜索实例数量超出准确整数')
      groupRow.run(group.groupId, capsuleJson([group.createdAt, group.creationId, group.revision, group.topologyRevision]))
      for (const block of group.blocks) blockRow.run(group.groupId, block.id, block.content,
        capsuleJson([block.type, block.createdAt, block.tags ?? []]))
      for (const instance of group.instances) instanceRow.run(group.groupId, instance.instanceId,
        capsuleJson([instance.hostDocumentId, instance.bindingVersion, instance.parentBlockId, instance.depth]))
    }
    return expected
  })()
}

type SearchHostRow = { title: string; path: string; updated_at: string; created_at: string; instanceCreatedAt: string; sort_order: number }

function compareStage4CanonicalSearch(db: Database.Database, scratch: Database.Database, expected: number) {
  const compare = scratch.prepare(`SELECT 1 FROM temp.stage4_search_groups g JOIN temp.stage4_search_blocks b ON b.group_id=g.id
    JOIN temp.stage4_search_instances i ON i.group_id=g.id
    WHERE g.id=? AND b.id=? AND i.id=? AND g.facts=? AND b.content=? AND b.facts=? AND i.facts=?`)
  const hostQuery = db.prepare(`SELECT d.title,d.path,d.updated_at,d.created_at,h.created_at AS instanceCreatedAt,h.sort_order
    FROM main.documents d JOIN main.blocks h ON h.document_id=d.id WHERE d.id=? AND h.id=?`)
  const hash = createHash('sha256').update('knowbook.restore.derived-stage4.canonical-search.v1\0')
  let count = 0, previous = '', hostDocumentId = '', hostInstanceId = ''
  let host: SearchHostRow | undefined
  const rows = db.prepare(`SELECT * FROM (${canonicalSearchOccurrencesSql})
    ORDER BY document_id COLLATE BINARY,instance_id COLLATE BINARY,group_id COLLATE BINARY,block_id COLLATE BINARY`).iterate()
  for (const row of rows as IterableIterator<CanonicalSearchOccurrenceRow>) {
    const occurrence = occurrenceFromCanonicalSearchRow(row)
    const key = capsuleJson([row.document_id, row.instance_id, row.group_id, row.block_id])
    if (!host || row.document_id !== hostDocumentId || row.instance_id !== hostInstanceId) {
      host = hostQuery.get(row.document_id, row.instance_id) as SearchHostRow | undefined
      if (!host) return fail('真实搜索 occurrence 缺宿主')
      hostDocumentId = row.document_id
      hostInstanceId = row.instance_id
    }
    if (key === previous || !compare.get(occurrence.groupId, occurrence.canonicalBlockId, occurrence.instanceId,
      capsuleJson([row.group_created_at, row.creation_id, row.revision, row.topology_revision]), row.content,
      capsuleJson([row.block_type, row.canonical_created_at, JSON.parse(row.tags_json)]),
      capsuleJson([row.document_id, row.binding_version, row.parent_block_id, row.instance_depth]))
      || host.title !== row.document_title || host.path !== row.document_path || host.updated_at !== row.updated_at
      || host.created_at !== row.host_created_at || host.instanceCreatedAt !== row.instance_created_at || host.sort_order !== row.instance_order)
      return fail('真实 canonical 搜索 occurrence 与实际组/宿主不闭合')
    hash.update(capsuleJson([occurrence, row.document_title, row.document_path, row.content, row.tags_json, row.block_type,
      row.instance_order, row.block_order]) + '\n')
    previous = key; count++
  }
  if (count !== expected) return fail('搜索实际展开数量与精确活跃组正文乘真实实例不同')
  return { canonicalOccurrenceCount: count, canonicalSearchHash: hash.digest('hex') }
}

/** Compare the real search expansion with strict group/host rows. The private
 * comparison database keeps writable spill space away from the staged main,
 * which may be open with query_only for the cold read. */
export function observeStage4CanonicalSearch(db: Database.Database) {
  assertSyncedLifecycleCoverage(db)
  const scratch = new Database(':memory:')
  try {
    scratch.pragma('temp_store=FILE')
    if (scratch.pragma('temp_store', { simple: true }) !== 1) return fail('无法启用搜索比较临时文件')
    return compareStage4CanonicalSearch(db, scratch, prepareStage4CanonicalComparison(db, scratch))
  } finally { scratch.close() }
}
