import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Text } from './restore-knowledge-graph3-data'
import { nativeAssetMetadataHash5 } from './restore-knowledge-selected-native-assets5'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { pendingLocalCellTextHash5 } from './restore-knowledge-pending-local-cell5'
import { assertRootRestoreReferenceOriginalBytes3, readRootRestoreReferenceCopySource3, type RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import { assertRootRestoreStage3FilesHeld3, closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3Files3,
  verifyRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { holdRootRestorePhysicalStageOriginalBytes3, prepareRootRestorePhysicalStage3, readRootRestorePhysicalStage3, readRootRestorePhysicalStageAssetEvidence3,
  reopenRootRestorePhysicalStage3, type RootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import { assertRootRestoreWorkingAssetStageOriginalBytes5, prepareRootRestoreWorkingAssetStage5, readRootRestoreWorkingAssetStage5, readRootRestoreWorkingAssetStageAndSources5,
  reopenRootRestoreWorkingAssetStage5, workingAssetSelectedCellHash5, type RootRestoreWorkingAssetStage5 } from './restore-knowledge-working-asset-stage5'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { template3ContentStringRanges } from './restore-knowledge-template3-json'
import { observeRootRestoreFinalAssetClosure5 } from './restore-knowledge-final-asset-closure5'
import { referenceContextFileKey, referenceContextObjectPath } from './restore-knowledge-reference-context-model'
import type { OriginalFrameCopy } from './restore-knowledge-original-frame-files'

export interface RootRestoreSqlAssetStage5 { readonly kind: 'main-root-restore-non-executable-sql-asset-stage5' }
type Reference = Awaited<ReturnType<typeof readRootRestoreReferenceCopySource3>>
type Sql = Awaited<ReturnType<typeof readRootRestorePhysicalStage3>>
type Assets = Awaited<ReturnType<typeof readRootRestoreWorkingAssetStage5>>
type Saved = { reference: RootRestoreReferencePlan3; stageId: string; expectedManifestHash: string;
  sql: RootRestorePhysicalStage3; assets: RootRestoreWorkingAssetStage5 }
const owners = new WeakMap<RootRestoreSqlAssetStage5, Saved>()
const fail = (message: string): never => { throw new Error('非执行 SQL 与附件暂存失败：' + message) }
const maxManifestBytes = 16 * 1024
const collection = ({ location }: Reference) => join(location.profileRoot, 'backups', 'database-restore', location.operationId, 'restore-sql-asset-stages-v5')

function combined(reference: Reference, stageId: string, sql: Sql, assets: Assets) {
  if (sql.checkedCanonicalCandidateHash !== reference.checkedCanonicalCandidateHash || assets.checkedCanonicalCandidateHash !== sql.checkedCanonicalCandidateHash
    || assets.referencePlanId !== reference.referencePlanId || assets.referenceManifestHash !== reference.referenceManifestHash
    || !sql.actual12TablesRead || !assets.selected.length) return fail('两个实际阶段缺同一原始候选')
  const tables = new Map(sql.tables.map(table => [table.name, { table, rows: new Map(table.rows.map(row => [row.targetRowId, row])) }]))
  if (reference.pendingCellProofHash !== (assets.version === 4 ? assets.pendingCellProofHash : undefined)) return fail('两个暂存的 pending 单元格证明不同')
  const selectedAssets = assets.version === 2 ? assets.selected.map(row => ({ ...row, context: null })) : assets.selected
  let pendingOccurrences = 0
  for (const selected of selectedAssets) {
    const { table, rows } = tables.get(selected.sourceRef.table) ?? fail('SQL 回读缺选中表')
    const row = rows.get(selected.targetRowId), column = table.columns.indexOf(selected.column)
    if (!row || column < 0 || capsuleJson(row.sourceRef) !== capsuleJson(selected.sourceRef)) return fail('实际 SQL 回读缺确切入选 row/cell')
    const content = graph3Text(row.cells[column], table.encoding)
    if (workingAssetSelectedCellHash5(content) !== selected.finalCellHash || content.slice(selected.finalFrom, selected.finalTo) !== selected.raw)
      return fail('入选附件与物理 SQL 回读范围不相符')
    const context = selected.context
    if (context?.kind === 'canonical') {
      const owner = tables.get('synced_groups') ?? fail('实际 SQL 缺 canonical 元数据表')
      const group = owner.rows.get(context.owner.targetRowId)
      if (table.name !== 'synced_group_blocks' || selected.column !== 'content' || !group
        || capsuleJson(group.sourceRef) !== capsuleJson(context.owner.sourceRef)) return fail('实际 SQL canonical 原属主不符')
      const groupColumn = (name: string) => graph3Text(group.cells[owner.table.columns.indexOf(name)], owner.table.encoding)
      if (graph3Text(row.cells[table.columns.indexOf('group_id')], table.encoding) !== context.owner.groupId
        || groupColumn('id') !== context.owner.groupId || groupColumn('creation_id') !== context.owner.creationId
        || nativeAssetMetadataHash5(groupColumn('origin_json')) !== context.owner.originJsonHash
        || nativeAssetMetadataHash5(groupColumn('bindings_json')) !== context.owner.bindingsJsonHash)
        return fail('实际 canonical 出生、绑定或 Origin 与封存选择不符')
    } else if (context?.kind === 'template-content') {
      if (table.name !== 'document_templates' || selected.column !== 'blocks_json') return fail('实际模板资产列错误')
      const token = template3ContentStringRanges(content)[context.blockIndex]
      const block = (JSON.parse(content) as Array<{ id?: string; content?: string }>)[context.blockIndex]
      if (!token || token.from !== selected.finalFrom || token.to !== selected.finalTo || block?.id !== context.localId
        || typeof block.content !== 'string' || JSON.parse(selected.raw) !== block.content
        || block.content.slice(context.asset.from, context.asset.to) !== context.asset.raw)
        return fail('实际模板 JSON token 或其内部 UTF-16 资产范围不符')
    } else if (context?.kind === 'pending-working-content') {
      const blockColumn = (name: string) => graph3Text(row.cells[table.columns.indexOf(name)], table.encoding)
      if (assets.version !== 4 || context.proofHash !== assets.pendingCellProofHash || table.name !== 'blocks' || selected.column !== 'content'
        || blockColumn('id') !== context.blockId || blockColumn('document_id') !== context.documentId
        || blockColumn('created_at') !== context.blockBirth || pendingLocalCellTextHash5(content) !== context.afterHash)
        return fail('实际 pending SQL 正文、出生或归属不符')
      pendingOccurrences++
    } else if (context?.kind === 'template-summary' && (table.name !== 'document_templates' || selected.column !== 'summary'))
      return fail('实际模板摘要列错误')
  }
  if (assets.version === 4 && (!pendingOccurrences || pendingOccurrences !== assets.pendingOccurrences)) return fail('实际 pending 资产范围不闭合')
  return freezeCapsuleValue({ kind: 'root-restore-non-executable-sql-asset-stage5' as const, version: 1 as const, stageId,
    referencePlanId: reference.referencePlanId, referenceManifestHash: reference.referenceManifestHash,
    checkedCanonicalCandidateHash: sql.checkedCanonicalCandidateHash, sqlStageId: sql.stageId, sqlManifestHash: sql.stageManifestHash,
    physicalObservationHash: sql.physicalObservationHash, assetStageId: assets.stageId,
    assetManifestHash: capsuleBytesHash(capsuleJson(assets) + '\n'), assetSelectionHash: assets.selectionHash,
    selectedAssetsMatchPhysicalSql: true as const, finalAssetClosureComplete: false as const, portableAssetsInstalled: false as const,
    acceptedCoverage: false as const, effective: false as const, installPermit: false as const })
}

async function finish(saved: Saved, reference: Reference, sql: Sql, assets: Assets, mode: 'create' | 'verify') {
  const value = combined(reference, saved.stageId, sql, assets), text = capsuleJson(value) + '\n', manifestHash = capsuleBytesHash(text)
  const base = collection(reference), directory = join(base, saved.stageId), root = reference.location.profileRoot, path = join(directory, 'manifest.json')
  if (Buffer.byteLength(text) > maxManifestBytes || manifestHash !== saved.expectedManifestHash) return fail('合并清单与原阶段不同')
  if (mode === 'create') {
    await restoreDirectory(base, root); await restoreDirectory(directory, root, true)
    await writeCapsule2AssetCopy(path, Buffer.from(text), root)
    await syncRestoreDirectory(directory); await syncRestoreDirectory(base); await syncOriginCatalogAncestors(base, root)
  }
  await assertCombinedFiles(saved, root, directory, text)
  return Object.freeze({ value, manifestHash, directory, stageId: saved.stageId })
}

async function assertCombinedFiles(saved: Saved, root: string, directory: string, text: string, checkOriginals = false) {
  const path = join(directory, 'manifest.json'), manifestHash = capsuleBytesHash(text)
  if (manifestHash !== saved.expectedManifestHash) return fail('组合清单字节不同')
  const heldSql = await holdRootRestorePhysicalStageOriginalBytes3(saved.sql)
  try {
    const heldManifest = await holdRootRestoreStage3Files3({ profileRoot: root, directories: [{ path: directory, entries: ['manifest.json'] }],
      files: [{ path, bytes: Buffer.byteLength(text), sha256: manifestHash }] })
    try {
      if (checkOriginals) await assertRootRestoreReferenceOriginalBytes3(saved.reference)
      await verifyRootRestoreStage3FilesHeld3(heldSql)
      await verifyRootRestoreStage3FilesHeld3(heldManifest)
      await assertRootRestoreWorkingAssetStageOriginalBytes5(saved.assets)
      assertRootRestoreStage3FilesHeld3(heldSql); assertRootRestoreStage3FilesHeld3(heldManifest)
    } finally { closeRootRestoreStage3FilesHeld3(heldManifest) }
  } finally { closeRootRestoreStage3FilesHeld3(heldSql) }
}

function mint(saved: Saved) {
  const stage: RootRestoreSqlAssetStage5 = Object.freeze({ kind: 'main-root-restore-non-executable-sql-asset-stage5' })
  owners.set(stage, saved)
  return stage
}

/** Each independent producer reauthenticates the same genuine Reference3
 * owner. The combined handle is issued only after actual SQL and file tails. */
export async function prepareRootRestoreSqlAssetStage5(reference: RootRestoreReferencePlan3) {
  const binding = await readRootRestoreReferenceCopySource3(reference), stageId = randomUUID()
  const assets = await prepareRootRestoreWorkingAssetStage5(reference), sql = await prepareRootRestorePhysicalStage3(reference)
  const body = combined(binding, stageId, sql.value, assets.value)
  const saved = { reference, stageId, expectedManifestHash: capsuleBytesHash(capsuleJson(body) + '\n'), sql: sql.stage, assets: assets.stage }
  const result = await finish(saved, binding, sql.value, assets.value, 'create')
  return Object.freeze({ ...result, stage: mint(saved), sql, assets })
}

export async function readRootRestoreSqlAssetStage5(stage: RootRestoreSqlAssetStage5) {
  const saved = owners.get(stage)
  if (!saved) return fail('不是实际合并阶段句柄')
  const binding = await readRootRestoreReferenceCopySource3(saved.reference)
  const sql = await readRootRestorePhysicalStage3(saved.sql), assets = await readRootRestoreWorkingAssetStage5(saved.assets)
  return (await finish(saved, binding, sql, assets, 'verify')).value
}

/** Opt-in closure audit of the same actual SQLite readback and original
 * asset selection. Unknown domains stay in the explicit remaining ledger. */
export async function readRootRestoreSqlAssetClosure5(stage: RootRestoreSqlAssetStage5) {
  return (await readClosure(stage)).audit
}

async function readClosure(stage: RootRestoreSqlAssetStage5) {
  const saved = owners.get(stage)
  if (!saved) return fail('不是实际合并阶段句柄')
  const binding = await readRootRestoreReferenceCopySource3(saved.reference)
  const sql = await readRootRestorePhysicalStageAssetEvidence3(saved.sql), assets = await readRootRestoreWorkingAssetStageAndSources5(saved.assets)
  const audit = observeRootRestoreFinalAssetClosure5(sql, assets)
  await assertRootRestoreReferenceOriginalBytes3(saved.reference)
  await finish(saved, binding, sql.value, assets.value, 'verify')
  return { saved, binding, sql, assets, audit }
}

/** Actual file sources for each independently matched closure occurrence.
 * Same-byte aliases are deduplicated only after this exact role/frame lookup. */
export async function readRootRestoreSqlAssetClosureCopySource5(stage: RootRestoreSqlAssetStage5) {
  const { saved, binding, assets, audit } = await readClosure(stage)
  const originalFiles = new Map(assets.sources.captured.pair.originalPackage.files.map(file => [referenceContextFileKey(file), file]))
  const stagedFiles = new Map(assets.value.files.map(file => [referenceContextFileKey(file), file]))
  const matched = audit.entries.flatMap(entry => {
    if (entry.status !== 'matched') return []
    const key = referenceContextFileKey(entry.proof.file), file = (entry.proof.kind === 'staged' ? stagedFiles : originalFiles).get(key)
    if (!file || file.sha256 !== entry.proof.hash || file.bytes !== entry.proof.bytes) return fail('审计原范围缺确切封存文件')
    const copy: OriginalFrameCopy = entry.proof.kind === 'staged'
      ? { ...file, sourceRoot: assets.directory, sourcePath: join(assets.directory, referenceContextObjectPath(file.frame, file.path)) }
      : originalFiles.get(key) ?? fail('审计缺本角色原件地址')
    return [Object.freeze({ entry, file: Object.freeze(copy) })]
  })
  return Object.freeze({ audit, matched: Object.freeze(matched), location: binding.location,
    combinedStageId: saved.stageId, combinedManifestHash: saved.expectedManifestHash })
}

/** Recheck pinned bytes at the tail of an independent alias write/read. */
export async function assertRootRestoreSqlAssetStageBytes5(stage: RootRestoreSqlAssetStage5) {
  const saved = owners.get(stage)
  if (!saved) return fail('不是实际合并阶段句柄')
  const binding = await readRootRestoreReferenceCopySource3(saved.reference), root = binding.location.profileRoot
  const directory = join(collection(binding), saved.stageId)
  const text = await readCapsule2AssetManifest(join(directory, 'manifest.json'), root, maxManifestBytes)
  await assertCombinedFiles(saved, root, directory, text, true)
}

export async function requireRootRestoreSqlAssetClosureAudit5(stage: RootRestoreSqlAssetStage5) {
  const audit = await readRootRestoreSqlAssetClosure5(stage)
  if (!audit.knownOccurrencesComplete || audit.remainder.length) return fail('最终附件审计有未绑定 occurrence 或未完成保留域')
  return audit
}

const manifestKeys = ['kind','version','stageId','referencePlanId','referenceManifestHash','checkedCanonicalCandidateHash','sqlStageId','sqlManifestHash',
  'physicalObservationHash','assetStageId','assetManifestHash','assetSelectionHash','selectedAssetsMatchPhysicalSql','finalAssetClosureComplete',
  'portableAssetsInstalled','acceptedCoverage','effective','installPermit']

export async function reopenRootRestoreSqlAssetStage5(reference: RootRestoreReferencePlan3,
  locator: { stageId: string; expectedManifestHash: string }) {
  const binding = await readRootRestoreReferenceCopySource3(reference), address = capsuleRecord(locator, ['stageId','expectedManifestHash'])
  const stageId = durableSqlDagUuid(address.stageId), expectedManifestHash = durableSqlDagHash(address.expectedManifestHash)
  const text = await readCapsule2AssetManifest(join(collection(binding), stageId, 'manifest.json'), binding.location.profileRoot, maxManifestBytes)
  const stored = capsuleRecord(JSON.parse(text), manifestKeys)
  if (capsuleBytesHash(text) !== expectedManifestHash || text !== capsuleJson(stored) + '\n' || stored.kind !== 'root-restore-non-executable-sql-asset-stage5'
    || stored.version !== 1 || stored.stageId !== stageId || stored.referencePlanId !== binding.referencePlanId
    || stored.referenceManifestHash !== binding.referenceManifestHash || stored.checkedCanonicalCandidateHash !== binding.checkedCanonicalCandidateHash
    || stored.selectedAssetsMatchPhysicalSql !== true || ['finalAssetClosureComplete','portableAssetsInstalled','acceptedCoverage','effective','installPermit']
      .some(key => stored[key] !== false)) return fail('未知版本、原候选或持久哈希不符')
  const sql = await reopenRootRestorePhysicalStage3(reference, { stageId: durableSqlDagUuid(stored.sqlStageId), expectedManifestHash: durableSqlDagHash(stored.sqlManifestHash) })
  const assets = await reopenRootRestoreWorkingAssetStage5(reference, { stageId: durableSqlDagUuid(stored.assetStageId), expectedManifestHash: durableSqlDagHash(stored.assetManifestHash) })
  const saved = { reference, stageId, expectedManifestHash, sql: sql.stage, assets: assets.stage }
  const result = await finish(saved, binding, sql.value, assets.value, 'verify')
  return Object.freeze({ ...result, stage: mint(saved), sql, assets })
}
