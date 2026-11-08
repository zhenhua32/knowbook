import type { SyncedGroupWire, SyncedStableBlockDraft, SyncedStructureInput } from '../../shared/synced-blocks'
import {
  isSyncedUuid, parseSyncedBlockPayload, SyncedValidationError, validateSyncedGroupWire, validateSyncedHostForest
} from '../../shared/syncedBlockValidation'
import type { HostContent } from './synced-host-document-read'

type Command = Extract<SyncedStructureInput, { mode: 'command' }>
export type HostDetachInput = Command & { action: Extract<Command['action'], { kind: 'detach' }> }

export function isHostDetachInput(input: SyncedStructureInput): input is HostDetachInput {
  return input.mode === 'command' && input.action.kind === 'detach'
}

export interface DetachBlockId {
  from: string
  to: string
}

export interface DetachTextEdit {
  blockId: string
  from: number
  to: number
  before: string
  after: string
}

function reject(reason: string): never {
  throw new SyncedValidationError('binding', reason)
}

/** An empty Markdown destination owns its insertion point. A different
 * range ending at that point still ends before the inserted text. */
export function createDetachRangeProjection(input: readonly DetachTextEdit[]) {
  const edits = [...input].sort((left, right) => left.from - right.from), prefix = [0]
  for (const edit of edits) prefix.push(prefix[prefix.length - 1] + edit.after.length - (edit.to - edit.from))
  const beforeBoundary = (position: number) => {
    let low = 0, high = edits.length
    while (low < high) {
      const middle = (low + high) >>> 1, edit = edits[middle]
      if (edit.to < position || edit.to === position && edit.from < position) low = middle + 1
      else high = middle
    }
    return low
  }
  return (from: number, to: number) => {
    const before = beforeBoundary(from), through = beforeBoundary(to), next = edits[before]
    if (next && next.from < from || edits[through] && edits[through].from < to) return reject('解除同步的原范围与改写部分交叠。')
    const insertion = from === to && next?.from === from && next.to === to ? next.after.length : 0
    return { from: from + prefix[before], to: to + prefix[through] + insertion }
  }
}

function applyEdits(content: string, input: readonly DetachTextEdit[]): string {
  const edits = [...input].sort((left, right) => left.from - right.from || left.to - right.to)
  const pieces: string[] = []
  let position = 0
  let previousStart = -1
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < position || edit.from === previousStart
      || edit.to < edit.from || edit.to > content.length || content.slice(edit.from, edit.to) !== edit.before) {
      return reject('解除同步的链接位置与原正文不一致。')
    }
    pieces.push(content.slice(position, edit.from), edit.after)
    previousStart = edit.from
    position = edit.to
  }
  pieces.push(content.slice(position))
  return pieces.join('')
}

/** Replays the admitted allocation and source ranges from a single detach plan.
 * The transaction verifies the original group, source targets, and new identities. */
export function projectDetachedHost(working: HostContent, instanceId: string, wire: SyncedGroupWire,
  allocation: readonly DetachBlockId[], textEdits: readonly DetachTextEdit[]): HostContent {
  const group = validateSyncedGroupWire(wire)
  const position = working.blocks.findIndex(block => block.id === instanceId)
  const instance = working.blocks[position]
  if (!instance || instance.type !== 'synced-block' || parseSyncedBlockPayload(instance.content).groupId !== group.id) {
    return reject('解除同步的位置已经变化。')
  }

  const sourceIds = new Set(group.blocks.map(block => block.id))
  const occupiedIds = new Set([...working.blocks.map(block => block.id), ...sourceIds])
  const newIds = new Map<string, string>()
  for (const { from, to } of allocation) {
    if (!sourceIds.has(from) || newIds.has(from) || !isSyncedUuid(to) || occupiedIds.has(to)) {
      return reject('解除同步需要每个原块对应一个新的独立身份。')
    }
    occupiedIds.add(to)
    newIds.set(from, to)
  }
  if (newIds.size !== sourceIds.size) return reject('解除同步的块身份映射不完整。')

  const editsByBlock = new Map<string, DetachTextEdit[]>()
  for (const edit of textEdits) {
    if (!sourceIds.has(edit.blockId)) return reject('解除同步的链接改写越过了所选同步块。')
    const edits = editsByBlock.get(edit.blockId) ?? []
    edits.push(edit)
    editsByBlock.set(edit.blockId, edits)
  }
  const copies = group.blocks.map(({ createdAt: _createdAt, ...block }): SyncedStableBlockDraft => ({
    ...block,
    id: newIds.get(block.id)!,
    content: applyEdits(block.content, editsByBlock.get(block.id) ?? []),
    parentBlockId: block.parentBlockId === null ? instance.parentBlockId : newIds.get(block.parentBlockId)!,
    depth: instance.depth + block.depth
  }))
  return {
    title: working.title,
    summary: working.summary,
    blocks: validateSyncedHostForest([...working.blocks.slice(0, position), ...copies, ...working.blocks.slice(position + 1)])
  }
}
