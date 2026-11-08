// Main-private pure derivation only. DTOs never mint a file/skip/install capability.
import { win32, posix } from 'node:path'
import { buildSyncedPortableAssetUri, parseSyncedPortableAssetUri, rewriteSyncedGroupAssets,
  rewriteSyncedPortableHostAssets } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { capsule2AssetReferenceProvenanceHash, capsule2AssetReferenceProvenance2Hash,
  validateCapsule2AssetReferenceProvenance1, validateCapsule2AssetReferenceProvenance2 } from './restore-knowledge-capsule2-asset-provenance'
import { capsule2CombinedAssetUris3 } from './restore-knowledge-capsule2-asset-supplement-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { root3SupplementOriginalRowHash3, type Root3SettledCandidateProjectorForMain3 } from './restore-knowledge-assets3-context'
import { deriveRoot5SettledWorkingEvidence5 } from './restore-knowledge-assets5-working-context'
import { mapPublicationCatalog, publicationHash, publicationJson } from '../sync/synced-publication-model'
import { validateSyncedProtocol5Record } from '../sync/synced-protocol5-model'
import { parseExchangeStored, validateExchangeJob, exchangeJobHash } from '../sync/synced-exchange-model'
import type { Capsule2AssetArchiveManifest } from './restore-knowledge-capsule2-asset-archive'
import type { readRawCapsule2AssetReferenceSourceOwned } from './restore-knowledge-capsule2-assets-read'

type ReferenceFields = 'version' | 'sourceContentHash' | 'workspaceHistoryObservationHash' | 'assetReferencesObservationHash' | 'referenceUris' | 'tree' | 'referenceProvenance'
export type Capsule2PortableReferenceCapture3 = Pick<Extract<Capsule2AssetArchiveManifest, {version: 2}>, ReferenceFields>
  | Pick<Extract<Capsule2AssetArchiveManifest, {version: 3}>, ReferenceFields | 'assetScopeSupplement'>
export type Capsule2SettledPortableBinding3 = { readonly sourceManifestHash: string; readonly sourceMaterialHash: string; readonly assetArchiveHash: string }
  | { readonly baseProjectionManifestHash: string; readonly baseProjectionMaterialHash: string }
export interface Capsule2SettledPortableInput3<Binding extends Capsule2SettledPortableBinding3> {
  readonly source: Pick<ReturnType<typeof readRawCapsule2AssetReferenceSourceOwned>, 'sourceContent' | 'assets' | 'physical'>
  readonly referenceCapture: Capsule2PortableReferenceCapture3
  readonly binding: Binding
}
function projectionBinding(binding: Capsule2SettledPortableBinding3) {
  return 'sourceManifestHash' in binding ? { sourceMaterialHash: binding.sourceMaterialHash, assetArchiveHash: binding.assetArchiveHash } : binding
}

type LiveRecord = Extract<ReturnType<typeof validateSyncedProtocol5Record>, { kind: 'document' | 'synced-group' }>
type RawRow = ReturnType<typeof graph3Rows>[number]
const fail = (reason: string): never => { throw new Error('settled portable owner无效：' + reason + '；不授spool跳过、资产读写、语义选择或安装权。') }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
function live(value: unknown): value is LiveRecord {
  return !!value && typeof value === 'object' && 'kind' in value && (value.kind === 'document' || value.kind === 'synced-group')
}
function body(record: LiveRecord) { return record.kind === 'document' ? { summary: record.content.summary, blocks: record.content.blocks } : { summary: '', blocks: record.blocks } }
function scopeSource(source: readonly string[]) {
  if ((source[0] === 'documents' || source[0] === 'synced_groups') && source.length === 3 && source[2] === 'complete-original-protocol-record') return source.slice(0, 2)
  // The original v7 whole-record witness names the record root, while its
  // base observer explicitly names the typed `record` field. No generic path
  // prefix, same URI or another holder's scope can substitute for this field.
  if (source[0] === 'app_settings' && source[2] === 'value' && source[3] === 'decisionSource'
    && (source.length === 7 && ['localPhysical', 'localKnowledge', 'remote'].includes(source[4]) && source[5] === 'records'
      || source.length === 6 && source[4] === 'baseRecords')) return [...source, 'record']
  return [...source]
}

/** Reproduce the ORIGINAL export's logical path/name rule, not the physical
 * tree's long name. Only a genuine captured URI entry calls this function.
 * Native realpath/FD proof supplies content hash and ownership separately.
 * Using the original path flavour keeps cold Windows sources deterministic
 * on another host without ever opening the retired root. */
