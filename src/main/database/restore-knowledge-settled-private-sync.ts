import Database from 'better-sqlite3'
import { readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { assertOriginalSyncedExchangePreview, replaySyncedExchangeWorkingInputs5 } from '../sync/synced-exchange'
import { exchangeJobHeadKey, exchangeJobKey, exchangeJobPhaseKey, parseExchangeStored, validateExchangeJob, validateExchangeJobPhase, type ExchangeJob, type ExchangeReceipt } from '../sync/synced-exchange-model'
import { bothPreviewKey, validateBothPreviewIndex } from '../sync/synced-exchange-both-model'
import { conflictPreviewKey, validateConflictPreviewIndex } from '../sync/synced-exchange-conflict-model'
import { deletionChoicePreviewKey, validateDeletionChoicePreviewIndex } from './synced-exchange-deletion-choice-read'
import { knowledgePreviewKey, validateKnowledgePreviewIndex } from './synced-exchange-knowledge-read'
import { readSyncedPublicationSpoolOriginal } from '../sync/synced-publication'
import { decodePublicationJson, publicationHash, publicationJson } from '../sync/synced-publication-model'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleSchemaDefinition } from './synced-lifecycle-schema-metadata'
import { readSyncedExchangeDenialEvidenceById } from './synced-exchange-receipt'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchContent, assertOwnedRawCapsuleScratchReady, readOwnedRawCapsuleOriginal,
  reopenPreparedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { capsule2MergeContextNativeFilesForMain4 as io, readCapsule2MergeContextBufferForMain3 } from './restore-knowledge-capsule2-merge-contexts'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES, durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { assertRestoreInventory, restorePaths } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'

const exchangeRoot = 'synced-exchanges-v1', publicationRoot = 'synced-publications-v1', incomingRoot = 'synced-incoming-v1'
const headPrefix = 'sync.webdav.protocol5.exchange-job-head.v1.'
const jobPrefix = 'sync.webdav.protocol5.exchange-job.v1.'
const phasePrefix = 'sync.webdav.protocol5.exchange-job-phase.v1.'
const publicationChannel = 'webdav-manifest5', exchangeChannel = 'webdav-manifest5-exchange'
type HistoricalPreview = Parameters<typeof assertOriginalSyncedExchangePreview>[1]
const previewDomains = [
  { root: 'synced-exchange-previews-v1', prefix: 'sync.webdav.protocol5.exchange-preview.v1.', key: conflictPreviewKey,
    decode: (raw: unknown): HistoricalPreview => ({ family: 'conflict-v1', index: validateConflictPreviewIndex(raw) }) },
  { root: 'synced-exchange-both-previews-v1', prefix: 'sync.webdav.protocol5.exchange-both-preview.v1.', key: bothPreviewKey,
    decode: (raw: unknown): HistoricalPreview => ({ family: 'both-v1', index: validateBothPreviewIndex(raw) }) },
  { root: 'synced-exchange-previews-v2', prefix: 'sync.webdav.protocol5.exchange-preview.v2.', key: (id: string) => knowledgePreviewKey('conflicts', id),
    decode: (raw: unknown): HistoricalPreview => ({ family: 'conflict-v2', index: validateKnowledgePreviewIndex(raw, 'conflicts') }) },
  { root: 'synced-exchange-both-previews-v2', prefix: 'sync.webdav.protocol5.exchange-both-preview.v2.', key: (id: string) => knowledgePreviewKey('both', id),
    decode: (raw: unknown): HistoricalPreview => ({ family: 'both-v2', index: validateKnowledgePreviewIndex(raw, 'both') }) },
  { root: 'synced-exchange-deletion-previews-v1', prefix: 'sync.webdav.protocol5.exchange-deletion-preview.v1.', key: deletionChoicePreviewKey,
    decode: (raw: unknown): HistoricalPreview => ({ family: 'deletion-v1', index: validateDeletionChoicePreviewIndex(raw) }) }
] as const

