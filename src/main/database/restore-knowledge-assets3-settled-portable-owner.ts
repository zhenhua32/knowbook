import { readSealedCapsule2SourceInputs, assertSealedCapsule2SourceOriginalBytes, readSealedCapsule2SourceBaseProjection4, readSealedCapsule2SourceInputsWithWorking5,
  type SealedCapsule2Source } from './restore-knowledge-capsule2-source-seal'
import { deriveCapsule2SettledPortableEvidence3 } from './restore-knowledge-assets3-settled-portable-derive'

export interface Capsule2SettledPortableSource3 { readonly kind: 'main-capsule2-settled-portable-source' }
type Input = Awaited<ReturnType<typeof readSealedCapsule2SourceInputs>>
type Body = ReturnType<typeof derive>
interface Saved { source: SealedCapsule2Source; materialHash: string; evidenceHash: string }
const owners = new WeakMap<Capsule2SettledPortableSource3, Saved>()
const fail = (reason: string): never => { throw new Error('settled portable owner无效：' + reason + '；不授spool跳过、资产读写、语义选择或安装权。') }
function derive(input: Input, base?: Pick<Awaited<ReturnType<typeof readSealedCapsule2SourceBaseProjection4>>, 'baseProof'>) {
  const packet = input.value, archive = packet.assetArchive
  if (archive.version === 1) return fail('原archive1没有capture-time file URI权属，不升级旧资料')
  const referenceCapture = (archive.version === 4 ||archive.version===5) ? { version: 2 as const, sourceContentHash: archive.sourceContentHash,
    workspaceHistoryObservationHash: archive.workspaceHistoryObservationHash, assetReferencesObservationHash: archive.assetReferencesObservationHash,
    referenceUris: archive.referenceUris, tree: archive.tree,
    referenceProvenance: (base ?? fail('archive4缺同genuine source registry导出的base proof')).baseProof } : archive
  return deriveCapsule2SettledPortableEvidence3({ source: packet.source, referenceCapture,
    binding: { sourceManifestHash: input.info.manifestHash, sourceMaterialHash: packet.materialHash, assetArchiveHash: packet.assetArchiveHash } },
    (archive.version === 4 ||archive.version===5) ? { preferProjectedCandidate: true } : undefined)
}

async function capture(source: SealedCapsule2Source): Promise<Body> {
  // Registry lookup occurs inside this genuine source seam before it reads any
  // caller object properties; no returned packet can substitute for the owner.
  const { working: capturedWorking, ...input } = await readSealedCapsule2SourceInputsWithWorking5(source)
  const base = input.value.assetArchive.version === 4 ? await readSealedCapsule2SourceBaseProjection4(source)
    : input.value.assetArchive.version === 5 ? await (async () => {
      const working = capturedWorking
      if (!working) return fail('archive5缺同genuine source registry导出的working base proof')
      return { baseProof: working.baseCommitment.referenceProvenance }
    })() : undefined
  const value = derive(input, base)
  await assertSealedCapsule2SourceOriginalBytes(source)
  return value
}
export async function prepareCapsule2SettledPortableSource3(source: SealedCapsule2Source) {
  const value = await capture(source), owner: Capsule2SettledPortableSource3 = Object.freeze({ kind: 'main-capsule2-settled-portable-source' })
  owners.set(owner, { source, materialHash: value.binding.sourceMaterialHash, evidenceHash: value.evidenceHash })
  return Object.freeze({ owner, value })
}
export async function readCapsule2SettledPortableSource3(owner: Capsule2SettledPortableSource3): Promise<Body> {
  const saved = owners.get(owner)
  if (!saved) return fail('不是genuine sealed-source派生的私有owner')
  const value = await capture(saved.source)
  if (value.binding.sourceMaterialHash !== saved.materialHash || value.evidenceHash !== saved.evidenceHash) return fail('重读真实来源或完整derived evidence不同')
  return value
}
/** Identity-only future composition seam; no hash/DTO substitutes for the
 * exact genuine source used to mint this owner. Cold code mints a new pair. */
export function assertCapsule2SettledPortableSourceOwner3(owner: Capsule2SettledPortableSource3, source: SealedCapsule2Source): void {
  const saved = owners.get(owner)
  if (!saved || saved.source !== source) return fail('owner不属于该精确genuine SealedSource')
}