export function logicalFileAsset(uri: string, provenRootSpellingUri: string, expectedHash: string) {
  if (uri.length > 8192) return null // Existing AttachmentStore.resolve bound.
  let url: URL, root: URL
  try { url = new URL(uri); root = new URL(provenRootSpellingUri) } catch { return null }
  // The current original AttachmentStore/export codec rejects UNC hosts.
  // A physical identity proof cannot silently broaden that logical codec.
  if (url.protocol !== 'file:' || root.protocol !== 'file:' || url.hostname || root.hostname || url.username || url.password
    || url.port || url.search || url.hash || root.username || root.password || root.port || root.search || root.hash) return null
  let filePath: string, rootPath: string
  try { filePath = decodeURIComponent(url.pathname); rootPath = decodeURIComponent(root.pathname) } catch { return null }
  if (/%(?:2f|5c)/i.test(url.pathname) || /%(?:2f|5c)/i.test(root.pathname)) return null
  const windows = /^\/[A-Za-z]:\//.test(rootPath), paths = windows ? win32 : posix
  if (windows) {
    if (!/^\/[A-Za-z]:\//.test(filePath)) return null
    filePath = filePath.slice(1).replaceAll('/', '\\'); rootPath = rootPath.slice(1).replaceAll('/', '\\')
  }
  filePath = paths.resolve(filePath); rootPath = paths.resolve(rootPath)
  const parts = paths.relative(rootPath, filePath).split(paths.sep), name = paths.basename(filePath)
  if (parts.length !== 4 || parts[0] !== 'attachments' || !/^[a-f0-9]{64}$/.test(parts[2])
    || parts[1] !== parts[2].slice(0, 2) || parts[2] !== expectedHash || parts[3] !== name) return null
  try { return { name, portableUri: buildSyncedPortableAssetUri({ hash: expectedHash, name }) } } catch { return null }
}

function createCapturedBasePortableProjector5<Binding extends Capsule2SettledPortableBinding3>(input: Capsule2SettledPortableInput3<Binding>) {
  const { source, referenceCapture: archive } = input, raw = source.sourceContent, assets = source.assets
  const baseUris = [...new Set(assets.scopes.flatMap(scope => scope.destinations.map(value => value.uri)))].sort()
  if (archive.sourceContentHash !== assets.sourceContentHash || archive.assetReferencesObservationHash !== assets.observationHash
    || archive.workspaceHistoryObservationHash !== assets.workspaceHistoryObservationHash || !same(baseUris, archive.referenceUris))
    return fail('genuine原SQL/base scope与捕获证明不同')
  const proofUris = archive.version === 3 ? capsule2CombinedAssetUris3(baseUris, archive.assetScopeSupplement) : baseUris
  if (archive.version === 2) validateCapsule2AssetReferenceProvenance1(archive.referenceProvenance, {
    sourceContentHash: assets.sourceContentHash, workspaceHistoryObservationHash: assets.workspaceHistoryObservationHash,
    assetReferencesObservationHash: assets.observationHash, referenceUris: baseUris }, archive.tree)
  else validateCapsule2AssetReferenceProvenance2(archive.referenceProvenance, {
    sourceContentHash: assets.sourceContentHash, workspaceHistoryObservationHash: assets.workspaceHistoryObservationHash,
    assetReferencesObservationHash: assets.observationHash, assetScopeSupplementHash: archive.assetScopeSupplement.observationHash,
    referenceUris: proofUris }, archive.tree)
  const proofHash = archive.version === 2 ? capsule2AssetReferenceProvenanceHash(archive.referenceProvenance) : capsule2AssetReferenceProvenance2Hash(archive.referenceProvenance)
  const uriIndex = new Map(proofUris.map((uri, index) => [uri, index])), blobs = new Map(archive.tree.files.map(file => [file.hash, file.bytes]))
  const aliasIndex = new Map(archive.tree.aliases.map(alias => [capsuleJson([alias.hash, alias.name]), alias]))
  const scopes = new Map(assets.scopes.map(scope => [capsuleJson(scope.source), scope]))
  const actualRows = new Map(raw.tables.map(table => [table.name, { table, rows: new Map(table.rows.map(row => [row.sourceRowId, row])) }]))
  const settings = graph3Rows(raw, 'app_settings'), catalogRows = settings.filter(row => row.value.key === 'database.defaultId')
  if (catalogRows.length !== 1 || typeof catalogRows[0].value.value !== 'string') return fail('缺原真实default catalog来源')
  const catalogId = catalogRows[0].value.value
  if (!graph3Rows(raw, 'databases').some(row => row.value.id === catalogId)) return fail('default catalog不属于原数据库行')
  const documents = new Map(source.physical.documents.map(document => [document.documentId, document]))
  const groups = new Map(source.physical.groups.filter(group => group.snapshot).map(group => [group.groupId, group.snapshot!]))
  const rejected: Array<{ source: readonly string[]; reason: string }> = []
  const projector: Root3SettledCandidateProjectorForMain3 = { project(value, source, rows) {
    const block = (reason: string) => { rejected.push({ source: [...source], reason }); return null }
    if (!live(value)) return block('candidate-is-not-a-complete-live-record')
    for (const row of rows) { const actual = actualRows.get(row.table.name)
      if (!actual || actual.table !== row.table || actual.rows.get(row.original.sourceRowId) !== row.original) return fail('projection row不属于同次真实原SQL') }
    let original: LiveRecord = value
    if (source.length === 3 && source[2] === 'complete-original-protocol-record') {
      if (source[0] === 'documents') {
        const document = documents.get(source[1]); if (!document) return block('complete-native-document-unavailable')
        original = { kind: 'document', id: document.documentId, parentId: document.parentId, sortOrder: document.sortOrder,
          createdAt: document.createdAt, content: { title: document.title, summary: document.summary, blocks: document.blocks } }
      } else if (source[0] === 'synced_groups') {
        const group = groups.get(source[1]); if (!group) return block('complete-native-group-unavailable')
        original = { kind: 'synced-group', id: group.groupId, creationId: group.creationId, createdAt: group.createdAt,
          origin: group.origin, bindings: group.bindings, blocks: group.blocks }
      }
    }
    const sourceKey = scopeSource(source), scope = scopes.get(capsuleJson(sourceKey))
    if (!scope || hash('knowbook.capsule2.asset-scope-content.v1', body(original)) !== scope.contentHash) return block('whole-original-holder-does-not-match-base-scope')
    const permitted = new Set(scope.destinations.map(value => value.uri)), mappings = new Map<string, {
      sourceUri: string; hash: string; bytes: number; physicalName: string; logicalName: string; portableUri: string; referenceIndex: number; logicalRootUri?: string
    }>()
    let unmapped = false
    const map = (uri: string): string => {
      if (!permitted.has(uri)) { unmapped = true; throw new Error('URI is not in this exact original typed scope') }
      const cached = mappings.get(uri); if (cached) return cached.portableUri
      const referenceIndex = uriIndex.get(uri), entry = referenceIndex === undefined ? undefined : archive.referenceProvenance.entries[referenceIndex]
      if (referenceIndex === undefined || !entry || entry[0] !== referenceIndex || entry[1] === 'unresolved') { unmapped = true; throw new Error('No genuine captured URI file authority') }
      if (entry[1] === 'file') {
        const physical = archive.tree.aliases[entry[2]], provenRoot = archive.referenceProvenance.rootSpellings[entry[3]]
        const logical = physical && provenRoot && logicalFileAsset(uri, provenRoot.uri, physical.hash)
        if (!physical || !provenRoot || !logical || blobs.get(physical.hash) !== physical.bytes) { unmapped = true; throw new Error('Original export logical file alias is not reproducible') }
        mappings.set(uri, { sourceUri: uri, hash: physical.hash, bytes: physical.bytes, physicalName: physical.name,
          logicalName: logical.name, portableUri: logical.portableUri, referenceIndex, logicalRootUri: provenRoot.uri })
        return logical.portableUri
      }
      const portable = parseSyncedPortableAssetUri(uri), physical = aliasIndex.get(capsuleJson([portable.hash, portable.name]))
      if (!physical || blobs.get(physical.hash) !== physical.bytes) { unmapped = true; throw new Error('Original portable alias bytes unavailable') }
      mappings.set(uri, { sourceUri: uri, hash: physical.hash, bytes: physical.bytes, physicalName: physical.name,
        logicalName: portable.name, portableUri: uri, referenceIndex }); return uri
    }
    try {
      const mappedCatalog = mapPublicationCatalog([original], catalogId)[0]
      if (mappedCatalog.kind !== 'document' && mappedCatalog.kind !== 'synced-group') return block('catalog-projection-is-not-a-live-record')
      const projected = mappedCatalog.kind === 'document' ? rewriteSyncedPortableHostAssets(mappedCatalog, map) : rewriteSyncedGroupAssets(mappedCatalog, map)
      const key = original.kind === 'document' ? 'doc:' + original.id : 'group:' + original.id
      const record = validateSyncedProtocol5Record(projected, key)
      const binding = { kind: 'genuine-base-proof-portable-record' as const, version: 1 as const,
        source: [...source], scopeSource: sourceKey, ...projectionBinding(input.binding),
        sourceContentHash: assets.sourceContentHash, assetReferencesObservationHash: assets.observationHash, capturedProofHash: proofHash,
        scopeContentHash: scope.contentHash, scopeBodyProjectionHash: scope.bodyProjectionHash,
        originalRecordHash: publicationHash(publicationJson(original)), portableRecordHash: publicationHash(publicationJson(record)),
        originalRows: rows.map(row => ({ table: row.table.name, rowId: row.original.sourceRowId, hash: root3SupplementOriginalRowHash3(raw, row) })),
        catalogId, mappings: [...mappings.values()].sort((a, b) => a.sourceUri < b.sourceUri ? -1 : a.sourceUri > b.sourceUri ? 1 : 0),
        semanticSelectionPermission: false as const, fileReadPermission: false as const }
      return { record, binding }
    } catch { return block(unmapped ? 'captured-alias-or-original-export-rule-unresolved' : 'complete-record-not-representable-by-original-export-codec') }
  } }
  return { projector, rejected, proofHash, settings }
}

/** Rebuild one complete original document with the existing exact base alias
 * and catalog rules. The returned value is data from this read only. */
export function projectCapturedBaseDocumentPortable5(input: Capsule2SettledPortableInput3<Capsule2SettledPortableBinding3>, documentId: string) {
  const { source } = input, raw = source.sourceContent
  const document = source.physical.documents.find(value => value.documentId === documentId)
  const header = graph3Rows(raw, 'documents').find(row => row.value.id === documentId)
  if (!document || !header || header.value.created_at !== document.createdAt) return null
  const blocks = graph3Rows(raw, 'blocks').filter(row => row.value.document_id === documentId)
  if (blocks.length !== document.blocks.length) return null
  const { projector } = createCapturedBasePortableProjector5(input)
  const projected = projector.project({ kind: 'document', id: documentId, parentId: document.parentId, sortOrder: document.sortOrder,
    createdAt: document.createdAt, content: { title: document.title, summary: document.summary, blocks: document.blocks } },
  ['documents', documentId, 'complete-original-protocol-record'], [header, ...blocks])
  return projected?.record.kind === 'document' ? { ...projected, record: projected.record } : null
}

export function deriveCapsule2WorkingPortableEvidence5<Binding extends Capsule2SettledPortableBinding3>(input: Capsule2SettledPortableInput3<Binding>) {
  const { source } = input, raw = source.sourceContent, assets = source.assets
  const { projector, rejected, proofHash, settings } = createCapturedBasePortableProjector5(input)
  const evidence = deriveRoot5SettledWorkingEvidence5(raw, projector, { preferProjectedCandidate: true })
  const jobs = [...evidence].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([jobSettingKey, proof]) => ({ jobSettingKey,
    jobHash: exchangeJobHash(proof.job), contextHash: proof.contextHash, binding: proof.binding, merged: proof.merged }))
  const notProven = settings.flatMap(row => {
    if (typeof row.value.key !== 'string' || !row.value.key.startsWith('sync.webdav.protocol5.exchange-job.v1.') || typeof row.value.value !== 'string') return []
    const job = validateExchangeJob(parseExchangeStored(row.value.value))
    return job.version !== 1 && job.merges?.length && !evidence.has(row.value.key)
      ? [{ jobSettingKey: row.value.key, operationId: job.request.operationId, attemptId: job.attemptId, state: 'not-proven' as const }] : []
  })
  const binding = { ...input.binding,
    sourceContentHash: assets.sourceContentHash, assetReferencesObservationHash: assets.observationHash, capturedProofHash: proofHash }
  const compact = { binding, jobs: jobs.map(job => ({ jobSettingKey: job.jobSettingKey, jobHash: job.jobHash, contextHash: job.contextHash,
    bindingHash: hash('knowbook.restore.settled-portable-job-binding.v1', job.binding),
    records: job.merged.map(item => ({ recordKey: item.recordKey, resultHash: item.provenance.resultHash })) })), notProven, rejected }
  return freezeCapsuleValue({ kind: 'capsule5-working-portable-source-evidence' as const, version: 1 as const, binding, jobs, notProven, rejected,
    evidenceHash: hash('knowbook.restore.assets5.working-portable-source-owner.v1', compact),
    rawOriginalRewritten: false as const, sourceArchiveCoverageChanged: false as const, spoolSkipPermission: false as const,
    semanticSelectionPermission: false as const, assetByteClosureComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const, installPermit: false as const })
}
