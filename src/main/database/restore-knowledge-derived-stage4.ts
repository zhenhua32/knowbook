import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MarkdownLinkIndex } from './markdown-link-index'
import { CAPSULE_MAX_MANIFEST_BYTES, capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, validateDurableSqlCapsuleInventory,
  type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { copyOriginCatalogFileWithIdentity3 } from './restore-knowledge-origin-bundle-files'
import { assertRootRestoreReferenceOriginalBytes3, readRootRestoreReferenceCopySource3,
  type RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { assertRootRestoreStage3FilesHeld3, assertRootRestoreStage3WritableMain3, assertRootRestoreStage3WrittenMainClosed3,
  closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3DatabaseFiles3, holdRootRestoreStage3Files3,
  verifyRootRestoreStage3FilesHeld3, type RootRestoreStage3HeldFiles3 } from './restore-knowledge-stage3-files'
import { stage3MarkerKey } from './restore-knowledge-stage3-marker-model'
import { holdRootRestorePhysicalStageOriginalBytes3, reopenRootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import { restoreDirectory, restoreInventory, syncRestoreDirectory, syncRestoreFile } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { completeStage4Routes, deriveStage4Routes, observeStage4Routes, observeStage4CanonicalSearch,
  type DerivedRoutePlan4 } from './restore-knowledge-derived-stage4-observation'

type PhysicalLocator = Parameters<typeof reopenRootRestorePhysicalStage3>[1]
type Physical = Awaited<ReturnType<typeof reopenRootRestorePhysicalStage3>>
type Binding = Awaited<ReturnType<typeof readRootRestoreReferenceCopySource3>>
type Link = { source_document_id: string; target_document_id: string; label: string }
type Observation = ReturnType<typeof observe>
type Manifest = ReturnType<typeof manifestFor>
export interface RootRestoreDerivedStage4 { readonly kind: 'main-root-restore-non-executable-link-stage4' }
type Saved = { reference: RootRestoreReferencePlan3; physical: Physical; root: string; directory: string; manifest: Manifest; routes?: DerivedRoutePlan4 }
const owners = new WeakMap<RootRestoreDerivedStage4, Saved>()
const fail = (message: string): never => { throw new Error('非执行恢复链接派生失败：' + message) }
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const maxManifestBytes = 16 * 1024
const collection = ({ profileRoot, operationId }: Binding['location']) => join(profileRoot, 'backups', 'database-restore', operationId, 'restore-derived-stages-v4')
const protectedTables = ['documents', 'blocks', 'document_block_routes', 'synced_workspace_state', 'synced_groups',
  'synced_group_blocks', 'synced_instances', 'synced_operations', 'synced_host_history', 'synced_host_history_state',
  'synced_group_history', 'synced_host_history_documents', 'synced_group_pins', 'synced_group_lifecycle', 'synced_group_retirements',
  'synced_exposure_attempts', 'synced_group_exposure_members', 'block_identities', 'app_settings', 'document_history',
  'document_trash', 'document_block_moves', 'document_templates', 'databases', 'document_database_columns',
  'database_saved_views', 'database_entities', 'database_entity_values', 'document_database_values'] as const

function expectedLinks(db: Database.Database): Link[] {
  return db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_document_id,source.url AS label
    FROM main.markdown_link_sources AS source JOIN main.documents AS target ON target.path=source.target_path
    WHERE source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id
    ORDER BY source_document_id,target_document_id,label`).all() as Link[]
}

function fingerprint(db: Database.Database, names: readonly string[], exceptLinkCount: boolean) {
  const encoding = db.pragma('main.encoding', { simple: true }) as string
  const hash = createHash('sha256').update('knowbook.restore.derived-stage4.sql.v1\0' + encoding + '\0')
  for (const name of names) {
    const table = 'main.' + quote(name)
    const columns = db.prepare(`SELECT * FROM ${table} LIMIT 0`).columns().map(column => column.name)
      .filter(column => !(exceptLinkCount && name === 'documents' && column === 'link_count'))
    const projection = columns.flatMap(column => {
      const field = quote(column)
      return [`typeof(${field})`, `CASE WHEN typeof(${field})='text' THEN CAST(${field} AS BLOB) ELSE ${field} END`]
    })
    hash.update(capsuleJson([name, columns]) + '\n')
    for (const row of db.prepare(`SELECT _rowid_,${projection.join(',')} FROM ${table} ORDER BY _rowid_`)
      .safeIntegers(true).raw(true).iterate() as IterableIterator<unknown[]>) {
      if (typeof row[0] !== 'bigint') return fail('原行身份不完整')
      hash.update(capsuleJson([row[0].toString(), columns.map((_column, index) =>
        rawRestoreSqlCell(row[2 * index + 1], row[2 * index + 2], encoding))]) + '\n')
    }
  }
  return hash.digest('hex')
}

function observe(db: Database.Database, routes?: DerivedRoutePlan4) {
  if (!db.inTransaction || db.pragma('main.user_version', { simple: true }) !== 27
    || db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('main.integrity_check', { simple: true }) !== 'ok'
    || (db.pragma('main.foreign_key_check') as unknown[]).length) return fail('需要完整实际 schema27 自有事务')
  const actual = db.prepare('SELECT source_document_id,target_document_id,label FROM main.links ORDER BY source_document_id,target_document_id,label').all()
  const extraCounts = routes ? `OR d.block_count<>(SELECT count(*) FROM main.blocks b WHERE b.document_id=d.id)
    OR d.child_count<>(SELECT count(*) FROM main.documents c WHERE c.parent_id=d.id)` : ''
  const wrongCount = db.prepare(`SELECT 1 FROM main.documents d
    WHERE d.link_count<>(SELECT count(*) FROM main.links l WHERE l.source_document_id=d.id) ${extraCounts} LIMIT 1`).get()
  if (wrongCount || !same(actual, expectedLinks(db))) return fail('实际链接、索引来源或计数不闭合')
  return { links: actual.length, indexed: (db.prepare('SELECT count(*) AS n FROM main.markdown_link_sources').get() as { n: number }).n,
    protectedHash: fingerprint(db, routes ? protectedTables.filter(name => name !== 'document_block_routes') : protectedTables, true),
    derivedHash: fingerprint(db, routes ? ['markdown_link_sources', 'links', 'documents', 'document_block_routes'] : ['markdown_link_sources', 'links', 'documents'], false),
    ...(routes ? { ...observeStage4Routes(db, routes), ...observeStage4CanonicalSearch(db) } : {}) }
}

function linkId(stageId: string, link: Link) {
  const bytes = createHash('sha256').update('knowbook.restore.derived-stage4.link.v1\0' + capsuleJson([stageId, link])).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function rebuild(db: Database.Database, stageId: string, physicalId: string, routes?: DerivedRoutePlan4): Observation {
  db.pragma('foreign_keys=ON')
  return db.transaction(() => {
    const protectedBefore = fingerprint(db, routes ? protectedTables.filter(name => name !== 'document_block_routes') : protectedTables, true)
    const marker = db.prepare('SELECT updated_at FROM main.app_settings WHERE key=?').get(stage3MarkerKey(physicalId)) as { updated_at: string } | undefined
    if (!marker || !Number.isFinite(Date.parse(marker.updated_at)) || new Date(marker.updated_at).toISOString() !== marker.updated_at)
      return fail('缺实际物理暂存标记时点')
    if (routes) completeStage4Routes(db, routes)
    new MarkdownLinkIndex(db).rebuild()
    const links = expectedLinks(db)
    db.exec('DELETE FROM main.links')
    const insert = db.prepare('INSERT INTO main.links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)')
    for (const link of links) insert.run(linkId(stageId, link), link.source_document_id, link.target_document_id, link.label, marker.updated_at)
    db.exec(`UPDATE main.documents SET link_count=(SELECT count(*) FROM main.links WHERE source_document_id=documents.id)`)
    const actual = observe(db, routes)
    if (actual.protectedHash !== protectedBefore) return fail('派生写入改变了受保护正文、历史或路由原行')
    return actual
  }).immediate()
}

async function copyDatabase(root: string, from: string, to: string, inventory: readonly DurableSqlCapsuleFile[]) {
  await restoreDirectory(to, root, true)
  const created = []
  for (const file of inventory) if (file.present) {
    if (file.sha256 === null) return fail('存在的原文件缺 SHA')
    const identity = await copyOriginCatalogFileWithIdentity3(join(from, file.name), root, join(to, file.name), root,
      { path: file.name, bytes: file.bytes, sha256: file.sha256 })
    created.push({ name: file.name, ...identity })
  }
  await syncRestoreDirectory(to)
  return created
}

function manifestFor(binding: Binding, physical: Physical, stageId: string,
  inventory: readonly DurableSqlCapsuleFile[], observation: Observation, version: 1 | 2) {
  return freezeCapsuleValue({ kind: 'root-restore-non-executable-link-stage4' as const, version, stageId,
    referencePlanId: binding.referencePlanId, referenceManifestHash: binding.referenceManifestHash,
    physicalStageId: physical.stageId, physicalManifestHash: physical.manifestHash,
    physicalObservationHash: physical.value.physicalObservationHash, inventory, observation, installPermit: false as const })
}

async function physicalInventory(physical: Physical, root: string) {
  const text = await readCapsule2AssetManifest(join(physical.directory, 'manifest.json'), root, CAPSULE_MAX_MANIFEST_BYTES)
  const manifest = JSON.parse(text)
  if (capsuleJson(manifest) + '\n' !== text ||
    capsuleBytesHash('knowbook.restore.stage3.physical-manifest.v1\0' + capsuleJson(manifest)) !== physical.manifestHash)
    return fail('物理暂存原清单哈希变化')
  return validateDurableSqlCapsuleInventory(manifest.sealedInventory)
}

async function writeIndependent(root: string, physical: Physical, original: RootRestoreStage3HeldFiles3,
  databaseDirectory: string, stageId: string, routes?: DerivedRoutePlan4) {
  const inventory = await physicalInventory(physical, root)
  const created = await copyDatabase(root, join(physical.directory, 'database'), databaseDirectory, inventory)
  const working = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: root, databaseDirectory, inventory,
    purpose: 'writable-open', expectedCreatedIdentities: created })
  let db: Database.Database | undefined, authorized = false
  try {
    await verifyRootRestoreStage3FilesHeld3(original)
    await verifyRootRestoreStage3FilesHeld3(working)
    assertRootRestoreStage3FilesHeld3(working); assertRootRestoreStage3FilesHeld3(original)
    db = new Database(restoreSqliteFilename(join(databaseDirectory, 'knowbook.db')), { fileMustExist: true })
    assertRootRestoreStage3WritableMain3(working, db); authorized = true
    return rebuild(db, stageId, physical.stageId, routes)
  } finally {
    try { db?.close(); if (db && authorized) assertRootRestoreStage3WrittenMainClosed3(working, db) }
    finally { closeRootRestoreStage3FilesHeld3(working) }
  }
}

async function readIndependent(saved: Saved, original: RootRestoreStage3HeldFiles3): Promise<Observation> {
  const { root, directory, manifest } = saved, database = join(directory, 'database'), inventory = manifest.inventory
  const manifestText = capsuleJson(manifest) + '\n', manifestPath = join(directory, 'manifest.json')
  const present = inventory.filter(file => file.present)
  const held = await holdRootRestoreStage3Files3({ profileRoot: root,
    directories: [{ path: directory, entries: ['checks', 'database', 'manifest.json'] },
      { path: database, entries: present.map(file => file.name) }],
    files: [{ path: manifestPath, bytes: Buffer.byteLength(manifestText), sha256: capsuleBytesHash(manifestText) },
      ...present.map(file => ({ path: join(database, file.name), bytes: file.bytes, sha256: file.sha256 ?? fail('已封存数据库缺 SHA') }))],
    absentFiles: inventory.filter(file => !file.present).map(file => join(database, file.name)) })
  try {
    const probe = join(directory, 'checks', randomUUID())
    await copyDatabase(root, database, probe, inventory)
    const db = new Database(restoreSqliteFilename(join(probe, 'knowbook.db')), { readonly: true, fileMustExist: true })
    let actual: Observation
    try {
      db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
      actual = db.transaction(() => observe(db, saved.routes))()
      if ((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n !== 0) return fail('独立回读出现写入')
    } finally { db.close() }
    const after = await restoreInventory(probe)
    if (!same(after[0], inventory[0]) || inventory[1].bytes > 0 && !same(after[1], inventory[1])
      || inventory[1].bytes === 0 && after[1].bytes !== 0 || !same(actual, manifest.observation))
      return fail('独立只读 SQL 与写后观察不一致')
    await assertRootRestoreReferenceOriginalBytes3(saved.reference)
    await verifyRootRestoreStage3FilesHeld3(original)
    await verifyRootRestoreStage3FilesHeld3(held)
    assertRootRestoreStage3FilesHeld3(original)
    assertRootRestoreStage3FilesHeld3(held)
    return actual
  } finally { closeRootRestoreStage3FilesHeld3(held) }
}

function value(manifest: Manifest, actual: Observation) {
  return freezeCapsuleValue({ ...actual, physicalManifestHash: manifest.physicalManifestHash,
    ordinaryLinkProjectionComplete: true as const, routesRebuilt: manifest.version === 2,
    ...(manifest.version === 2 ? { canonicalExpandedSearchComplete: true as const, documentStatisticsComplete: true as const } : {}),
    installPermit: false as const })
}

function mint(saved: Saved, actual: Observation) {
  const stage: RootRestoreDerivedStage4 = Object.freeze({ kind: 'main-root-restore-non-executable-link-stage4' })
  owners.set(stage, saved)
  return Object.freeze({ stage, directory: saved.directory, stageId: saved.manifest.stageId,
    manifestHash: capsuleBytesHash(capsuleJson(saved.manifest) + '\n'), value: value(saved.manifest, actual) })
}

/** Original Stage3 stays sealed. Only the new private scratch ever opens writable. */
export async function prepareRootRestoreDerivedStage4(reference: RootRestoreReferencePlan3, locator: PhysicalLocator) {
  const physical = await reopenRootRestorePhysicalStage3(reference, locator)
  const binding = await readRootRestoreReferenceCopySource3(reference), root = binding.location.profileRoot
  const stageId = randomUUID(), base = collection(binding.location), directory = join(base, stageId)
  const original = await holdRootRestorePhysicalStageOriginalBytes3(physical.stage)
  try {
    const routes = await deriveStage4Routes(reference, physical)
    const databaseDirectory = join(directory, 'database')
    await restoreDirectory(base, root); await restoreDirectory(directory, root, true)
    await restoreDirectory(join(directory, 'checks'), root, true)
    const observation = await writeIndependent(root, physical, original, databaseDirectory, stageId, routes)
    const inventory = validateDurableSqlCapsuleInventory(await restoreInventory(databaseDirectory))
    if (!same((await readdir(databaseDirectory)).sort(), inventory.filter(file => file.present).map(file => file.name).sort()))
      return fail('写后出现非预期文件')
    for (const file of inventory) if (file.present) await syncRestoreFile(join(databaseDirectory, file.name))
    await syncRestoreDirectory(databaseDirectory)
    const manifest = manifestFor(binding, physical, stageId, inventory, observation, 2), bytes = Buffer.from(capsuleJson(manifest) + '\n')
    if (bytes.length > maxManifestBytes) return fail('派生清单超预算')
    await writeCapsule2AssetCopy(join(directory, 'manifest.json'), bytes, root)
    await syncRestoreDirectory(directory); await syncRestoreDirectory(base)
    const saved = { reference, physical, root, directory, manifest, routes }
    return mint(saved, await readIndependent(saved, original))
  } finally { closeRootRestoreStage3FilesHeld3(original) }
}

export async function readRootRestoreDerivedStage4(stage: RootRestoreDerivedStage4) {
  const saved = owners.get(stage) ?? fail('不是实际 Main 派生阶段句柄')
  const original = await holdRootRestorePhysicalStageOriginalBytes3(saved.physical.stage)
  try {
    return value(saved.manifest, await readIndependent(saved, original))
  } finally { closeRootRestoreStage3FilesHeld3(original) }
}

const manifestKeys = ['kind', 'version', 'stageId', 'referencePlanId', 'referenceManifestHash', 'physicalStageId',
  'physicalManifestHash', 'physicalObservationHash', 'inventory', 'observation', 'installPermit']

/** Reconstruct from genuine original SQL before observing the persisted output.
 * The locator provides identity and bytes, never an expected semantic projection. */
export async function reopenRootRestoreDerivedStage4(reference: RootRestoreReferencePlan3, input: { stageId: string; expectedManifestHash: string }) {
  const locator = capsuleRecord(input, ['stageId', 'expectedManifestHash'])
  const stageId = durableSqlDagUuid(locator.stageId), expected = durableSqlDagHash(locator.expectedManifestHash)
  const binding = await readRootRestoreReferenceCopySource3(reference), root = binding.location.profileRoot
  const directory = join(collection(binding.location), stageId)
  const text = await readCapsule2AssetManifest(join(directory, 'manifest.json'), root, maxManifestBytes)
  const row = capsuleRecord(JSON.parse(text), manifestKeys)
  if (text !== capsuleJson(row) + '\n' || capsuleBytesHash(text) !== expected || row.kind !== 'root-restore-non-executable-link-stage4'
    || row.version !== 1 && row.version !== 2 || row.stageId !== stageId || row.installPermit !== false
    || row.referencePlanId !== binding.referencePlanId || row.referenceManifestHash !== binding.referenceManifestHash)
    return fail('冷清单与原引用或派生阶段不闭合')
  const inventory = validateDurableSqlCapsuleInventory(row.inventory)
  const physical = await reopenRootRestorePhysicalStage3(reference, {
    stageId: durableSqlDagUuid(row.physicalStageId), expectedManifestHash: durableSqlDagHash(row.physicalManifestHash) })
  const original = await holdRootRestorePhysicalStageOriginalBytes3(physical.stage)
  try {
    const routes = row.version === 2 ? await deriveStage4Routes(reference, physical) : undefined
    const probe = join(directory, 'checks', randomUUID())
    const observation = await writeIndependent(root, physical, original, probe, stageId, routes)
    const manifest = manifestFor(binding, physical, stageId, inventory, observation, row.version)
    if (text !== capsuleJson(manifest) + '\n') return fail('原物理暂存重建的派生 SQL 与持久清单不同')
    const saved = { reference, physical, root, directory, manifest, routes }
    return mint(saved, await readIndependent(saved, original))
  } finally { closeRootRestoreStage3FilesHeld3(original) }
}
