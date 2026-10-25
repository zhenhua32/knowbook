import { readRootKnowledgeConservationContent3, type RootKnowledgeConservationPlan3 } from './restore-knowledge-root3-read'
import { content3Invalid, selectRootRestoreContent3 } from './restore-knowledge-content3-model'

export interface RootRestoreContentPlan3 { readonly kind: 'main-root-restore-content-plan' }
const plans = new WeakMap<RootRestoreContentPlan3, { knowledge: RootKnowledgeConservationPlan3; expectedHash: string }>()

/** Only a genuine Main complete-knowledge handle enters. No supplied rows,
 * side selector, source resolver, callbacks or claimed material hashes do. */
export async function prepareRootRestoreContentPlan3(knowledge: RootKnowledgeConservationPlan3) {
  const value = selectRootRestoreContent3(await readRootKnowledgeConservationContent3(knowledge))
  const plan: RootRestoreContentPlan3 = Object.freeze({ kind: 'main-root-restore-content-plan' })
  plans.set(plan, { knowledge, expectedHash: value.selectionHash })
  return Object.freeze({ plan, value })
}
/** The private registry retains only the original owner and committed hash.
 * Every use reconstructs all qualified K and both full SQL packets, including
 * policy and assets, then rebuilds the candidate. No saved rows/K are reused. */
export async function readRootRestoreContentPlan3(handle: RootRestoreContentPlan3) {
  const entry = plans.get(handle)
  if (!entry) return content3Invalid('不是实际Main完整内容规划句柄')
  const value = selectRootRestoreContent3(await readRootKnowledgeConservationContent3(entry.knowledge))
  if (value.selectionHash !== entry.expectedHash) return content3Invalid('完整来源内容或候选发生变化')
  return value
}
