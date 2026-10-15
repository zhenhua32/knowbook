import { canBlockNestUnder } from './blockTypes'
import type { SyncedCanonicalWire, SyncedGroupWire, SyncedStableBlockDraft } from './synced-blocks'
import { assertSyncedShape, isSyncedBlockId, parseSyncedBlockPayload, SYNCED_MAX_DEPTH, SyncedValidationError,
  validateSyncedGroupWire, validateSyncedHostForest } from './syncedBlockValidation'

export interface SyncedGraphDocument { documentId: string; blocks: SyncedStableBlockDraft[] }
export interface SyncedGraphOccurrence {
  instanceId: string
  hostDocumentId: string
  groupId: string
  depth: number
  parentBlockId: string | null
  parentType: string | null
}
export type SyncedGraphOwner = { kind: 'document' | 'group'; id: string }
export interface SyncedValidatedGraph {
  documents: SyncedGraphDocument[]
  groups: SyncedGroupWire[]
  owners: Map<string, SyncedGraphOwner>
  occurrences: Map<string, SyncedGraphOccurrence[]>
}

function fail(code: 'identity' | 'binding' | 'forest', message: string): never {
  throw new SyncedValidationError(code, message)
}

/** A complete candidate graph, never a partial receive batch. Main still proves
 * retained-identity claims and authorized owner transitions in its transaction. */
export function validateSyncedWorkspaceGraph(documents: readonly SyncedGraphDocument[], groups: readonly SyncedGroupWire[]): SyncedValidatedGraph {
  if (!Array.isArray(documents) || !Array.isArray(groups)) return fail('forest', '候选工作区必须包含完整的文档和同步组列表。')
  const owners = new Map<string, SyncedGraphOwner>(), occurrences = new Map<string, SyncedGraphOccurrence[]>()
  const groupMap = new Map<string, SyncedGroupWire>(), documentIds = new Set<string>()
  const claim = (id: string, owner: SyncedGraphOwner) => {
    if (owners.has(id)) fail('identity', '候选工作区中的块身份存在重复归属。')
    owners.set(id, owner)
  }
  const checkedGroups = Array.from(groups, raw => {
    const group = validateSyncedGroupWire(raw)
    if (groupMap.has(group.id)) return fail('identity', '候选工作区中的同步组重复。')
    groupMap.set(group.id, group); occurrences.set(group.id, [])
    for (const block of group.blocks) claim(block.id, { kind: 'group', id: group.id })
    return group
  })
  const checkedDocuments = Array.from(documents, raw => {
    assertSyncedShape(raw, ['documentId', 'blocks'])
    if (!isSyncedBlockId(raw.documentId) || documentIds.has(raw.documentId)) return fail('identity', '候选工作区中的文档身份无效或重复。')
    documentIds.add(raw.documentId)
    const blocks = validateSyncedHostForest(raw.blocks), byId = new Map(blocks.map(block => [block.id, block]))
    for (const block of blocks) {
      claim(block.id, { kind: 'document', id: raw.documentId })
      if (block.type !== 'synced-block') continue
      const { groupId } = parseSyncedBlockPayload(block.content), group = groupMap.get(groupId)
      if (!group) return fail('binding', '候选工作区缺少同步引用所需的完整组正文。')
      const parent = block.parentBlockId === null ? null : byId.get(block.parentBlockId)
      // The leaf reference is transparent. Its canonical roots must obey the
      // actual host parent's role as well as the combined depth bound.
      if (parent && group.blocks.some(child => child.depth === 0 && !canBlockNestUnder(parent.type, child.type))) {
        return fail('forest', '同步正文不能放入该宿主容器。')
      }
      occurrences.get(groupId)!.push({ instanceId: block.id, hostDocumentId: raw.documentId, groupId,
        depth: block.depth, parentBlockId: block.parentBlockId, parentType: parent?.type ?? null })
    }
    return { documentId: raw.documentId, blocks }
  })
  for (const group of checkedGroups) {
    const maxDepth = group.blocks.reduce((maximum, block) => Math.max(maximum, block.depth), 0)
    if (occurrences.get(group.id)!.some(occurrence => occurrence.depth + maxDepth > SYNCED_MAX_DEPTH)) {
      // No binding CAS is invented here. Main maps positions to the actual
      // guarded instance registry when producing a mutation failure response.
      throw new SyncedValidationError('depth', '同步正文在候选工作区的引用位置超过六层。')
    }
  }
  return { documents: checkedDocuments, groups: checkedGroups, owners, occurrences }
}

export interface SyncedExpandedBlock {
  block: SyncedStableBlockDraft | SyncedCanonicalWire
  depth: number
  parent: { instanceId: string | null; blockId: string } | null
  instanceId: string | null
}

/** Iterate every occurrence, keeping identity as a tuple instead of generating
 * persistent IDs or collapsing repeated references. Consumers choose their own
 * temporary identity mapping; this function never serializes hidden metadata. */
export function* expandSyncedGraphDocument(graph: SyncedValidatedGraph, documentId: string): Generator<SyncedExpandedBlock> {
  const host = graph.documents.find(document => document.documentId === documentId)
  if (!host) return fail('identity', '找不到候选宿主文档。')
  const groups = new Map(graph.groups.map(group => [group.id, group]))
  for (const block of host.blocks) {
    if (block.type !== 'synced-block') {
      yield { block, depth: block.depth, parent: block.parentBlockId === null ? null : { instanceId: null, blockId: block.parentBlockId }, instanceId: null }
      continue
    }
    const group = groups.get(parseSyncedBlockPayload(block.content).groupId)
    if (!group) return fail('binding', '同步正文依赖发生变化。')
    for (const child of group.blocks) yield { block: child, depth: block.depth + child.depth, instanceId: block.id,
      parent: child.parentBlockId === null
        ? block.parentBlockId === null ? null : { instanceId: null, blockId: block.parentBlockId }
        : { instanceId: block.id, blockId: child.parentBlockId } }
  }
}
