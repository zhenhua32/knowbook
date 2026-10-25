import type { CompleteOriginalPackage, CompleteOriginalRootData } from './restore-knowledge-original-input-types'
import type { CoverageRootReference } from './restore-knowledge-coverage-model'
import type { Root3ReferenceResolution } from './restore-knowledge-root3-model'
import { root3Invalid } from './restore-knowledge-root3-model'
import { capsuleJson } from './restore-knowledge-capsule-model'
import { referenceContextCatalogPath } from './restore-knowledge-qualified-original-model'
import { parseCapsule2ReferenceContext, referenceContextMountedRoots, REFERENCE_CONTEXT_MAX_BYTES } from './restore-knowledge-reference-context-model'
import { readOriginalFrameText } from './restore-knowledge-original-frame-files'

const same = (a: unknown, b: unknown): boolean => capsuleJson(a) === capsuleJson(b)
/** Read the actual immutable context descriptors bound by the actual original
 * package. Raw reference order is unrelated to randomized mounted-root order. */
export async function readRoot3OriginalReferenceResolutions(actual: CompleteOriginalPackage): Promise<readonly Root3ReferenceResolution[]> {
  const result: Root3ReferenceResolution[] = []
  async function walk(node: CompleteOriginalRootData, domain: readonly CoverageRootReference[], frame: readonly string[]): Promise<void> {
    const children = new Map<string, readonly string[]>()
    for (const input of node.inputs) {
      if (input.origin.kind !== 'bound-original-bundle') continue
      if (actual.reader !== 'qualified-originals-v1') return root3Invalid('legacy原件包不能有引用上下文')
      const logicalPath = referenceContextCatalogPath(input.binding, input.origin.mountId)
      const files = actual.files.filter(file => same(file.frame, frame) && file.path === logicalPath)
      if (files.length !== 1) return root3Invalid('实际原域缺唯一引用上下文文件')
      const text = await readOriginalFrameText(actual.directory, files[0], REFERENCE_CONTEXT_MAX_BYTES)
      const context = parseCapsule2ReferenceContext(text, input.origin.bundleDescriptorHash)
      if (context.contextId !== input.origin.mountId || context.source.operationId !== input.binding.capsule.operationId
        || context.source.capsuleId !== input.binding.capsule.capsuleId
        || context.source.rawRequirementsHash !== input.binding.rawRequirementsHash) return root3Invalid('实际context不属于原输入')
      const mounted = referenceContextMountedRoots(context)
      if (!same(mounted, input.binding.requiredRoots)) return root3Invalid('实际context mounted全集与原node不一致')
      for (const parent of context.parents) {
        const matching = mounted.filter(ref => ref.namespace.kind === 'imported-bundle' && ref.namespace.mountId === parent.mountId)
        if (matching.length !== 1) return root3Invalid('实际context原父域未唯一mount')
        const mountedReference = matching[0], key = capsuleJson(mountedReference)
        if (children.has(key)) return root3Invalid('两侧context重复认领同一原域')
        const original = node.parents.find(candidate => same(candidate.reference, mountedReference))
        if (!original || !same(original.original.root, parent.originalRoot) || original.original.materialHash !== parent.materialHash)
          return root3Invalid('实际context映射与完整原件父域不同')
        children.set(key, [...frame, context.contextId, parent.mountId])
        result.push({ domain, capsule: input.binding.capsule, originalReference: parent.reference, mountedReference })
      }
    }
    if (children.size !== node.parents.length) return root3Invalid('未取得原node完整父域位置')
    for (const parent of node.parents) {
      const childFrame = children.get(capsuleJson(parent.reference))
      if (!childFrame) return root3Invalid('实际原父域位置缺失')
      await walk(parent.original, [...domain, parent.reference], childFrame)
    }
  }
  await walk(actual.original, [], [])
  return result
}
