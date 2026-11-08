import { collectStoredMarkdownAssetDestinations, parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import type { MarkdownRenderableBlock } from '../../shared/markdown'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
import { graph3Rows, graph3Text } from './restore-knowledge-graph3-data'
import type { MergedRow3 } from './restore-knowledge-merge3-storage'
import { buildMerge3NavigationFinalIndex3, type Navigation3Table } from './restore-knowledge-navigation3-merge-context'
import { applyNavigation3TextEdits, createNavigation3RangeProjection } from './restore-knowledge-navigation3-rewrite-cells'
import { toReference3GraphInputs } from './restore-knowledge-reference3-model'
import { bindRootRestoreBaseAssetBlobs5 } from './restore-knowledge-selected-native-assets5'
import type { readRootRestorePhysicalStageAssetEvidence3 } from './restore-knowledge-stage3-physical'
import { template3ContentStringRanges } from './restore-knowledge-template3-json'
import { projectWorkingAssetBodyCells5, workingAssetPosition5 } from './restore-knowledge-working-asset-cells5'
import type { readRootRestoreWorkingAssetStageAndSources5 } from './restore-knowledge-working-asset-stage5'

type Physical = Awaited<ReturnType<typeof readRootRestorePhysicalStageAssetEvidence3>>
type Assets = Awaited<ReturnType<typeof readRootRestoreWorkingAssetStageAndSources5>>
type Sources = Assets['sources']
type Destination = Sources['captured']['pair']['source']['source']['assets']['scopes'][number]['destinations'][number]
type ScopeName = 'final-sql' | 'retained-sql' | 'archived-current'
type Range = Pick<Destination, 'from' | 'to' | 'raw'>
type Column = 'content' | 'summary' | 'blocks_json'
type Address = { domain: ScopeName; scope: readonly string[]; destination: Destination; cell?: {
  sourceRef: MergedRow3['sourceRef']; targetRowId: string; column: Column; range: Range; token?: { from: number; to: number }
} }
type Proof = { kind: 'staged' | 'sealed-original'; hash: string; bytes: number; logicalName: string; occurrenceIds: readonly string[];
  file: { frame: readonly string[]; path: string } }
type Entry = Address & ({ status: 'matched'; proof: Proof } | { status: 'blocked'; reason: string })
type Remainder = { domain: 'retained-policy' | 'retained-working'; scope: readonly string[]; reason: string; observedRows?: number }
const fail = (reason: string): never => { throw new Error('最终附件审计失败：' + reason) }
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const by = <T>(items: readonly T[], key: (item: T) => string) => new Map(items.map(item => [key(item), item]))
const text = (table: Navigation3Table, row: MergedRow3, column: string) => graph3Text(row.cells[table.columns.indexOf(column)], table.encoding)
const assetKey = (cell: NonNullable<Address['cell']>) => capsuleJson([cell.sourceRef, cell.targetRowId, cell.column,
  cell.range.from, cell.range.to, cell.range.raw, cell.token ? [cell.token.from, cell.token.to] : null])
const originalAssetKey = (range: { from: number; to: number }, destination: Destination) =>
  capsuleJson([range.from, range.to, destination.uri, destination.raw, destination.kind, destination.syntax])
const retainedTableHash = (table: Capsule2RawSqlTable) => hash('knowbook.restore.stage3.exact-table.v1', { ...table,
  rows: [...table.rows].sort((left, right) => BigInt(left.sourceRowId) < BigInt(right.sourceRowId) ? -1 : 1) })

function summaryAssets(value: string): Destination[] {
  return collectStoredMarkdownAssetDestinations(value).map(item => ({ section: 'summary', uri: item.url,
    from: item.start, to: item.end, raw: value.slice(item.start, item.end), kind: item.kind, syntax: item.syntax ?? 'markdown' }))
}

function originalDocuments(sources: Sources) {
  type Candidate = { item: Destination; range: Range }
  const { captured } = sources, editGroups = new Map<string, (typeof captured.cells.ordinaryEdits)[number][]>()
  for (const edit of captured.cells.ordinaryEdits) {
    const list = editGroups.get(edit.rowKey) ?? []
    list.push(edit); editGroups.set(edit.rowKey, list)
  }
  const originals = new Map((['source', 'current'] as const).map(side => {
    const packet = captured.pair[side], raw = packet.source.sourceContent
    return [side, { packet, documents: by(graph3Rows(raw, 'documents'), row => row.original.sourceRowId),
      blocks: by(graph3Rows(raw, 'blocks'), row => row.original.sourceRowId), physical: by(packet.source.physical.documents, row => row.documentId),
      scopes: by(packet.source.assets.scopes, row => capsuleJson(row.source)), bind: bindRootRestoreBaseAssetBlobs5(sources, side),
      bodies: new Map<string, Map<string, Candidate[]>>(), cells: new Map<string, Map<string, Destination | null>>() }] as const
  }))
  return (header: MergedRow3, row: MergedRow3, column: 'summary' | 'content', range: Range,
    final: Destination, finalText: string): Proof | undefined => {
    const side = row.sourceRef.side, data = originals.get(side)!
    if (!data.bind || header.sourceRef.side !== side || header.sourceRef.materialHash !== data.packet.materialHash
      || row.sourceRef.materialHash !== data.packet.materialHash) return
    const originalDocument = data.documents.get(header.sourceRef.sourceRowId), documentId = originalDocument?.value.id
    if (typeof documentId !== 'string') return
    const scope = data.scopes.get(capsuleJson(['documents', documentId])), document = data.physical.get(documentId)
    if (!scope || !document) return
    let matches = data.cells.get(row.key)
    if (!matches) {
      matches = new Map(); data.cells.set(row.key, matches)
      const edits = editGroups.get(row.key) ?? []
      if (edits.some(edit => edit.column !== column || !same(edit.sourceRef, row.sourceRef))) return fail('普通正文改写来源不同')
      const original = column === 'summary' ? originalDocument : data.blocks.get(row.sourceRef.sourceRowId)
      const before = original?.value[column]
      if (typeof before !== 'string' || column === 'content' && original?.value.document_id !== documentId
        || applyNavigation3TextEdits(before, edits) !== finalText) return
      let candidates: Candidate[]
      if (column === 'summary') candidates = scope.destinations.filter(item => item.section === 'summary').map(item => ({ item, range: item }))
      else {
        let body = data.bodies.get(documentId)
        if (!body) {
          const projection = projectWorkingAssetBodyCells5(document.blocks, 'base')
          if (projection.baseProjectionHash !== scope.bodyProjectionHash) return fail('普通原正文范围不同于封存 scope')
          body = new Map(); data.bodies.set(documentId, body)
          for (const item of scope.destinations) if (item.section === 'body') {
            const cell = projection.byBodyPosition.get(workingAssetPosition5(item))
            if (!cell || cell.raw !== item.raw) continue
            const group = body.get(cell.blockId) ?? []
            group.push({ item, range: cell }); body.set(cell.blockId, group)
          }
        }
        candidates = body.get(String(original?.value.id)) ?? []
      }
      const move = createNavigation3RangeProjection(edits)
      for (const old of candidates) {
        if (before.slice(old.range.from, old.range.to) !== old.range.raw) continue
        const projected = move(old.range.from, old.range.to)
        if (!projected) continue
        const key = originalAssetKey(projected, old.item)
        matches.set(key, matches.has(key) ? null : old.item)
      }
    }
    const match = matches.get(originalAssetKey(range, final))
    if (!match) return
    const proof = data.bind(scope, match)
    if (proof) return { kind: 'sealed-original', hash: proof.file.sha256, bytes: proof.file.bytes, logicalName: proof.logicalName,
      occurrenceIds: [proof.id], file: { frame: proof.file.frame, path: proof.file.path } }
  }
}

/** All inputs come from fixed, reauthenticated Main readers. This pure report
 * owns no filesystem, caller DTO, staging registry, or installation path. */
export function observeRootRestoreFinalAssetClosure5(physical: Physical, stage: Assets) {
  const { value: sql } = physical, { sources, value: staged } = stage, { captured } = sources
  const { data, allocation, candidate } = captured.actual
  const index = buildMerge3NavigationFinalIndex3(toReference3GraphInputs(data, allocation), sql.tables)
  if (sql.finalSyntaxIndexHash !== index.indexHash || sql.checkedCanonicalCandidateHash !== candidate.checkedCanonicalCandidateHash)
    return fail('最终 SQL 与同次封存候选不同')
  const rows = new Map(sql.tables.flatMap(table => table.rows.map(row => [row.key, row] as const)))
  const table = (name: string) => sql.tables.find(value => value.name === name) ?? fail('缺最终表 ' + name)
  const stagedRows = new Map<string, Array<Proof>>()
  const aliases = by(staged.aliases, value => capsuleJson([value.hash, value.logicalName]))
  const files = by(staged.files, value => value.sha256)
  const selected = staged.version === 2 ? staged.selected.map(row => ({ ...row, context: null })) : staged.selected
  for (const row of selected) {
    const alias = aliases.get(capsuleJson([row.hash, row.logicalName])), file = files.get(row.hash)
    if (!alias || !file || alias.bytes !== row.bytes || file.bytes !== row.bytes) return fail('实际附件清单缺精确文件和别名')
    const context = row.context?.kind === 'template-content' ? row.context : null
    const key = assetKey({ sourceRef: row.sourceRef, targetRowId: row.targetRowId, column: row.column,
      range: context?.asset ?? { from: row.finalFrom, to: row.finalTo, raw: row.raw },
      ...(context ? { token: { from: row.finalFrom, to: row.finalTo } } : {}) })
    const proofs = stagedRows.get(key) ?? []
    proofs.push({ kind: 'staged', hash: row.hash, bytes: row.bytes, logicalName: row.logicalName, occurrenceIds: row.occurrenceIds,
      file: { frame: file.frame, path: file.path } }); stagedRows.set(key, proofs)
  }
  const original = originalDocuments(sources), entries: Entry[] = [], remainder: Remainder[] = []
  const seen = new Set<string>(), matchedStaged = new Set<string>()
  let budget = 0
  function add(address: Address, fallback?: () => Proof | undefined) {
    const key = address.cell ? assetKey(address.cell) : capsuleJson([address.domain, address.scope, address.destination])
    if (seen.has(key)) return fail('最终附件位置重复')
    seen.add(key)
    const matches = address.cell ? stagedRows.get(key) ?? [] : []
    let proof = matches.length === 1 ? matches[0] : matches.length ? undefined : fallback?.()
    let reason = matches.length ? 'ambiguous-staged-proof' : address.domain === 'final-sql' && !address.cell
      ? 'final-body-coordinate-unmapped' : 'missing-exact-role-scope-or-alias'
    if (proof && /^knowbook-asset:/i.test(address.destination.uri)) {
      try {
        const portable = parseSyncedPortableAssetUri(address.destination.uri)
        if (portable.hash !== proof.hash || portable.name !== proof.logicalName) { proof = undefined; reason = 'portable-alias-mismatch' }
      } catch { proof = undefined; reason = 'invalid-portable-destination' }
    }
    if (proof?.kind === 'staged') matchedStaged.add(key)
    const result: Entry = proof ? { ...address, status: 'matched', proof } : { ...address, status: 'blocked', reason }
    budget += Buffer.byteLength(capsuleJson(result))
    if (budget > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('最终附件账目超过原预算')
    entries.push(result)
  }
  function finalCell(scope: string[], destination: Destination, row: MergedRow3, column: Column, range: Range,
    token?: { from: number; to: number }, fallback?: () => Proof | undefined) {
    add({ domain: 'final-sql', scope, destination, cell: { sourceRef: row.sourceRef, targetRowId: row.targetRowId, column, range, ...(token ? { token } : {}) } }, fallback)
  }
  function finalBody(scope: string[], blocks: readonly MarkdownRenderableBlock[], locate: (id: string) => MergedRow3 | undefined,
    header?: MergedRow3, tokens?: ReturnType<typeof template3ContentStringRanges>) {
    const body = projectWorkingAssetBodyCells5(blocks, 'base', true), positions = new Map(blocks.map((block, i) => [block.id, i]))
    for (const asset of body.bodyDestinations) {
      const destination: Destination = { ...asset, section: 'body' }, range = body.byBodyPosition.get(workingAssetPosition5(asset))
      const row = range && locate(range.blockId)
      if (!row || !range) { add({ domain: 'final-sql', scope, destination }); continue }
      const token = tokens?.[positions.get(range.blockId)!]
      if (tokens && (!token || positions.size !== blocks.length)) { add({ domain: 'final-sql', scope, destination }); continue }
      finalCell(scope, destination, row, tokens ? 'blocks_json' : 'content', { from: range.from, to: range.to, raw: range.raw }, token,
        header && !tokens ? () => original(header, row, 'content', range, destination, text(table('blocks'), row, 'content')) : undefined)
    }
  }
  const byDocument = new Map<string, typeof index.physicalBlocks[number][]>(), byGroup = new Map<string, typeof index.physicalBlocks[number][]>()
  const order = new Map<string, bigint>()
  for (const name of ['blocks', 'synced_group_blocks']) {
    const blockTable = table(name), column = blockTable.columns.indexOf('sort_order')
    for (const row of blockTable.rows) { const value = row.cells[column]; if (value?.[0] !== 'integer') return fail('缺实际正文排序'); order.set(row.key, BigInt(value[1])) }
  }
  for (const block of index.physicalBlocks) {
    const map = block.groupId === null ? byDocument : byGroup, id = block.groupId ?? block.documentId!
    const list = map.get(id) ?? []; list.push(block); map.set(id, list)
  }
  const ordered = (items: typeof index.physicalBlocks) => [...items].sort((left, right) => {
    const a = order.get(left.rowKey)!, b = order.get(right.rowKey)!
    return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const documents = table('documents')
  for (const row of documents.rows) {
    const id = text(documents, row, 'id'), summary = text(documents, row, 'summary'), scope = ['documents', id]
    for (const destination of summaryAssets(summary)) finalCell(scope, destination, row, 'summary', destination, undefined,
      () => original(row, row, 'summary', destination, destination, summary))
    const blocks = ordered(byDocument.get(id) ?? []), lookup = by(blocks, block => block.id)
    finalBody(scope, blocks.map(block => block.block), blockId => rows.get(lookup.get(blockId)?.rowKey ?? ''), row)
  }
  for (const [groupId, values] of byGroup) {
    const blocks = ordered(values), lookup = by(blocks, block => block.id)
    finalBody(['synced_groups', groupId], blocks.map(block => block.block), blockId => rows.get(lookup.get(blockId)?.rowKey ?? ''))
  }
  const templates = table('document_templates')
  for (const row of templates.rows) {
    const scope = ['document_templates', text(templates, row, 'id')], json = text(templates, row, 'blocks_json')
    for (const destination of summaryAssets(text(templates, row, 'summary'))) finalCell(scope, destination, row, 'summary', destination)
    finalBody(scope, JSON.parse(json) as MarkdownRenderableBlock[], () => row, undefined, template3ContentStringRanges(json))
  }
  if ([...stagedRows.keys()].some(key => !matchedStaged.has(key))) return fail('暂存资产没有唯一实际最终范围')

  const current = captured.pair.current, raw = current.source.sourceContent, protectedTables = by(sql.protectedObservations, item => item.table)
  const retained = new Set(raw.tables.filter(table => {
    const observed = table.name === 'app_settings' ? physical.retainedSettingsHash : protectedTables.get(table.name)?.rowHash
    return observed !== undefined && observed === retainedTableHash(table)
  }).map(table => table.name))
  const archivedHistory = sql.retainedCut.originalRowsSupportedByGenuineCopyAndQualifiedOriginals && !sql.retainedCut.oldGroupHistoryExecutable
    && protectedTables.get('synced_group_history')?.rows === 0
  const bind = bindRootRestoreBaseAssetBlobs5(sources, 'current')
  for (const scope of current.source.assets.scopes) {
    const name = scope.source[0]
    if (['documents', 'synced_groups', 'document_templates'].includes(name)) continue
    const archived = name === 'synced_group_history' && archivedHistory
    if (!archived && !retained.has(name)) remainder.push({ domain: 'retained-policy', scope: scope.source, reason: 'typed-holder-retention-unproved' })
    for (const destination of scope.destinations) add({ domain: archived ? 'archived-current' : 'retained-sql', scope: scope.source, destination }, () => {
      const proof = archived || retained.has(name) ? bind?.(scope, destination) : undefined
      if (proof) return { kind: 'sealed-original', hash: proof.file.sha256, bytes: proof.file.bytes, logicalName: proof.logicalName,
        occurrenceIds: [proof.id], file: { frame: proof.file.frame, path: proof.file.path } }
    })
  }
  const working = sources.value.roles.find(role => role.role === 'current')
  if (working) {
    for (const item of working.occurrences) add({ domain: 'retained-sql', scope: item.scopeSource, destination: item.destination }, () => {
      if (!retained.has(item.scopeSource[1]) || item.status !== 'sealed-blob') return
      return { kind: 'sealed-original', hash: item.file.sha256, bytes: item.file.bytes, logicalName: item.logicalName,
        occurrenceIds: [item.id], file: { frame: item.file.frame, path: item.file.path } }
    })
    for (const holder of working.unsupportedHolders) remainder.push({ domain: 'retained-working', scope: holder.source, reason: holder.reason })
  } else {
    const jobs = graph3Rows(raw, 'app_settings').filter(row => String(row.value.key).startsWith('sync.webdav.protocol5.exchange-job.v1.'))
    if (jobs.length) remainder.push({ domain: 'retained-working', scope: ['app_settings'], observedRows: jobs.length, reason: 'retained-job-scopes-not-observed-by-archive5' })
  }
  for (const table of raw.tables) if (table.rows.length && table.role === 'policy-unresolved')
    remainder.push({ domain: 'retained-policy', scope: [table.name], observedRows: table.rows.length, reason: 'remaining-policy-held-payload-asset-scopes' })
  const blocked = entries.filter(row => row.status === 'blocked').length
  const value = { kind: 'root-restore-final-asset-closure-audit' as const, version: 1 as const,
    referenceManifestHash: captured.actual.referenceManifestHash, physicalObservationHash: sql.physicalObservationHash,
    assetSelectionHash: staged.selectionHash, entries, remainder, matched: entries.length - blocked, blocked,
    knownOccurrencesComplete: blocked === 0, finalAssetClosureComplete: false as const, installPermit: false as const }
  if (Buffer.byteLength(capsuleJson(value)) > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('最终附件账目超过原预算')
  return freezeCapsuleValue({ ...value, observationHash: hash('knowbook.restore.final-asset-closure-audit.v1', value) })
}
