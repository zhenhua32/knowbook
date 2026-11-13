import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { parseExchangeStored, validateExchangeJob } from '../sync/synced-exchange-model'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { requiredRoot5WorkingMergeLocators5 } from './restore-knowledge-assets5-working-context'
import type { Root5WorkingScope5 } from './restore-knowledge-assets5-working-scopes'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { mixedOriginCapsulePath } from './restore-knowledge-mixed-origin-bundle-model'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import type { OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import { referenceContextFileKey } from './restore-knowledge-reference-context-model'
import { assertRootRestoreReferenceOriginalBytes3, readRootRestoreReferenceInputsAndOriginals5, readRootRestoreStageInputs5,
  type RootRestoreReferencePlan3, type RootRestoreStageInputs5 } from './restore-knowledge-reference3-read'

export interface RootRestoreWorkingAssetAuthority5 { readonly kind: 'main-root-restore-working-asset-authority5' }
type ReferenceRead = Awaited<ReturnType<typeof readRootRestoreReferenceInputsAndOriginals5>>
type Role = 'source' | 'current'
type Working = NonNullable<ReferenceRead['working'][Role]>
type Pending = Working['observation']['pendingPortableBindings'][number]
type Settled = Working['observation']['settledPortableBindings'][number]
type Destination = Root5WorkingScope5['destinations'][number]
type CatalogFile = Pick<OriginalFrameCopy, 'frame' | 'path' | 'bytes' | 'sha256'>
type Saved = { reference: RootRestoreReferencePlan3; observationHash: string }
const owners = new WeakMap<RootRestoreWorkingAssetAuthority5, Saved>()
const fail = (reason: string): never => { throw new Error('Working5 附件原件授权失败：' + reason) }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const coordinate = (scopeSource: readonly string[], section: string, from: number, to: number, uri: string) =>
  capsuleJson([scopeSource, section, from, to, uri])

function grouped<T>(rows: readonly T[], keyOf: (row: T) => string) {
  const index = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row), existing = index.get(key)
    if (existing) existing.push(row)
    else index.set(key, [row])
  }
  return index
}

function describeFile(file: OriginalFrameCopy): CatalogFile {
  return { frame: file.frame, path: file.path, bytes: file.bytes, sha256: file.sha256 }
}

