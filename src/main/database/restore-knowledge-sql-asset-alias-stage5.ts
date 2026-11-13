import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { localAttachmentFileUrl, managedLocalAttachmentPath } from '../attachments'
import { collectStoredMarkdownAssetDestinations } from '../../shared/syncedBlockPortable'
import { applyNavigation3TextEdits, createNavigation3RangeProjection, type Navigation3TextEdit } from './restore-knowledge-navigation3-rewrite-cells'
import { prepareRootRestoreAssetAliasWithSqlSource5, readRootRestoreAssetAliasSqlSource5, reopenRootRestoreAssetAliasWithSqlSource5,
  type RootRestoreAssetAliasStage5 } from './restore-knowledge-asset-alias-stage5'
import { readRawCapsule2ContentOwned } from './restore-knowledge-capsule2-content-raw-read'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, validateDurableSqlCapsuleInventory,
  type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Encode, graph3Text } from './restore-knowledge-graph3-data'
import { assertRootRestoreStage3FilesHeld3, assertRootRestoreStage3WritableMain3, assertRootRestoreStage3WrittenMainClosed3,
  closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3DatabaseFiles3, holdRootRestoreStage3Files3,
  verifyRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { assertRootRestoreStage3DatabaseReadonly3, copyRootRestoreStage3Database3, discardRootRestoreStage3Probe3, holdRootRestorePhysicalStageOriginalBytes3,
  prepareRootRestoreCanonicalAssetPhysicalWithAliasSource5, readRootRestorePhysicalStageCopySource3, readRootRestoreStage3DatabaseInventory3,
  readRootRestoreStage3NativeFtsProjection3, reopenRootRestoreCanonicalAssetPhysicalWithAliasSource5,
  type RootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import { readRootRestoreStage3MarkerOwned } from './restore-knowledge-stage3-marker-read'
import type { RootRestoreSqlAssetStage5 } from './restore-knowledge-sql-asset-stage5'
import type { RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import { projectTemplate3ContentStringEdits, template3ContentStringRanges } from './restore-knowledge-template3-json'
import { assertOriginCatalogDirectory, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { restoreDirectory, syncRestoreDirectory, syncRestoreFile } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'

type Source = Awaited<ReturnType<typeof readRootRestoreAssetAliasSqlSource5>>
type Sql = Source['source']['physical']
type Table = Sql['tables'][number]
type Row = Table['rows'][number]
type Edit = Navigation3TextEdit & { uri: string; kind: 'link' | 'image' }
type Column = 'content' | 'summary' | 'blocks_json'
type Token = { from: number; to: number; index: number }
type MarkdownTarget = { content: string; edits: Edit[]; token?: Token }
type TemplateBlock = { id: string; content: string }
type Target = { table: Table; row: Row; column: Column; original: string; markdown: Map<number, MarkdownTarget>;
  template?: { blocks: TemplateBlock[]; ranges: ReturnType<typeof template3ContentStringRanges> } }
type Change = Pick<Target, 'table' | 'row' | 'column'> & { rewritten: string; navigationEdits?: readonly Edit[] }
type Format = 1 | 2 | 3
type Locator = { stageId: string; expectedManifestHash: string }
type Canonical = Awaited<ReturnType<typeof reopenRootRestoreCanonicalAssetPhysicalWithAliasSource5>>['stage']
type CanonicalAddress = { reference: RootRestoreReferencePlan3; combined: RootRestoreSqlAssetStage5; alias: Locator; physical: Locator }
type CanonicalLineage = { canonicalStageId: string; canonicalStageManifestHash: string; canonicalAssetPlanHash: string }
type Base = { physical: Sql; stage: RootRestorePhysicalStage3; lineage?: CanonicalLineage }
type Saved = { aliases: RootRestoreAssetAliasStage5; locator: Locator; canonical?: CanonicalAddress }
export interface RootRestoreSqlAssetAliasStage5 { readonly kind: 'main-root-restore-non-executable-sql-asset-alias-stage5' }
const owners = new WeakMap<RootRestoreSqlAssetAliasStage5, Saved>()
const fail = (reason: string): never => { throw new Error('非执行 SQL 附件地址暂存失败：' + reason) }
const maxManifestBytes = 256 * 1024
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const key = (table: string, rowId: string, column: string) => table + ':' + rowId + ':' + column
const cellText = (table: Table, row: Row, column: string) => graph3Text(row.cells[table.columns.indexOf(column)], table.encoding)
const collection = ({ profileRoot, operationId }: Source['source']['location']) => join(profileRoot, 'backups', 'database-restore',
  operationId, 'restore-sql-asset-alias-stages-v5')
const addressOf = ({ stageId, manifestHash }: { stageId: string; manifestHash: string }): Locator => ({ stageId, expectedManifestHash: manifestHash })
const editableTables = ['blocks', 'documents', 'document_templates']

function sqlBase(input: Source, canonical?: Canonical): Base {
  const { physical, physicalStage, audit } = input.source
  if (!canonical) return { physical, stage: physicalStage }
  const { value, stage, stageId, manifestHash } = canonical, proof = value.canonicalAssets
  if (!proof || value.version !== 2 || value.installPermit !== false || proof.aliasStageId !== input.stageId
    || proof.aliasManifestHash !== input.manifestHash || proof.basePhysicalObservationHash !== physical.physicalObservationHash
    || proof.assetClosureObservationHash !== audit.observationHash
    || value.checkedCanonicalCandidateHash !== physical.checkedCanonicalCandidateHash)
    return fail('canonical SQL 不属于同一实际附件和原件坐标')
  for (const name of editableTables) {
    const before = physical.tables.find(table => table.name === name), after = value.tables.find(table => table.name === name)
    if (!before || !after || before.encoding !== after.encoding || !same(before.columns, after.columns)
      || !same(before.primaryKey, after.primaryKey) || before.rows.length !== after.rows.length)
      return fail('canonical SQL 改变了附件目标表')
    const rows = new Map(after.rows.map(row => [row.targetRowId, row]))
    // Each Stage3 producer allocates a fresh document CAS timestamp. The
    // original coordinate, identity, birth, owner and content must match.
    const cas = name === 'documents' ? before.columns.indexOf('updated_at') : -1
    for (const { cells, ...row } of before.rows) {
      const next = rows.get(row.targetRowId)
      if (!next) return fail('canonical SQL 缺附件原坐标')
      const { cells: nextCells, ...nextRow } = next
      if (!same(row, nextRow) || cells.some((cell, index) => index !== cas && !same(cell, nextCells[index])))
        return fail('canonical SQL 改变了附件原坐标、属主或原始列')
    }
  }
  return { physical: value, stage, lineage: { canonicalStageId: stageId, canonicalStageManifestHash: manifestHash,
    canonicalAssetPlanHash: proof.planHash } }
}

function rewriteMarkdown(target: MarkdownTarget) {
  const observed = collectStoredMarkdownAssetDestinations(target.content)
  const destinations = new Set(observed.filter(item => !item.syntax).map(item => capsuleJson([item.start, item.end, item.url, item.kind])))
  const edits = target.edits.filter(edit => destinations.has(capsuleJson([edit.from, edit.to, edit.uri, edit.kind])))
  if (!edits.length) return null
  const rewritten = applyNavigation3TextEdits(target.content, edits), move = createNavigation3RangeProjection(edits)
  const byStart = new Map(edits.map(edit => [edit.from, edit]))
  const expected = observed.map(item => {
    const range = move(item.start, item.end)
    if (!range) return fail('附件改写覆盖其他语法范围')
    const edit = byStart.get(item.start)
    return { ...item, start: range.from, end: range.to, url: edit?.after ?? item.url }
  })
  if (!same(collectStoredMarkdownAssetDestinations(rewritten), expected)) return fail('改写后的附件语法或范围不同')
  return { edits, rewritten }
}

/** Only inline Markdown document and template destinations with exact proof.
 * Unsupported syntax, blocked occurrences and colliding aliases stay visible. */
function plan(input: Source, format: Format, base: Base) {
  const { audit, matched, physical, location } = input.source
  const assetRoot = join(location.profileRoot, 'storage', 'assets')
  const tables = new Map(physical.tables.filter(table => editableTables.includes(table.name))
    .map(table => [table.name, { table, rows: new Map(table.rows.map(row => [row.targetRowId, row])) }]))
  const aliases = new Map(input.aliases.map(alias => [capsuleJson([alias.hash, alias.logicalName]), alias]))
  const conflicts = new Set(input.remaining.aliasPathConflicts.flat())
  const targets = new Map<string, Target>()
  for (const { entry, selection } of matched) {
    const { cell, destination, scope } = entry
    if (entry.domain !== 'final-sql' || !cell || destination.syntax !== 'markdown'
      || (destination.kind !== 'link' && destination.kind !== 'image')) continue
    const context = format !== 1 && scope[0] === 'document_templates' && entry.proof.kind === 'staged'
      ? selection?.context : null
    const template = context?.kind === 'template-content' || context?.kind === 'template-summary'
    const ordinary = scope[0] === 'documents' && entry.proof.kind === 'sealed-original'
    if (!ordinary && !template) continue
    if (/^file:/i.test(destination.uri)) {
      const from = new URL(destination.uri)
      if (from.search || from.hash) continue
    } else if (!template || !destination.uri.startsWith('knowbook-asset://')) continue
    const { hash, logicalName, bytes } = entry.proof
    const alias = aliases.get(capsuleJson([hash, logicalName]))
    if (!alias || alias.bytes !== bytes) return fail('入选 occurrence 缺原别名')
    if (conflicts.has(alias.path)) continue
    const uri = localAttachmentFileUrl(join(assetRoot, ...alias.path.split('/')))
    try { managedLocalAttachmentPath(uri, assetRoot) }
    catch { continue }
    const { column, targetRowId, range } = cell
    if (uri === destination.uri) continue
    if (ordinary ? column === 'blocks_json' || cell.token
      : context?.kind === 'template-content' ? column !== 'blocks_json' || !cell.token : column !== 'summary' || cell.token)
      return fail('附件列或模板 token 越界')
    const tableName = template ? 'document_templates' : column === 'content' ? 'blocks' : 'documents'
    const { table, rows } = tables.get(tableName) ?? fail('缺实际附件表')
    const row = rows.get(targetRowId)
    if (!row || !same(row.sourceRef, cell.sourceRef) || table.name !== cell.sourceRef.table
      || cellText(table, row, tableName === 'blocks' ? 'document_id' : 'id') !== scope[1])
      return fail('附件的原角色、落盘行或宿主不同')
    const id = key(table.name, targetRowId, column)
    let target = targets.get(id)
    if (!target) {
      target = { table, row, column, original: cellText(table, row, column), markdown: new Map() }
      targets.set(id, target)
    }
    const tokenIndex = context?.kind === 'template-content' ? context.blockIndex : -1
    let markdown = target.markdown.get(tokenIndex)
    if (context?.kind === 'template-content') {
      target.template ??= { blocks: JSON.parse(target.original) as TemplateBlock[], ranges: template3ContentStringRanges(target.original) }
      const block = target.template.blocks[tokenIndex], token = target.template.ranges[tokenIndex]
      if (!token || !block || block.id !== context.localId || !same(token, cell.token)
        || !same(range, context.asset) || JSON.parse(target.original.slice(token.from, token.to)) !== block.content)
        return fail('模板附件的有效 JSON token 或局部身份不同')
      if (!markdown) {
        markdown = { content: block.content, edits: [], token: { ...token, index: tokenIndex } }
        target.markdown.set(tokenIndex, markdown)
      }
    } else if (!markdown) {
      markdown = { content: target.original, edits: [] }
      target.markdown.set(tokenIndex, markdown)
    }
    markdown.edits.push({ from: range.from, to: range.to, before: range.raw, after: uri, uri: destination.uri, kind: destination.kind })
  }
  const changes = new Map<string, Change>()
  const digest = createHash('sha256').update(format === 1 ? 'knowbook.restore.ordinary-sql-asset-alias-edits.v1\0'
    : 'knowbook.restore.document-template-sql-asset-alias-edits.v2\0')
  let rewrittenOccurrences = 0
  for (const [id, target] of targets) {
    const { original, table, row, column } = target, rawEdits: Navigation3TextEdit[] = []
    const templateContents = new Map<number, string>()
    let rewritten = original, navigationEdits: Edit[] | undefined
    for (const markdown of target.markdown.values()) {
      const result = rewriteMarkdown(markdown)
      if (!result) continue
      const token = markdown.token
      if (token) {
        templateContents.set(token.index, result.rewritten)
        for (const edit of projectTemplate3ContentStringEdits(original.slice(token.from, token.to), markdown.content, result.edits))
          rawEdits.push({ ...edit, from: token.from + edit.from, to: token.from + edit.to })
      } else {
        rewritten = result.rewritten
        if (table.name !== 'document_templates') navigationEdits = result.edits
      }
      rewrittenOccurrences += result.edits.length
      digest.update(capsuleJson(format === 1 ? [row.sourceRef, table.name + ':' + row.targetRowId, column, result.edits]
        : [row.sourceRef, id, token ?? null, result.edits]) + '\n')
    }
    if (rawEdits.length) {
      rewritten = applyNavigation3TextEdits(original, rawEdits)
      const expected = target.template?.blocks.map((block, index) => templateContents.has(index)
        ? { ...block, content: templateContents.get(index) } : block)
      if (!expected || !same(JSON.parse(rewritten), expected)) return fail('改写改变了模板局部内容以外的结构')
    }
    if (rewritten !== original) changes.set(id, { table, row, column, rewritten, navigationEdits })
  }
  if (!changes.size) return fail('没有可按准确原范围改写的附件')
  const canonicalRewrittenOccurrences = base.physical.canonicalAssets?.rewrittenOccurrences ?? 0
  const finalSqlOccurrences = audit.entries.filter(entry => entry.domain === 'final-sql').length - rewrittenOccurrences - canonicalRewrittenOccurrences
  if (finalSqlOccurrences < 0) return fail('原 SQL 附件范围存在重复计数')
  return { changes, facts: { combinedStageId: input.source.combinedStageId, combinedManifestHash: input.source.combinedManifestHash,
    physicalObservationHash: base.physical.physicalObservationHash, assetClosureObservationHash: audit.observationHash,
    aliasStageId: input.stageId, aliasManifestHash: input.manifestHash, editsHash: digest.digest('hex'),
    rewrittenCells: changes.size, rewrittenOccurrences, ...(base.lineage ? { canonicalRewrittenOccurrences } : {}),
    remaining: { ...input.remaining, finalSqlOccurrences } } }
}
type Plan = ReturnType<typeof plan>
type PhysicalCopy = ReturnType<typeof readRootRestorePhysicalStageCopySource3>

function physicalCopy(input: Source, base: Base) {
  const source = readRootRestorePhysicalStageCopySource3(base.stage)
  if (source.root !== input.source.location.profileRoot || source.marker.stageId !== base.physical.stageId)
    return fail('实际 SQL 与附件别名不属同一物理阶段')
  return source
}

async function writeCopy(directory: string, source: PhysicalCopy, input: Plan) {
  const { root, inventory } = source
  const created = await copyRootRestoreStage3Database3(source.databaseDirectory, directory, root, inventory)
  const held = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: root, databaseDirectory: directory, inventory,
    purpose: 'writable-open', expectedCreatedIdentities: created })
  let db: Database.Database | undefined, authorized = false
  try {
    await verifyRootRestoreStage3FilesHeld3(held)
    const connection = db = new Database(restoreSqliteFilename(join(directory, 'knowbook.db')), { fileMustExist: true })
    assertRootRestoreStage3WritableMain3(held, connection)
    authorized = true
    connection.pragma('foreign_keys=ON')
    connection.transaction(() => {
      for (const { table, row, column, rewritten } of input.changes.values()) {
        const raw = (name: string) => {
          const cell = row.cells[table.columns.indexOf(name)]
          if (cell?.[0] !== 'text') return fail('实际待改写行缺原 TEXT')
          return Buffer.from(cell[1], 'base64')
        }
        const utf8 = table.encoding === 'UTF-8'
        const sql = `UPDATE main.${table.name} SET ${column}=${utf8 ? 'CAST(? AS TEXT)' : '?'} WHERE _rowid_=?
          AND typeof(${column})='text' AND CAST(${column} AS BLOB) IS ?
          AND CAST(id AS BLOB) IS ? AND CAST(created_at AS BLOB) IS ?${table.name === 'blocks' ? ' AND CAST(document_id AS BLOB) IS ?' : ''}`
        const owner = table.name === 'blocks' ? [raw('document_id')] : []
        if (connection.prepare(sql).run(utf8 ? Buffer.from(rewritten) : rewritten, BigInt(row.targetRowId),
          raw(column), raw('id'), raw('created_at'), ...owner).changes !== 1) return fail('实际行身份、出生、宿主或原 TEXT 已变化')
      }
      readRootRestoreStage3NativeFtsProjection3(connection, true)
    }).immediate()
  } finally {
    try { db?.close(); if (db && authorized) assertRootRestoreStage3WrittenMainClosed3(held, db) }
    finally { closeRootRestoreStage3FilesHeld3(held) }
  }
}

function assertSqlReadback(db: Database.Database, physical: Sql, source: PhysicalCopy, input: Plan) {
  readRootRestoreStage3MarkerOwned(db, source.marker)
  if (!same(readRootRestoreStage3NativeFtsProjection3(db, false), physical.nativeFtsProjection)) return fail('原生 FTS 的稳定映射变化')
  const raw = readRawCapsule2ContentOwned(db)
  if (raw.schemaVersion !== 27 || raw.schemaHash !== source.schemaHash) return fail('原 schema 或版本变化')
  const tables = new Map(raw.tables.map(table => [table.name, table]))
  const changedRows = new Map<string, Map<string, string>>()
  for (const { table, row, column, rewritten } of input.changes.values()) {
    const id = table.name + ':' + row.targetRowId
    const columns = changedRows.get(id) ?? new Map<string, string>()
    columns.set(column, rewritten)
    changedRows.set(id, columns)
  }
  for (const expected of physical.tables) {
    const actual = tables.get(expected.name)
    if (!actual || raw.encoding !== expected.encoding || !same(actual.columns, expected.columns)
      || !same(actual.primaryKey, expected.primaryKey) || actual.rows.length !== expected.rows.length) return fail('实际内容表身份变化')
    const rows = new Map(actual.rows.map(row => [row.sourceRowId, row.cells]))
    for (const row of expected.rows) {
      const changed = changedRows.get(expected.name + ':' + row.targetRowId)
      const cells = changed ? row.cells.map((cell, i) => {
        const value = changed.get(expected.columns[i])
        return value === undefined ? cell : graph3Encode(value, expected.encoding)
      }) : row.cells
      if (!same(rows.get(row.targetRowId) ?? null, cells)) return fail('原行或声明改写之外的 SQL 数据变化')
    }
    tables.delete(expected.name)
  }
  for (const expected of physical.protectedObservations) {
    const actual = tables.get(expected.table)
    if (!actual || expected.rows !== actual.rows.length
      || capsuleBytesHash('knowbook.restore.stage3.exact-table.v1\0' + capsuleJson(actual)) !== expected.rowHash)
      return fail('原保留 SQL 行变化：' + expected.table)
    tables.delete(expected.table)
  }
  if ([...tables.keys()].some(name => name !== 'block_search_ids' && name !== 'document_search_ids'))
    return fail('实际 SQL 回读存在未校验的表')
  if ((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n !== 0) return fail('独立只读回读出现写入')
  return raw
}

function manifest(stageId: string, format: Format, input: Plan, inventory: readonly DurableSqlCapsuleFile[], lineage?: CanonicalLineage) {
  return freezeCapsuleValue({ kind: 'root-restore-non-executable-sql-asset-alias-stage5' as const, version: format, stageId,
    scope: format === 1 ? 'ordinary-document-inline-file-destinations' as const : 'documents-and-templates-inline-asset-destinations' as const,
    ...input.facts, ...lineage, inventory,
    finalAssetClosureComplete: false as const, acceptedCoverage: false as const, effective: false as const, installPermit: false as const })
}
type Manifest = ReturnType<typeof manifest>

function holdAliasDatabase(directory: string, value: Manifest, root: string) {
  const database = join(directory, 'database')
  const text = capsuleJson(value) + '\n', inventory = value.inventory, present = inventory.filter(file => file.present)
  return holdRootRestoreStage3Files3({ profileRoot: root,
    directories: [{ path: directory, entries: ['checks', 'database', 'manifest.json'] },
      { path: database, entries: present.map(file => file.name) }],
    files: [{ path: join(directory, 'manifest.json'), bytes: Buffer.byteLength(text), sha256: capsuleBytesHash(text) },
      ...present.map(file => ({ path: join(database, file.name), bytes: file.bytes, sha256: file.sha256 ?? fail('实际原件缺 SHA') }))],
    absentFiles: inventory.filter(file => !file.present).map(file => join(database, file.name)) })
}

async function verify(directory: string, value: Manifest, input: Source, plan: Plan, source: PhysicalCopy, base: Base) {
  const { root } = source, database = join(directory, 'database'), checks = join(directory, 'checks')
  const inventory = value.inventory, held = await holdAliasDatabase(directory, value, root)
  try {
    const probe = join(checks, randomUUID())
    await copyRootRestoreStage3Database3(database, probe, root, inventory)
    const probeIdentity = await assertOriginCatalogDirectory(probe, root)
    const db = new Database(restoreSqliteFilename(join(probe, 'knowbook.db')), { readonly: true, fileMustExist: true })
    let raw: ReturnType<typeof assertSqlReadback>
    try {
      db.pragma('query_only=ON')
      db.pragma('foreign_keys=ON')
      raw = db.transaction(() => assertSqlReadback(db, base.physical, source, plan))()
    } finally { db.close() }
    await assertRootRestoreStage3DatabaseReadonly3(probe, root, inventory)
    await input.assertOriginalBytes()
    await verifyRootRestoreStage3FilesHeld3(held)
    await discardRootRestoreStage3Probe3(probe, root, probeIdentity)
    assertRootRestoreStage3FilesHeld3(held)
    return raw
  } finally { closeRootRestoreStage3FilesHeld3(held) }
}

function mint(aliases: RootRestoreAssetAliasStage5, directory: string, value: Manifest, canonical?: CanonicalAddress) {
  const stage: RootRestoreSqlAssetAliasStage5 = Object.freeze({ kind: 'main-root-restore-non-executable-sql-asset-alias-stage5' })
  const { stageId } = value, manifestHash = capsuleBytesHash(capsuleJson(value) + '\n')
  owners.set(stage, { aliases, locator: { stageId, expectedManifestHash: manifestHash }, canonical })
  return Object.freeze({ stage, directory, stageId, manifestHash, value })
}

async function prepare(aliases: RootRestoreAssetAliasStage5, input: Source, base: Base, canonical?: CanonicalAddress) {
  const format = base.lineage ? 3 : 2, edits = plan(input, format, base)
  const source = physicalCopy(input, base), { root } = source
  const parent = collection(input.source.location), stageId = randomUUID(), directory = join(parent, stageId)
  const database = join(directory, 'database')
  const held = await holdRootRestorePhysicalStageOriginalBytes3(base.stage)
  try {
    await restoreDirectory(parent, root)
    await restoreDirectory(directory, root, true)
    await restoreDirectory(join(directory, 'checks'), root, true)
    await writeCopy(database, source, edits)
    const inventory = await readRootRestoreStage3DatabaseInventory3(database, root)
    for (const file of inventory) if (file.present) await syncRestoreFile(join(database, file.name))
    await syncRestoreDirectory(database)
    const value = manifest(stageId, format, edits, inventory, base.lineage), text = capsuleJson(value) + '\n'
    if (Buffer.byteLength(text) > maxManifestBytes) return fail('阶段清单超预算')
    await writeCapsule2AssetCopy(join(directory, 'manifest.json'), Buffer.from(text), root)
    await syncOriginCatalogAncestors(directory, root)
    const raw = await verify(directory, value, input, edits, source, base)
    await verifyRootRestoreStage3FilesHeld3(held)
    assertRootRestoreStage3FilesHeld3(held)
    return { alias: mint(aliases, directory, value, canonical), readback: { input, source, base, value, directory, raw, edits } }
  } finally { closeRootRestoreStage3FilesHeld3(held) }
}

/** Materializes only the address edits on a fresh private copy. Stage3 and the
 * live database retain their exact bytes and the new copy remains non-executable. */
export async function prepareRootRestoreSqlAssetAliasStage5(aliases: RootRestoreAssetAliasStage5) {
  const input = await readRootRestoreAssetAliasSqlSource5(aliases)
  return (await prepare(aliases, input, sqlBase(input))).alias
}

async function reopen(locator: Locator, input: Source, base: Base) {
  const address = capsuleRecord(locator, ['stageId', 'expectedManifestHash'])
  const stageId = durableSqlDagUuid(address.stageId), expectedHash = durableSqlDagHash(address.expectedManifestHash)
  const source = physicalCopy(input, base)
  const directory = join(collection(input.source.location), stageId)
  const text = await readCapsule2AssetManifest(join(directory, 'manifest.json'), source.root, maxManifestBytes)
  if (capsuleBytesHash(text) !== expectedHash) return fail('持久清单哈希不同')
  const stored = JSON.parse(text), format = stored?.version
  if (base.lineage ? format !== 3 : format !== 1 && format !== 2) return fail('SQL 附件地址暂存版本与实际父阶段不同')
  const edits = plan(input, format, base), inventory = validateDurableSqlCapsuleInventory(stored.inventory)
  const value = manifest(stageId, format, edits, inventory, base.lineage)
  if (text !== capsuleJson(value) + '\n') return fail('持久清单不同于真实附件改写计划')
  const held = base.lineage ? await holdRootRestorePhysicalStageOriginalBytes3(base.stage) : undefined
  try {
    const raw = await verify(directory, value, input, edits, source, base)
    if (held) {
      await verifyRootRestoreStage3FilesHeld3(held)
      assertRootRestoreStage3FilesHeld3(held)
    }
    return { input, source, base, value, directory, raw, edits }
  } finally { if (held) closeRootRestoreStage3FilesHeld3(held) }
}

async function reconstruct({ aliases, locator, canonical }: Saved) {
  if (canonical) {
    const { input, stage } = await reopenRootRestoreCanonicalAssetPhysicalWithAliasSource5(canonical.reference, canonical.combined,
      canonical.alias, canonical.physical)
    return reopen(locator, input, sqlBase(input, stage))
  }
  const input = await readRootRestoreAssetAliasSqlSource5(aliases)
  return reopen(locator, input, sqlBase(input))
}

export async function reopenRootRestoreSqlAssetAliasStage5(aliases: RootRestoreAssetAliasStage5, locator: Locator) {
  const { directory, value } = await reconstruct({ aliases, locator })
  return mint(aliases, directory, value)
}

export async function readRootRestoreSqlAssetAliasStage5(stage: RootRestoreSqlAssetAliasStage5) {
  const saved = owners.get(stage) ?? fail('不是实际 SQL 附件地址 owner')
  return (await reconstruct(saved)).value
}

/** Fixed alias-to-derived boundary. The tables come from independent SQL
 * readback, the input graph from the same authenticated original observation. */
export async function reopenRootRestoreSqlAssetAliasDerivationSource5(aliases: RootRestoreAssetAliasStage5, locator: Locator) {
  const readback = await reconstruct({ aliases, locator })
  return derivationSource(mint(aliases, readback.directory, readback.value), readback)
}

function derivationSource(alias: ReturnType<typeof mint>, readback: Awaited<ReturnType<typeof reopen>>) {
  const { input, source, base, value, directory, raw, edits } = readback
  const { location, referencePlanId, referenceManifestHash, data, allocation } = input.source
  const { physical, lineage } = base
  const actual = new Map(raw.tables.map(table => [table.name, new Map(table.rows.map(row => [row.sourceRowId, row.cells]))]))
  const tables = physical.tables.map(table => ({ ...table, rows: table.rows.map(row => ({
    ...row, cells: actual.get(table.name)?.get(row.targetRowId) ?? fail('附件派生来源缺实际 SQL 行')
  })) }))
  const navigationEdits = [...edits.changes.values()].flatMap(({ table, row, column, navigationEdits }) => {
    if (!navigationEdits) return []
    if (table.name !== 'blocks' && table.name !== 'documents' || column !== 'content' && column !== 'summary')
      return fail('导航改写不属于实际普通正文或摘要')
    return [{ table: table.name, targetRowId: row.targetRowId, column, edits: navigationEdits }]
  })
  return Object.freeze({ alias, location, referencePlanId, referenceManifestHash, physical, lineage,
    data, allocation, raw, tables, navigationEdits, marker: source.marker, databaseDirectory: join(directory, 'database'),
    holdOriginalBytes: () => holdAliasDatabase(directory, value, source.root), async assertOriginalBytes() {
      await input.assertOriginalBytes()
      if (lineage) {
        const held = await holdRootRestorePhysicalStageOriginalBytes3(base.stage)
        try { assertRootRestoreStage3FilesHeld3(held) }
        finally { closeRootRestoreStage3FilesHeld3(held) }
      }
    } })
}

/** Compose the independent alias and SQL writers with their own fresh readback. */
export async function prepareRootRestoreSqlAssetAliasDerivationFromCombined5(combined: RootRestoreSqlAssetStage5) {
  const { aliases, input } = await prepareRootRestoreAssetAliasWithSqlSource5(combined)
  const { alias, readback } = await prepare(aliases.owner, input, sqlBase(input))
  return { aliases, source: derivationSource(alias, readback) }
}

export async function reopenRootRestoreSqlAssetAliasDerivationFromCombined5(combined: RootRestoreSqlAssetStage5, aliasLocator: Locator, sqlLocator: Locator) {
  const { aliases, input } = await reopenRootRestoreAssetAliasWithSqlSource5(combined, aliasLocator)
  const readback = await reopen(sqlLocator, input, sqlBase(input))
  return { aliases, source: derivationSource(mint(aliases.owner, readback.directory, readback.value), readback) }
}

export async function prepareRootRestoreCanonicalAliasDerivationFromCombined5(reference: RootRestoreReferencePlan3, combined: RootRestoreSqlAssetStage5) {
  const { aliases, input, stage: canonical } = await prepareRootRestoreCanonicalAssetPhysicalWithAliasSource5(reference, combined)
  const address = { reference, combined, alias: addressOf(aliases), physical: addressOf(canonical) }
  const { alias, readback } = await prepare(aliases.owner, input, sqlBase(input, canonical), address)
  return { aliases, canonical, source: derivationSource(alias, readback) }
}

export async function reopenRootRestoreCanonicalAliasDerivationFromCombined5(reference: RootRestoreReferencePlan3, combined: RootRestoreSqlAssetStage5,
  aliasLocator: Locator, physicalLocator: Locator, sqlLocator: Locator) {
  const { aliases, input, stage: canonical } = await reopenRootRestoreCanonicalAssetPhysicalWithAliasSource5(reference, combined,
    aliasLocator, physicalLocator)
  const address = { reference, combined, alias: addressOf(aliases), physical: addressOf(canonical) }
  const readback = await reopen(sqlLocator, input, sqlBase(input, canonical))
  return { aliases, canonical, source: derivationSource(mint(aliases.owner, readback.directory, readback.value, address), readback) }
}

export async function readRootRestoreSqlAssetAliasDerivationSource5(stage: RootRestoreSqlAssetAliasStage5) {
  const saved = owners.get(stage) ?? fail('不是实际 SQL 附件地址 owner')
  const readback = await reconstruct(saved)
  return derivationSource(mint(saved.aliases, readback.directory, readback.value, saved.canonical), readback)
}
