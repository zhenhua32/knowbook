import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_VALUE_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Encode, graph3Rows, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import type { RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { assertMerge3JsonBudget, type FinishedMerge3Table, type MergedRow3 } from './restore-knowledge-merge3-storage'

type Table = FinishedMerge3Table['table']
export interface Merge3LayoutConflict {
  readonly code: string; readonly table: 'documents'; readonly rowKeys: readonly string[]; readonly detail: unknown
}
type Change = { rowKey: string; targetDocumentId: string; column: string; before: RawRestoreSqlCell; after: RawRestoreSqlCell; reason: string }
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('merge-layout-text', typeof value)
const nullable = (value: unknown): string | null => value === null ? null : text(value)
function values(table: Table, row: MergedRow3): Record<string, unknown> {
  return Object.fromEntries(table.columns.map((name, index) => {
    const cell = row.cells[index]
    return [name, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  }))
}

/** Layout the actual selected document forest, including untouched current
 * descendants. Original row references remain intact. Links, bindings, routes,
 * execution versions and link_count still require their later final transforms. */
export function applyMerge3DocumentLayout3(data: Graph3Inputs, tables: readonly Table[]) {
  const documents = tables.find(table => table.name === 'documents') ?? graph3Conflict('merge-layout-missing-documents', null)
  const blocks = tables.find(table => table.name === 'blocks') ?? graph3Conflict('merge-layout-missing-blocks', null)
  const rows = documents.rows.map(row => ({ row, value: values(documents, row) }))
  const byId = new Map(rows.map(item => [text(item.value.id), item]))
  if (byId.size !== rows.length) return graph3Conflict('merge-layout-duplicate-document-id', null)
  const conflicts: Merge3LayoutConflict[] = [], children = new Map<string | null, string[]>()
  const blockCounts = new Map<string, number>(), paths = new Map<string, string>(), pathSizes = new Map<string, number>()
  for (const row of blocks.rows) {
    const id = text(values(blocks, row).document_id)
    blockCounts.set(id, (blockCounts.get(id) ?? 0) + 1)
  }
  for (const [id, item] of byId) {
    const parent = nullable(item.value.parent_id), title = text(item.value.title)
    if (!title || title.trim() !== title || title === '.' || title === '..' || /[/\\\x00-\x1f]/.test(title))
      return graph3Conflict('merge-layout-original-title', id)
    if (parent !== null && !byId.has(parent)) {
      conflicts.push({ code: 'missing-document-parent', table: 'documents', rowKeys: [item.row.key], detail: { documentId: id, parentId: parent } })
      continue
    }
    const list = children.get(parent) ?? []; list.push(id); children.set(parent, list)
  }
  const queue = [...(children.get(null) ?? [])].sort(), reached = new Set<string>()
  let pathBytes = 0
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor], item = byId.get(id)!, parent = nullable(item.value.parent_id), title = text(item.value.title)
    const width = documents.encoding === 'UTF-8' ? Buffer.byteLength(title) : title.length * 2
    const bytes = (parent === null ? 0 : pathSizes.get(parent)! + (documents.encoding === 'UTF-8' ? 1 : 2)) + width
    if (!Number.isSafeInteger(bytes) || bytes > CAPSULE2_RAW_MAX_VALUE_BYTES - pathBytes)
      return graph3Conflict('merge-layout-complete-path-budget', null)
    pathBytes += bytes
    paths.set(id, parent === null ? title : paths.get(parent)! + '/' + title); pathSizes.set(id, bytes); reached.add(id)
    for (const child of (children.get(id) ?? []).sort()) queue.push(child)
  }
  if (reached.size !== rows.length) conflicts.push({ code: 'cyclic-or-unreachable-document-layout', table: 'documents',
    rowKeys: rows.filter(item => !reached.has(text(item.value.id))).map(item => item.row.key), detail: null })
  const current = new Map(graph3Rows(data.inputs.current.source.sourceContent, 'documents').map(row => [row.original.sourceRowId, row.value]))
  const changes: Change[] = [], slugs = new Map<string, MergedRow3[]>(), occupiedPaths = new Map<string, MergedRow3[]>()
  let changeBytes = 0
  const changedRows = rows.map(({ row, value }): MergedRow3 => {
    const id = text(value.id), next: Record<string, string | bigint> = {
      block_count: BigInt(blockCounts.get(id) ?? 0), child_count: BigInt(children.get(id)?.length ?? 0)
    }
    const reasons: Record<string, string> = { block_count: 'rebuild-physical-block-count', child_count: 'rebuild-physical-child-count' }
    const path = paths.get(id)
    if (path !== undefined) { next.path = path; reasons.path = 'layout-complete-document-parent-forest' }
    if (row.sourceRef.side === 'source') {
      // Match existing restore behavior: a reused target keeps its own slug;
      // a newly inserted document receives the target identity's stable slug.
      next.slug = row.replaces ? text((current.get(row.replaces.sourceRowId)
        ?? graph3Conflict('merge-layout-missing-replaced-document', id)).slug) : 'doc-' + id
      reasons.slug = row.replaces ? 'preserve-current-document-slug' : 'allocate-target-document-slug'
    }
    const cells = row.cells.map((before, index) => {
      const column = documents.columns[index]
      if (!Object.hasOwn(next, column) || next[column] === value[column]) return before
      const after: RawRestoreSqlCell = typeof next[column] === 'bigint' ? ['integer', next[column].toString()] : graph3Encode(next[column], documents.encoding)
      const change: Change = { rowKey: row.key, targetDocumentId: id, column, before, after, reason: reasons[column] }
      // Storage payloads are validated ASCII decimal/hex/base64 strings. Size
      // their JSON directly instead of first materializing a giant change DTO.
      const cellBytes = (cell: RawRestoreSqlCell) => cell[0] === 'null' ? 8 : cell[0].length + cell[1].length + 7
      const bytes = Buffer.byteLength(capsuleJson({ ...change, before: null, after: null })) - 8 + cellBytes(before) + cellBytes(after)
      if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES - changeBytes) return graph3Conflict('merge-layout-complete-change-budget', null)
      changeBytes += bytes; changes.push(change); return after
    })
    const result = { ...row, cells }, slug = typeof next.slug === 'string' ? next.slug : text(value.slug)
    const sameSlug = slugs.get(slug) ?? []; sameSlug.push(result); slugs.set(slug, sameSlug)
    if (path !== undefined) { const samePath = occupiedPaths.get(path) ?? []; samePath.push(result); occupiedPaths.set(path, samePath) }
    return result
  })
  for (const [slug, items] of slugs) if (items.length > 1)
    conflicts.push({ code: 'duplicate-document-slug', table: 'documents', rowKeys: items.map(row => row.key), detail: { slug } })
  for (const [path, items] of occupiedPaths) if (items.length > 1)
    conflicts.push({ code: 'duplicate-document-path', table: 'documents', rowKeys: items.map(row => row.key), detail: { path } })
  const result = tables.map(table => table.name === 'documents' ? { ...table, rows: changedRows } : table)
  const body = { changes, conflicts, documentHierarchyLaidOut: conflicts.length === 0, navigationRewritten: false as const,
    sourceHistoryReplayed: false as const, permit: false as const }
  const hashInput = { ...body, documents: result.find(table => table.name === 'documents')! }
  assertMerge3JsonBudget(hashInput)
  const encoded = capsuleJson(hashInput)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('merge-layout-complete-json-budget', null)
  return freezeCapsuleValue({ tables: result, ...body, layoutHash: capsuleBytesHash('knowbook.restore.merge3.document-layout.v1\0' + encoded) })
}