function observations(captured: ReferenceRead) {
  const original = captured.pair.originalPackage
  const files = new Map(original.files.map(file => [referenceContextFileKey(file), file]))
  if (files.size !== original.files.length) return fail('实际原件域和相对路径出现重复')
  const payloads = new Map<string, OriginalFrameCopy>()
  const seenOccurrences = new Set<string>()
  const roles = (['source', 'current'] as const).flatMap(role => {
    const working = captured.working[role]
    if (!working) return []
    const packet = captured.pair[role], binding = original.original.node[role], ref = binding.capsule
    if (packet.capsuleId !== ref.capsuleId || packet.operationId !== ref.operationId || packet.assetArchive.version !== 5)
      return fail('Working5 与实际 Root 角色不一致')
    const raw = packet.source.sourceContent
    const assetRoot = mixedOriginCapsulePath(binding, 'knowledge-complete-assets-v2')
    const locators = new Map(requiredRoot5WorkingMergeLocators5(raw, { includeSettled: true }).map(value => [value.jobSettingKey, value]))
    const jobs = new Map(graph3Rows(raw, 'app_settings').filter(row => typeof row.value.key === 'string')
      .map(row => [String(row.value.key), row.value.value]))
    const captures = new Map(working.manifest.captures.map(row => [row.jobSettingKey, row]))
    const contexts = new Map(working.manifest.settledBindings.map(row => [row.jobSettingKey, row]))
    const contextFiles = new Map(working.manifest.files.map(file => [file.sha256, file]))
    const baseFiles = new Map(working.baseCommitment.tree.files.map(file => [file.hash, file]))
    const pending = grouped(working.observation.pendingPortableBindings,
      row => coordinate(row.scopeSource, row.section, row.from, row.to, row.sourceUri))
    const settled = grouped(working.observation.settledPortableBindings,
      row => coordinate(row.scopeSource, row.section, row.from, row.to, row.portableUri))
    const seenCoordinates = new Set<string>()
    const decodedJobs = new Map<string, ReturnType<typeof validateExchangeJob>>()

    function fileAt(path: string, sha256: string, bytes: number) {
      // Root source/current originate in frame []. This exact role's catalog
      // path is derived from the authenticated capsule, never searched by hash.
      const file = files.get(referenceContextFileKey({ frame: [], path }))
      if (!file || file.sha256 !== sha256 || file.bytes !== bytes || bytes > ATTACHMENT_MAX_FILE_BYTES)
        return fail('封存附件的固定角色、路径、长度或 SHA 不一致')
      return file
    }

    function pendingBlob(scope: Root5WorkingScope5, destination: Destination, row: Pending) {
      const locator = locators.get(scope.jobSettingKey), capture = captures.get(scope.jobSettingKey)
      if (!locator || !capture || capture.state !== 'captured' || scope.jobHash !== locator.jobHash
        || row.contextHash !== scope.contextHash || row.descriptorHash !== locator.descriptorHash
        || capture.sourceRowId !== locator.sourceRowId || capture.originalRowHash !== locator.originalRowHash
        || capture.locatorHash !== hash('knowbook.capsule5.merge-working-locator.v1', locator)) return fail('pending occurrence 不是这条实际 job/capture')
      let job = decodedJobs.get(scope.jobSettingKey)
      if (!job) {
        const text = jobs.get(scope.jobSettingKey)
        if (typeof text !== 'string') return fail('pending 原 SQL job 缺失')
        job = validateExchangeJob(parseExchangeStored(text))
        decodedJobs.set(scope.jobSettingKey, job)
      }
      const portable = parseSyncedPortableAssetUri(destination.uri)
      const asset = job.descriptor.next.assets.find(item => item.hash === portable.hash)
      if (!asset || !asset.names.includes(portable.name) || portable.hash !== row.hash || portable.name !== row.name || asset.bytes !== row.bytes)
        return fail('pending 逻辑别名不在该 job 的原 descriptor')
      const index = locator.requiredFiles.indexOf(asset.path)
      const digest = capture.fileHashes[index], inventory = contextFiles.get(digest)
      if (index < 0 || digest !== asset.hash || !inventory || inventory.bytes !== asset.bytes)
        return fail('pending descriptor 资产不在该捕获的原文件槽')
      const file = fileAt(assetRoot + '/contexts/files/' + digest, digest, asset.bytes)
      return { file, logicalName: portable.name, evidence: { kind: 'pending-captured-working-context' as const,
        contextHash: scope.contextHash, descriptorHash: locator.descriptorHash, locatorHash: capture.locatorHash, originalPath: asset.path, index } }
    }

    function settledBlob(scope: Root5WorkingScope5, destination: Destination, rows: readonly Settled[]) {
      const context = contexts.get(scope.jobSettingKey), base = working!.baseCommitment, portable = parseSyncedPortableAssetUri(destination.uri)
      if (!context || context.contextHash !== scope.contextHash) return fail('settled occurrence 缺该真实封存上下文')
      const file = fileAt(assetRoot + '/files/' + portable.hash, portable.hash, rows[0].bytes)
      const capturedFile = baseFiles.get(portable.hash)
      if (!capturedFile || capturedFile.bytes !== file.bytes) return fail('settled blob 不在实际 base 树')
      const witnesses = rows.map(row => {
        const entry = base.referenceProvenance.entries[row.baseReferenceIndex], alias = base.tree.aliases[row.aliasIndex]
        if (row.contextHash !== scope.contextHash || row.recordKey !== scope.recordKey || row.resultHash !== scope.resultHash
          || row.hash !== portable.hash || row.logicalName !== portable.name || row.bytes !== file.bytes
          || base.referenceUris[row.baseReferenceIndex] !== row.sourceUri || !entry || entry[0] !== row.baseReferenceIndex
          || entry[1] === 'unresolved' || entry[2] !== row.aliasIndex || !alias || alias.hash !== row.hash
          || alias.bytes !== row.bytes || alias.name !== row.physicalName) return fail('settled occurrence 与实际 base alias 证明不一致')
        if (entry[1] === 'file' ? base.referenceProvenance.rootSpellings[entry[3]]?.uri !== row.logicalRootUri
          : row.logicalRootUri !== null || row.sourceUri !== destination.uri || alias.name !== portable.name)
          return fail('settled 物理根拼写或原始 portable alias 变化')
        return { baseReferenceIndex: row.baseReferenceIndex, aliasIndex: row.aliasIndex, sourceUri: row.sourceUri,
          physicalName: row.physicalName, logicalRootUri: row.logicalRootUri, originalScopeSource: row.originalScopeSource,
          originalScopeContentHash: row.originalScopeContentHash, projectionHash: row.projectionHash }
      })
      // A repeated portable URI can have multiple base spelling witnesses.
      // Preserve each one, allowing only a single exact same-role sealed blob.
      return { file, logicalName: portable.name, evidence: { kind: 'settled-captured-base-alias' as const,
        contextHash: scope.contextHash, baseManifestHash: base.baseManifestHash, bindingHash: context.bindingHash, witnesses } }
    }

    const occurrences = working.observation.scopes.flatMap(scope => scope.destinations.map(destination => {
      const key = coordinate(scope.source, destination.section, destination.from, destination.to, destination.uri)
      const range = capsuleJson([scope.source, destination.section, destination.from, destination.to])
      if (seenCoordinates.has(range)) return fail('同角色重复的确切 Working5 destination 坐标')
      seenCoordinates.add(range)
      const occurrence = { role, capsule: ref, scopeSource: scope.source, contentHash: scope.contentHash,
        bodyProjectionHash: scope.bodyProjectionHash, jobSettingKey: scope.jobSettingKey, contextHash: scope.contextHash,
        recordKey: scope.recordKey, resultHash: scope.resultHash, destination }
      const id = hash('knowbook.restore.working5.asset-occurrence.v1', occurrence)
      if (seenOccurrences.has(id)) return fail('重复或碰撞的 occurrence 身份')
      seenOccurrences.add(id)
      const p = pending.get(key) ?? [], s = settled.get(key) ?? []
      pending.delete(key); settled.delete(key)
      if (p.length > 1 || p.length && (s.length || scope.evidenceKind !== 'replayed-original-working-inputs')
        || s.length && scope.evidenceKind !== 'settled-original-working-record') return fail('不同来源族不能借用同 occurrence')
      const bound = p.length ? pendingBlob(scope, destination, p[0]) : s.length ? settledBlob(scope, destination, s) : undefined
      if (!bound) return { id, ...occurrence, status: 'unresolved' as const }
      payloads.set(id, bound.file)
      return { id, ...occurrence, status: 'sealed-blob' as const, logicalName: bound.logicalName,
        file: describeFile(bound.file), evidence: bound.evidence }
    }))
    if (pending.size || settled.size) return fail('资产绑定不属于任何真实 Working5 occurrence')
    return [{ role, archiveHash: packet.assetArchiveHash, workingManifestHash: working.manifestHash,
      workingObservationHash: working.observation.observationHash, occurrences, unsupportedHolders: working.observation.unsupportedHolders }]
  })
  const body = { kind: 'root-restore-working-asset-observation5' as const, version: 1 as const,
    originalDescriptorHash: original.descriptorHash, referencePlanId: captured.actual.referencePlanId,
    referenceManifestHash: captured.actual.referenceManifestHash, roles, finalAssetClosureComplete: false as const,
    allAssetScopesCaptured: false as const, acceptedCoverage: false as const, effective: false as const, installPermit: false as const }
  assertMerge3JsonBudget(body)
  return { value: freezeCapsuleValue({ ...body, observationHash: hash('knowbook.restore.working5.asset-authority.v1', body) }), payloads }
}

