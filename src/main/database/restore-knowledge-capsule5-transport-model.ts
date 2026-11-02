import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import type { Capsule2AssetArchiveManifest } from './restore-knowledge-capsule2-asset-archive'
import { parseWorkingOriginals5, type WorkingOriginalsPointer5 } from './restore-knowledge-capsule5-working-model'
import { originBundleInvalid as bad, type OriginBundleFile } from './restore-knowledge-origin-bundle-model'

/** Runtime original bytes. These texts are never embedded in a descriptor or
 * its hash. Every full inventory call verifies them against that side's pointer. */
export interface TransportWorkingTexts5 { readonly source?: string; readonly current?: string }
export interface TransportWorkingIndex5 {
  readonly side: 'source' | 'current'; readonly path: string; readonly pointer: WorkingOriginalsPointer5
}
export function capsule5WorkingIndex(archive: Capsule2AssetArchiveManifest, assets: string) {
  return archive.version === 5 ? freezeCapsuleValue({ path: assets + '/contexts/manifest.json', pointer: archive.workingOriginals }) : null
}
export function capsule5TransportFiles(archive: Capsule2AssetArchiveManifest, assets: string, workingText?: string): readonly OriginBundleFile[] {
  const index = capsule5WorkingIndex(archive, assets)
  if (!index) {
    if (workingText !== undefined) return bad('非working5原件不能借用另一side的索引')
    return []
  }
  if (workingText === undefined) return bad('working5完整运输清单缺本side实际索引原字节')
  const manifest = parseWorkingOriginals5(workingText, index.pointer)
  if (workingText !== capsuleJson(manifest) + '\n' || archive.version !== 5
    || manifest.sourceContentHash !== archive.sourceContentHash
    || capsuleJson(manifest.baseProjection) !== capsuleJson(archive.baseProjection)
    || manifest.workingEvidenceHash !== archive.assetScopeSupplement.workingEvidenceHash
    || manifest.observation.hash !== archive.assetScopeSupplement.observationHash
    || manifest.observation.scopeCount !== archive.assetScopeSupplement.scopeCount
    || manifest.observation.unsupportedHolders !== archive.assetScopeSupplement.unsupportedHolders.count) return bad('working5运输索引不是本side来源、base及观察承诺的准确原字节')
  return freezeCapsuleValue([{ path: index.path, ...index.pointer.manifestFile },
    ...manifest.files.map(file => ({ path: assets + '/contexts/files/' + file.sha256, ...file }))])
}