const fail = (reason: string): never => { throw new Error('V3 同步原件读取失败：' + reason) }
const same = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b)
const fileEqual = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const pathEqual = (a: string, b: string) => isAbsolute(a) && relative(a, b) === ''
const identity = (stat: BigIntStats) => ({ dev: stat.dev.toString(), ino: stat.ino.toString() })
const exactIdentity = (stat: BigIntStats) => ({ ...identity(stat), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() })
const confirmedTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

type Setting = { key: string; value: string; updated_at: string }
type Member = { group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
type Exposure = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string;
  state: string; created_at: string; confirmed_at: string | null; members: Member[] }
function assertExposure(exposure: Exposure, requestHash: string, publicationHash: string, target: string,
  members: readonly { groupId: string; creationId: string; revision: string; topologyRevision: string; semanticHash: string }[]) {
  const expected = members.map(item => ({ group_id: item.groupId, creation_id: item.creationId, revision: item.revision,
    topology_revision: item.topologyRevision, semantic_hash: item.semanticHash }))
  if (exposure.request_hash !== requestHash || exposure.publication_hash !== publicationHash || exposure.target_fingerprint !== target
    || !expected.length || !same(exposure.members, expected)) return fail('原曝光行与实际发布或完整成员不符')
}

function readClosedSql(db: Database.Database, liveDatabase: string) {
  assertSyncedBlockSchema(db)
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return fail('未知封存 SQL 世代')
  if (version === 27) assertSyncedLifecycleSchemaDefinition(db)
  const cost = capsule2RawSqlValueBytesExpression(['key', 'value', 'updated_at'])
  const measure = db.prepare('SELECT count(*),coalesce(sum(' + cost + '),0) FROM main.app_settings')
    .safeIntegers(true).raw(true).get() as [bigint, bigint]
  if (measure[0] > BigInt(CAPSULE2_RAW_MAX_ROWS) || measure[1] > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES))
    return fail('封存 SQL 私有元数据超原预算')
  const select = db.prepare('SELECT key,value,updated_at FROM main.app_settings WHERE substr(lower(key),1,?)=? ORDER BY key')
  const get = (prefix: string) => select.all(prefix.length, prefix) as Setting[]
  const seenPreviews = new Set<string>()
  const previews = previewDomains.map(domain => ({ root: domain.root, entries: get(domain.prefix).map(row => {
    const original = domain.decode(parseExchangeStored(row.value)), { index } = original
    const familyId = original.family.replace(/-v[12]$/, '') + '\0' + index.previewId
    if (version !== 27 || row.key !== domain.key(index.previewId) || row.updated_at !== index.createdAt
      || !pathEqual(index.databasePath, liveDatabase) || row.value !== publicationJson(index) || seenPreviews.has(familyId))
      return fail('原预览 index、路径、版本或时间不闭合')
    seenPreviews.add(familyId)
    return { original, sqlHash: capsuleBytesHash(capsuleJson(row)) }
  }) }))
  const heads = get(headPrefix), jobs = get(jobPrefix), phases = get(phasePrefix)
  const byJob = new Map(jobs.map(row => [row.key, row])), byPhase = new Map<string, Setting[]>()
  for (const row of phases) {
    const phase = validateExchangeJobPhase(parseExchangeStored(row.value))
    if (row.key !== exchangeJobPhaseKey(phase.operationId, phase.attemptId, phase.sequence)) return fail('未知原交换 phase 位置')
    const key = exchangeJobKey(phase.operationId, phase.attemptId), group = byPhase.get(key) ?? []
    group.push(row); byPhase.set(key, group)
  }
  const operationRows = db.prepare('SELECT client_operation_id,result_json FROM main.synced_operations WHERE instr(result_json,?)>0 ORDER BY client_operation_id')
  const exchangeReceipts = new Map<string, string>()
  for (const row of operationRows.iterate('synced-exchange-operation') as IterableIterator<{ client_operation_id: string; result_json: string }>) {
    const value = parseExchangeStored(row.result_json)
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'synced-exchange-operation')
      exchangeReceipts.set(row.client_operation_id, row.result_json)
  }
  const attempted = new Set<string>()
  const findExposure = version === 27 ? db.prepare('SELECT 1 FROM main.synced_exposure_attempts WHERE id=?') : undefined
  const exchanges = heads.map(row => {
    const operationId = row.key.slice(headPrefix.length)
    if (!isSyncedUuid(operationId) || exchangeJobHeadKey(operationId) !== row.key) return fail('未知原交换 head 位置')
    const original = readSyncedExchangeDenialEvidenceById(db, operationId)
    if (!original?.job || original.receipt.version === 1 || original.job.version === 1) return fail('原交换没有准确结算 receipt/attempt')
    const { job, receipt } = original, jobHash = publicationHash(publicationJson(job))
    const expected = { kind: 'synced-exchange-job-head', version: 1, operationId, requestHash: job.requestHash,
      attemptId: job.attemptId, attemptIndex: job.attemptIndex, jobHash }
    if (row.value !== publicationJson(expected) || row.updated_at !== job.preparedAt
      || !pathEqual(job.request.databasePath, liveDatabase)) return fail('原交换 head 未结算或路径不符')
    const key = exchangeJobKey(operationId, job.attemptId), originalJob = byJob.get(key), originalPhases = byPhase.get(key)
    if (!originalJob || !originalPhases || exchangeReceipts.get(operationId) !== publicationJson(receipt))
      return fail('原交换缺 job、完整 phase 或准确原 receipt 字节')
    byJob.delete(key); byPhase.delete(key); exchangeReceipts.delete(operationId)
    if (attempted.has(job.attemptId)) return fail('同一交换尝试被重复使用')
    attempted.add(job.attemptId)
    const ancestors: { job: ExchangeJob; jobHash: string; sqlHash: string }[] = []
    let parent = job.parentAttemptId, parentIndex = job.attemptIndex - 1
    while (parent !== null) {
      if (attempted.has(parent) || parentIndex < 0) return fail('原交换重试父链重复或错位')
      const parentKey = exchangeJobKey(operationId, parent), savedJob = byJob.get(parentKey), savedPhases = byPhase.get(parentKey)
      if (!savedJob || !savedPhases) return fail('原交换重试缺准确父 job 或 phase')
      const parentJob = validateExchangeJob(parseExchangeStored(savedJob.value)), parentHash = publicationHash(publicationJson(parentJob))
      if (parentJob.attemptId !== parent || parentJob.attemptIndex !== parentIndex || parentJob.version !== job.version
        || parentJob.requestHash !== job.requestHash || !same(parentJob.request, job.request)
        || parentJob.workspaceScope !== job.workspaceScope || parentJob.recoveryEpoch !== job.recoveryEpoch || parentJob.remoteWorkspaceId !== job.remoteWorkspaceId
        || savedJob.updated_at !== parentJob.preparedAt || savedJob.value !== publicationJson(parentJob)) return fail('原交换重试父 job 与本次请求不闭合')
      // The publisher commits possible before sending any content. Only an
      // ancestor whose entire durable phase chain is this original prepared
      // row, with no exposure fact, is proven local after its child settles.
      const [first] = savedPhases, phase = validateExchangeJobPhase(parseExchangeStored(first.value))
      if (savedPhases.length !== 1 || phase.sequence !== 0 || phase.previousFactHash !== null || phase.phase !== 'prepared'
        || phase.remoteEtag !== null || phase.jobHash !== parentHash || phase.requestHash !== parentJob.requestHash
        || phase.version !== (parentJob.version === 3 || parentJob.version === 6 ? 2 : 1)
        || phase.recordedAt !== parentJob.preparedAt || first.updated_at !== phase.recordedAt || first.value !== publicationJson(phase)
        || findExposure?.get(parent)) return fail('原交换重试祖先缺仅 prepared 且无远端曝光的证据')
      ancestors.push({ job: parentJob, jobHash: parentHash, sqlHash: capsuleBytesHash(capsuleJson({ job: savedJob, phase: first })) })
      byJob.delete(parentKey); byPhase.delete(parentKey); attempted.add(parent)
      parent = parentJob.parentAttemptId; parentIndex--
    }
    if (parentIndex !== -1) return fail('原交换重试父链未到初始尝试')
    return { job, jobHash, receipt, ancestors, sqlHash: capsuleBytesHash(capsuleJson({ head: row, job: originalJob, phases: originalPhases, receipt })) }
  })
  if (byJob.size || byPhase.size || exchangeReceipts.size) return fail('存在无准确已结算 head 的原交换 job/phase')
  if (version !== 27 && exchanges.length) return fail('旧 SQL 世代出现新交换')
  const exposures = new Map<string, Exposure>()
  if (version === 27) {
    const members = db.prepare('SELECT group_id,creation_id,revision,topology_revision,semantic_hash FROM main.synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id')
    for (const row of db.prepare('SELECT * FROM main.synced_exposure_attempts WHERE channel IN (?,?) ORDER BY id').all(publicationChannel, exchangeChannel) as Omit<Exposure, 'members'>[]) {
      if (!isSyncedUuid(row.id) || row.state !== 'confirmed' || !confirmedTime(row.created_at) || !confirmedTime(row.confirmed_at)
        || Date.parse(row.confirmed_at) < Date.parse(row.created_at)) return fail('存在未确认或损坏的 WebDAV 曝光')
      exposures.set(row.id, { ...row, members: members.all(row.id) as Member[] })
    }
  }
  const publications = new Map([...exposures].filter(([, row]) => row.channel === publicationChannel))
  const claimed = new Set(exchanges.map(({ job }) => job.attemptId))
  if (claimed.size !== exchanges.length || [...exposures].some(([id, row]) => row.channel === exchangeChannel && !claimed.has(id)))
    return fail('原交换曝光不属于唯一已结算 job')
  return { exchanges, exposures, publications, previews }
}

