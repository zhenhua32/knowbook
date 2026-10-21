import { capsuleInvalid, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCertifiedCapsuleKnowledge, type CertifiedCapsuleKnowledge } from './restore-knowledge-capsule-read'
import { knowledgeHash, unionKnowledgePayloadDiagnostics, type KnowledgeUnionDiagnostic } from './restore-knowledge-payload-model'

/** Private process identity for a complete union of original per-capsule evidence.
 * This is neither accepted SQL coverage nor a writer/publisher/install permit. */
export interface CertifiedKnowledgeUnion { readonly kind: 'certified-durable-sql-knowledge-union' }
type Entry = { inputs: readonly CertifiedCapsuleKnowledge[]; diagnostic: KnowledgeUnionDiagnostic; payloadHash: string }
const unions = new WeakMap<CertifiedKnowledgeUnion, Entry>()

/** Immutable per-capsule reads only. One bounded batch settles, including all
 * finally FD closes, before original-order failure or the next batch/phase.
 * Returned slots follow input indices, never callback completion order. */
async function settledPayloadInputMap<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<Awaited<R>[]> {
  const values: Awaited<R>[] = []
  for (let from = 0; from < items.length; from += 4) {
    const results = await Promise.allSettled(items.slice(from, from + 4).map(item => Promise.resolve().then(() => read(item))))
    for (let offset = 0; offset < results.length; offset++) {
      const result = results[offset]
      if (result.status === 'rejected') throw result.reason
      values[from + offset] = result.value
    }
  }
  return values
}

export async function unionCertifiedCapsuleKnowledge(input: readonly CertifiedCapsuleKnowledge[]): Promise<CertifiedKnowledgeUnion> {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || !input.length)
    return capsuleInvalid('K union须有真实认证payload原件，不能以null/empty冒认证')
  if (input.length > 1024 || Reflect.ownKeys(input).length !== input.length + 1)
    return capsuleInvalid('K union原件集合超预算或字段不是准确闭集')
  const inputs: CertifiedCapsuleKnowledge[] = []
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index)
    if (!descriptor?.enumerable || !('value' in descriptor)) return capsuleInvalid('K union输入有hole/accessor或非enumerable元素')
    inputs.push(descriptor.value as CertifiedCapsuleKnowledge)
  }
  const payloads = await settledPayloadInputMap(inputs, readCertifiedCapsuleKnowledge)
  const diagnostic = unionKnowledgePayloadDiagnostics(payloads)
  // No live SQL transaction crosses these awaits. Each input is an immutable
  // source capsule and is freshly checked again immediately before minting.
  await settledPayloadInputMap(inputs, readCertifiedCapsuleKnowledge)
  const handle: CertifiedKnowledgeUnion = Object.freeze({ kind: 'certified-durable-sql-knowledge-union' })
  unions.set(handle, { inputs: Object.freeze(inputs), diagnostic, payloadHash: knowledgeHash('knowbook.knowledge.union.v1', diagnostic) })
  return handle
}

export async function readCertifiedKnowledgeUnion(handle: CertifiedKnowledgeUnion): Promise<KnowledgeUnionDiagnostic> {
  const entry = unions.get(handle)
  if (!entry) return capsuleInvalid('不是Main完整K原件union句柄')
  await settledPayloadInputMap(entry.inputs, readCertifiedCapsuleKnowledge)
  return entry.diagnostic
}

export async function diagnoseCertifiedKnowledgeUnion(handle: CertifiedKnowledgeUnion) {
  const diagnostic = await readCertifiedKnowledgeUnion(handle), entry = unions.get(handle)!
  return freezeCapsuleValue({ kind: 'durable-sql-knowledge-union-summary' as const, version: 1 as const, payloadHash: entry.payloadHash,
    capsules: diagnostic.payloads.length, groups: diagnostic.groups.length, permanentDenials: diagnostic.permanentDenials.length,
    exposureRecords: diagnostic.exposures.length, observations: diagnostic.observations.length,
    mappingAmbiguities: diagnostic.mappingAmbiguities.length, historicalPrimaryRowDifferences: diagnostic.historicalPrimaryRowDifferences.length,
    acceptedCoverage: false as const, permit: false as const })
}
