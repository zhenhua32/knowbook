import type { SyncedStructureAction, SyncedStructureInput } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { serializeSyncedBlockPayload, SyncedValidationError, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import type { HostContent } from './synced-host-document-read'

export type HostInsertInput = Extract<SyncedStructureInput, { mode: 'command' }> & {
  action: Extract<SyncedStructureAction, { kind: 'insert' }>
}
export function isHostInsertInput(input: SyncedStructureInput): input is HostInsertInput {
  return input.mode === 'command' && input.action.kind === 'insert'
}
function invalid(code: 'identity' | 'forest' | 'depth', message: string): never { throw new SyncedValidationError(code, message) }

/** A command cannot silently authorize a second structural edit already in W.
 * New ordinary IDs and authored values remain W; all original placements remain. */
export function hasSyncedInsertWorkingStructure(persisted: HostContent, working: HostContent): boolean {
  const p = new Map(persisted.blocks.map(block => [block.id, block])), w = new Map(working.blocks.map(block => [block.id, block]))
  const retainedOrder = working.blocks.filter(block => p.has(block.id)).map(block => block.id)
  if (retainedOrder.length !== persisted.blocks.length || retainedOrder.some((id, index) => id !== persisted.blocks[index].id)) return false
  for (const original of persisted.blocks) {
    const current = w.get(original.id)
    if (!current || original.parentBlockId !== current.parentBlockId || original.depth !== current.depth) return false
    if (original.type === 'synced-block') {
      const originalParentType = original.parentBlockId === null ? null : p.get(original.parentBlockId)?.type
      const currentParentType = current.parentBlockId === null ? null : w.get(current.parentBlockId)?.type
      if (originalParentType !== currentParentType || canonicalSyncedPortableJson({ ...original, tags: original.tags ?? [] })
        !== canonicalSyncedPortableJson({ ...current, tags: current.tags ?? [] })) return false
    } else if (current.type === 'synced-block') return false
  }
  return working.blocks.every(block => block.type !== 'synced-block' || p.has(block.id))
}

/** Pure stable-ID planner. No DB, guessed offset, normalization, or source grant. */
export function planSyncedHostInsert(input: HostInsertInput): HostContent {
  const action = input.action, target = action.target
  if (input.hostsWorkingBefore.length !== 1 || input.hostsWorkingBefore[0].documentId !== target.documentId) {
    invalid('identity', 'insert 的唯一完整 W 必须是实际目标宿主。')
  }
  const working = input.hostsWorkingBefore[0].workingBefore, blocks = working.blocks
  const byId = new Map(blocks.map((block, index) => [block.id, { block, index }]))
  if (byId.has(action.instanceId)) invalid('identity', 'insert 不能覆盖 W 中已有身份。')
  let position = blocks.length
  if (target.parentBlockId === null) {
    if (target.depth !== 0) invalid('depth', '根位置必须具有准确 depth。')
  } else {
    const parent = byId.get(target.parentBlockId)
    if (!parent) invalid('forest', 'insert 的真实 W 父块不存在。')
    if (target.depth !== parent.block.depth + 1) invalid('depth', 'insert 的 depth 必须紧接真实父块。')
    position = parent.index + 1
    while (position < blocks.length && blocks[position].depth > parent.block.depth) position++
  }
  if (target.beforeBlockId !== null) {
    const before = byId.get(target.beforeBlockId)
    if (!before || before.block.parentBlockId !== target.parentBlockId || before.block.depth !== target.depth) {
      invalid('forest', 'insert 锚点必须是目标父块的实际直接 child。')
    }
    position = before.index
  }
  const leaf = { id: action.instanceId, type: 'synced-block', content: serializeSyncedBlockPayload({ version: 1, groupId: action.groupId }),
    checked: false, depth: target.depth, parentBlockId: target.parentBlockId }
  return { title: working.title, summary: working.summary, blocks: validateSyncedHostForest([...blocks.slice(0, position), leaf, ...blocks.slice(position)]) }
}