async function originalSql(original: OwnedRawCapsuleOriginal) {
  const owned = readOwnedRawCapsuleOriginal(original), operationId = basename(owned.recoveryDirectory)
  const paths = restorePaths(owned.profileRoot, operationId)
  if (owned.sealedDirectory !== paths.safety && owned.sealedDirectory !== owned.originalDirectory) return fail('要求同次固定 safety SQL 封存源')
  await assertRestoreInventory(paths.safety, [...owned.originalInventory])
  const probe = await reopenPreparedRawCapsuleOriginal({ profileRoot: owned.profileRoot, operationId,
    capsuleId: basename(owned.capsuleDirectory), expectedInventory: owned.originalInventory })
  await assertOwnedRawCapsuleScratchReady(probe)
  const db = new Database(restoreSqliteFilename(readOwnedRawCapsuleOriginal(probe).databasePath), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    return { owned, operationId, paths, sql: db.transaction(() => readClosedSql(db, paths.database))() }
  } finally { db.close(); await assertOwnedRawCapsuleScratchContent(probe); await assertOwnedRawCapsuleOriginal(original) }
}

async function observeFiles(profileRoot: string, storage: string) {
  const files = new Map<string, Awaited<ReturnType<typeof io.hashFile>>>(), dirs = new Map<string, { stat: BigIntStats; names: string[] }>()
  let bytes = 0
  const path = (relative: string) => relative ? join(storage, ...relative.split('/')) : storage
  async function readDirectory(relative: string) {
    const absolute = path(relative), stat = await io.assertOriginCatalogDirectory(absolute, profileRoot)
    const all = await readdir(absolute)
    if (all.length > CAPSULE2_RAW_MAX_ROWS) return fail('原同步目录成员超过有限准备范围')
    const names = (relative === '' ? all.filter(name => name.toLowerCase().startsWith('synced-')) : all).sort()
    return { stat, names }
  }
  async function directory(relative: string) {
    let observed = dirs.get(relative)
    if (!observed) { observed = await readDirectory(relative); dirs.set(relative, observed) }
    return observed.names
  }
  async function file(relative: string, expected?: { hash: string; bytes: number }) {
    let seen = files.get(relative)
    if (!seen) {
      seen = await io.hashFile(path(relative), profileRoot, true)
      bytes += seen.bytes
      if (bytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return fail('私有同步原件总 bytes 超原 DAG 预算')
      if (files.size === CAPSULE2_RAW_MAX_ROWS) return fail('原同步文件数超过有限准备范围')
      files.set(relative, seen)
    }
    if (expected && (seen.sha256 !== expected.hash || seen.bytes !== expected.bytes)) return fail('原件 bytes 与准确描述符不符')
    return seen
  }
  async function read(relative: string, expected?: { hash: string; bytes: number }) {
    const observed = await file(relative, expected)
    if (observed.bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('需要物化的单份私有原件超完整 JSON 预算')
    return readCapsule2MergeContextBufferForMain3(path(relative), profileRoot, observed)
  }
  async function exact(relative: string, expected: readonly string[]) {
    if (!same(await directory(relative), [...new Set(expected)].sort())) return fail('固定同步原目录闭集不同：' + relative)
  }
  async function tail() {
    for (const [relative, first] of files) {
      const actual = await io.hashFile(path(relative), profileRoot, true)
      if (actual.sha256 !== first.sha256 || actual.bytes !== first.bytes || !fileEqual(actual.stat, first.stat)) return fail('原同步文件在读取期间变化')
    }
    for (const [relative, first] of [...dirs].reverse()) {
      const actual = await readDirectory(relative)
      if (!same(actual.names, first.names) || !fileEqual(actual.stat, first.stat)) return fail('原同步目录在读取期间变化')
    }
    return { files: [...files].map(([path, value]) => ({ path, sha256: value.sha256, bytes: value.bytes, identity: exactIdentity(value.stat) })).sort((a, b) => a.path < b.path ? -1 : 1),
      directories: [...dirs].map(([path, value]) => ({ path, names: value.names, identity: path ? exactIdentity(value.stat) : identity(value.stat) })).sort((a, b) => a.path < b.path ? -1 : 1), bytes }
  }
  return { directory, exact, file, read, tail }
}

async function readExchangeSpool(fs: Awaited<ReturnType<typeof observeFiles>>, operation: string, job: ExchangeJob, jobHash: string, receipt?: ExchangeReceipt) {
  const prefix = operation + '/' + job.attemptId
  const { objects, assets } = job.descriptor.next
  await fs.exact(prefix, ['assets', 'inputs.json', 'job.json', 'manifest.json', 'objects', 'ready.json'])
  await fs.exact(prefix + '/objects', objects.map(item => basename(item.path)))
  await fs.exact(prefix + '/assets', assets.map(item => basename(item.path)))
  if (!(await fs.read(prefix + '/job.json')).equals(Buffer.from(publicationJson(job)))) return fail('原 spool job 与 sealed SQL 不同')
  const ready = decodePublicationJson(await fs.read(prefix + '/ready.json'))
  assertSyncedShape(ready, ['jobHash', 'spoolHash'])
  if (ready.jobHash !== jobHash || ready.spoolHash !== job.spoolHash) return fail('原交换 ready 不绑定同次 spool')
  const { plan } = replaySyncedExchangeWorkingInputs5(await fs.read(prefix + '/inputs.json'), job)
  const manifest = await fs.read(prefix + '/manifest.json')
  if (!manifest.equals(Buffer.from(publicationJson(plan.nextRemote.manifest))) || publicationHash(manifest) !== job.descriptor.next.manifestHash)
    return fail('原交换计划与实际清单不闭合')
  if (receipt && (!same(plan.writes, receipt.result.publishedKeys) || !same(plan.incoming, receipt.result.appliedKeys)
    || !same(plan.accepted, receipt.result.acceptedKeys) || !same(plan.deferred, receipt.result.deferred)
    || !same(plan.acceptedSides, receipt.provenance.accepted) || !same(plan.transfers, receipt.provenance.transfers))) return fail('原交换计划、清单与已结算回执不闭合')
  const next = new Map(plan.nextRemote.records.map(row => [row.key, row.hash]))
  if (objects.length !== next.size) return fail('原交换对象缺完整重放成员')
  for (const item of objects) {
    if (next.get(item.key) !== item.hash) return fail('原交换对象不属于重放结果')
    await fs.file(prefix + '/' + item.path, item)
  }
  const aliases = [...plan.nextRemote.assetNames].map(([hash, names]) => ({ hash, names: [...names].sort() })).sort((a, b) => a.hash < b.hash ? -1 : 1)
  if (!same(aliases, assets.map(({ hash, names }) => ({ hash, names })))) return fail('原交换附件别名不属于重放结果')
  for (const item of assets) await fs.file(prefix + '/' + item.path, item)
}

/** Current-only read. The original safety capsule is genuine Main material.
 * This observes two fixed terminal spool domains and grants no installation. */
export async function readV3SettledPrivateSyncOriginals(original: OwnedRawCapsuleOriginal) {
  const { owned, operationId, paths, sql } = await originalSql(original)
  const fs = await observeFiles(owned.profileRoot, paths.storage), roots = await fs.directory('')
  if (roots.some(name => name !== exchangeRoot && name !== publicationRoot && name !== incomingRoot && !previewDomains.some(({ root }) => root === name))) return fail('未知同步私有目录')
  if (roots.includes(incomingRoot)) {
    for (const operationId of await fs.directory(incomingRoot)) {
      if (!isSyncedUuid(operationId)) return fail('初次接收私有目录含未知操作')
      if ((await fs.directory(incomingRoot + '/' + operationId)).length) return fail('初次接收仍有私有暂存原件')
    }
  }
  async function hasOriginals(root: string, ids: readonly string[]) {
    if (!roots.includes(root)) return false
    const names = await fs.directory(root)
    if (!names.length) return false
    await fs.exact(root, ids)
    return true
  }
  // Historical SQL proves terminal state even when an entire original spool
  // namespace has already been retired. A retained namespace must be exact.
  const hasExchanges = await hasOriginals(exchangeRoot, sql.exchanges.map(item => item.job.request.operationId))
  const hasPublications = await hasOriginals(publicationRoot, [...sql.publications.keys()])
  for (const { job, jobHash, receipt, ancestors } of sql.exchanges) {
    const exposure = sql.exposures.get(job.attemptId)
    if (receipt.result.publishedKeys.length && job.descriptor.members.length) {
      if (exposure?.channel !== exchangeChannel) return fail('已发布交换缺准确确认行')
      assertExposure(exposure, publicationHash(publicationJson({ method: 'exchangeSyncedSnapshot.publish', request: job.request, descriptor: job.descriptor })),
        publicationHash(publicationJson(job.descriptor)), job.request.targetFingerprint, job.descriptor.members)
    } else if (exposure) return fail('本次交换不应生成独立曝光行')
    if (!hasExchanges) continue
    const operation = exchangeRoot + '/' + job.request.operationId
    await fs.exact(operation, [job.attemptId, ...ancestors.map(item => item.job.attemptId)])
    await readExchangeSpool(fs, operation, job, jobHash, receipt)
    for (const ancestor of ancestors) await readExchangeSpool(fs, operation, ancestor.job, ancestor.jobHash)
  }
  for (const [id, exposure] of sql.publications) {
    if (!hasPublications) continue
    const prefix = publicationRoot + '/' + id
    await fs.exact(prefix, ['assets', 'manifest.json', 'objects', 'ready.json', 'state.json'])
    await fs.directory(prefix + '/objects'); await fs.directory(prefix + '/assets')
    let jsonBytes = 0
    const loaded = await readSyncedPublicationSpoolOriginal(owned.profileRoot, id, async (name, expected) => {
      const path = prefix + '/' + name, file = await fs.file(path, expected)
      jsonBytes += file.bytes
      if (jsonBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('原发布 JSON 成员超过完整 JSON 预算')
      return fs.read(path, expected)
    }, async asset => {
      if (asset.bytes > ATTACHMENT_MAX_FILE_BYTES) return fail('原发布附件超过 WebDAV 单文件上限')
      await fs.file(prefix + '/' + asset.path, asset)
    })
    const { objects, assets, targetFingerprint, members } = loaded.descriptor
    await fs.exact(prefix + '/objects', objects.map(item => basename(item.path)))
    await fs.exact(prefix + '/assets', assets.map(item => basename(item.path)))
    assertExposure(exposure, loaded.requestHash, loaded.publicationHash, targetFingerprint, members)
  }
  const observedPreviews: { root: string; previewId: string; sqlHash: string }[] = []
  for (const { root, entries } of sql.previews) {
    if (!await hasOriginals(root, entries.map(item => item.original.index.previewId))) continue
    for (const { original, sqlHash } of entries) {
      const { previewId, previewHash } = original.index, path = root + '/' + previewId
      await fs.exact(path, ['preview.json'])
      const bytes = await fs.read(path + '/preview.json')
      if (publicationHash(bytes) !== previewHash) return fail('原预览字节与准确 SQL index 不符')
      assertOriginalSyncedExchangePreview(bytes, original)
      observedPreviews.push({ root, previewId, sqlHash })
    }
  }
  const version = observedPreviews.length ? 3 : sql.exchanges.some(item => item.ancestors.length) ? 2 : 1
  const manifest = { kind: 'observed-v3-settled-private-sync-originals', version, operationId,
    sqlOriginalInventory: owned.originalInventory, ...await fs.tail(),
    exchanges: sql.exchanges.map(({ job, sqlHash, ancestors }) => ({ operationId: job.request.operationId, attemptId: job.attemptId,
      merges: job.version === 1 ? 0 : job.merges?.length ?? 0, sqlHash,
      ...(ancestors.length ? { preparedAncestors: ancestors.map(item => ({ attemptId: item.job.attemptId, sqlHash: item.sqlHash })) } : {}) })),
    ...(observedPreviews.length ? { previews: observedPreviews } : {}),
    exposures: [...sql.exposures].map(([id, value]) => ({ id, sqlHash: capsuleBytesHash(capsuleJson(value)) })), installPermit: false as const }
  // This is a readback of exact inputs. The joint journal independently
  // pins and rechecks the observation before granting installation.
  await assertOwnedRawCapsuleOriginal(original)
  const encoded = capsuleJson(manifest)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('原同步目录观察超完整 JSON 预算')
  return freezeCapsuleValue({ ...manifest, observationHash: capsuleBytesHash('knowbook.restore.v3.settled-private-originals.v' + version + '\0' + encoded) })
}

export interface V3SettledPrivateSyncLocator {
  readonly capsuleId: string
  readonly observationHash: string
}
export function validateV3SettledPrivateSyncLocator(value: unknown): V3SettledPrivateSyncLocator {
  const row = capsuleRecord(value, ['capsuleId', 'observationHash'])
  return freezeCapsuleValue({ capsuleId: durableSqlDagUuid(row.capsuleId), observationHash: durableSqlDagHash(row.observationHash) })
}
export async function assertV3SettledPrivateSyncOriginals(profileRoot: string, operationId: string,
  originalInventory: readonly DurableSqlCapsuleFile[], locator: V3SettledPrivateSyncLocator) {
  const { capsuleId, observationHash } = validateV3SettledPrivateSyncLocator(locator)
  const original = await reopenPreparedRawCapsuleOriginal({ profileRoot, operationId, capsuleId, expectedInventory: originalInventory })
  const actual = await readV3SettledPrivateSyncOriginals(original)
  if (actual.observationHash !== observationHash) return fail('真实私有同步原件与本次已封存观察不同')
}