/** Fixed same-read input for Main's asset stage. A caller cannot supply any
 * observation, path or file selection to this original reader. */
export async function readRootRestoreWorkingAssetSources5(reference: RootRestoreReferencePlan3, scope?: RootRestoreStageInputs5) {
  const captured = scope ? await readRootRestoreStageInputs5(reference, scope) : await readRootRestoreReferenceInputsAndOriginals5(reference)
  const observed = observations(captured)
  await assertRootRestoreReferenceOriginalBytes3(reference)
  const files: ReadonlyMap<string, OriginalFrameCopy> = observed.payloads
  return Object.freeze({ captured, value: observed.value, files })
}

/** A genuine Reference3 plan is the only input. Occurrence or file DTOs never
 * mint an authority, and the private registry retains no runtime W/SQL/files. */
export async function prepareRootRestoreWorkingAssetAuthority5(reference: RootRestoreReferencePlan3) {
  const { value } = await readRootRestoreWorkingAssetSources5(reference)
  const authority: RootRestoreWorkingAssetAuthority5 = Object.freeze({ kind: 'main-root-restore-working-asset-authority5' })
  owners.set(authority, { reference, observationHash: value.observationHash })
  return Object.freeze({ authority, value })
}

/** Diagnostic/verification read of one selected original, using the existing
 * single attachment limit. Stage composition will use streaming copy instead. */
export async function readRootRestoreWorkingAssetBlob5(authority: RootRestoreWorkingAssetAuthority5, occurrenceId: string) {
  const saved = owners.get(authority)
  if (!saved || typeof occurrenceId !== 'string' || !/^[a-f0-9]{64}$/.test(occurrenceId)) return fail('不是实际 owner 或确切 occurrence id')
  const observed = observations(await readRootRestoreReferenceInputsAndOriginals5(saved.reference))
  if (observed.value.observationHash !== saved.observationHash) return fail('原件或 occurrence 已变化')
  const file = observed.payloads.get(occurrenceId)
  const bytes = file ? await readCapsule2AssetCopy(file.sourcePath, file.sourceRoot, file.bytes, file.sha256, ATTACHMENT_MAX_FILE_BYTES) : null
  await assertRootRestoreReferenceOriginalBytes3(saved.reference)
  return bytes ? { status: 'original-blob' as const, bytes, file: describeFile(file!) } : { status: 'unavailable' as const }
}
