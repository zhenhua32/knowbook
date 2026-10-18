import type { SyncedCanonicalWire, SyncedGroupWire, SyncedLinkBinding, SyncedLinkTarget, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import type { WebDavSyncMergeChoice, WebDavSyncMergePart } from '../../shared/webdav-sync'
import { isSyncedBlockId, SyncedValidationError, validateSyncedCanonicalWire, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { COLUMN_WEIGHT_TOTAL, isColumnWeight } from '../../shared/columns'
import { collectSyncedBindingOccurrences } from '../database/synced-block-links'
import { createUnchangedMergeRangeProjector, MERGE_DIFF_BUDGET_CELLS, mergeText, type DiffBudget } from './merge-kernel'
import { publicationInvalid, publicationJson, SyncedPublicationError } from './synced-publication-model'
import { syncedProtocol5RecordKey, validateSyncedProtocol5Record, type SyncedProtocol5Record } from './synced-protocol5-model'

export type SyncedRecordMergeChoice = WebDavSyncMergeChoice
export type SyncedRecordMergePart = WebDavSyncMergePart
export interface SyncedRecordMergeResult {
  /** Data preview only. Never publish or install while unresolved is nonempty. */
  record: SyncedProtocol5Record
  conflicts: SyncedRecordMergePart[]
  unresolved: SyncedRecordMergePart[]
}
type LiveRecord = SyncedPortableHostRecord | SyncedGroupWire
type Block = SyncedStableBlockDraft | SyncedCanonicalWire
const properties = ['checked', 'tags', 'language', 'listStart', 'markdownFormat', 'highlight'] as const
const same = (left: unknown, right: unknown): boolean => left === undefined || right === undefined
  ? left === right : publicationJson(left) === publicationJson(right)
const display = (value: unknown): string => value === undefined ? '（未设置）' : typeof value === 'string' ? value : publicationJson(value)
const live = (value: SyncedProtocol5Record): value is LiveRecord => value.kind === 'document' || value.kind === 'synced-group'

function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return publicationInvalid('合并输入不是普通数据对象。')
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return publicationInvalid('合并输入含符号字段。')
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return publicationInvalid('合并输入含访问器或隐藏字段。')
    result[key] = descriptor.value
  }
  return result
}
function choicesData(value: unknown): Record<string, SyncedRecordMergeChoice> {
  const result: Record<string, SyncedRecordMergeChoice> = Object.create(null)
  for (const [id, raw] of Object.entries(dataObject(value))) {
    const choice = dataObject(raw), keys = Object.keys(choice).sort()
    if ((choice.choice === 'local' || choice.choice === 'remote') && same(keys, ['choice'])) result[id] = { choice: choice.choice }
    else if (choice.choice === 'custom' && typeof choice.text === 'string' && same(keys, ['choice', 'text'])) result[id] = { choice: 'custom', text: choice.text }
    else return publicationInvalid('合并选择不是准确的有限形状。')
  }
  return result
}
function readRecord(value: SyncedProtocol5Record): SyncedProtocol5Record {
  const outer = dataObject(value)
  const key = outer.kind === 'databases' ? 'databases' : typeof outer.id === 'string'
    ? (outer.kind === 'synced-group' || outer.kind === 'synced-group-deleted' ? 'group:' : 'doc:') + outer.id
    : publicationInvalid('合并原记录缺少稳定身份。')
  return validateSyncedProtocol5Record(value, key)
}
function three<T>(base: T, local: T, remote: T): { matched: true; value: T } | { matched: false } {
  return same(local, remote) ? { matched: true, value: local } : same(base, local) ? { matched: true, value: remote }
    : same(base, remote) ? { matched: true, value: local } : { matched: false }
}
function skeleton(blocks: readonly Block[]): unknown {
  return blocks.map(block => ({ id: block.id, type: block.type, depth: block.depth, parentBlockId: block.parentBlockId,
    emptyCode: block.markdownFormat?.emptyCode === true, ...('createdAt' in block ? { createdAt: block.createdAt } : {}) }))
}
function validForest(blocks: Block[], group: boolean): boolean {
  try { if (group) validateSyncedCanonicalWire(blocks); else validateSyncedHostForest(blocks); return true }
  catch (cause) { if (cause instanceof SyncedValidationError) return false; throw cause }
}
type ColumnLayout = Array<{ id: string; weight: number }>
function columnLayouts(blocks: readonly Block[]): Map<string, ColumnLayout> {
  const result = new Map<string, ColumnLayout>()
  for (const block of blocks) {
    if (block.type === 'columns') result.set(block.id, [])
    else if (block.type === 'column') result.get(block.parentBlockId!)!.push({ id: block.id, weight: block.markdownFormat!.columnWeight! })
  }
  return result
}

/** Preserve complete original physical Keys and atomic targets; never resolve today's URL. */
function mergeBindings(base: SyncedGroupWire, local: SyncedGroupWire, remote: SyncedGroupWire,
  blocks: SyncedCanonicalWire[], budget: DiffBudget): SyncedLinkBinding[] | null {
  const occurrences = collectSyncedBindingOccurrences(base.origin, blocks), finalBlocks = new Map(blocks.map(block => [block.id, block]))
  const occurrenceKey = (item: { blockId: string; raw: string; syntax: string }): string => publicationJson([item.blockId, item.raw, item.syntax])
  const destinationKeys = new Set(occurrences.map(occurrenceKey))
  const sides = [base, local, remote].map(group => {
    const sourceBlocks = new Map(group.blocks.map(block => [block.id, block]))
    const projectors = new Map<string, ReturnType<typeof createUnchangedMergeRangeProjector>>()
    const mapped = new Map<string, SyncedLinkBinding[]>(), ambiguous = new Set<string>()
    for (const binding of group.bindings) {
      const signature = occurrenceKey(binding)
      if (!destinationKeys.has(signature)) continue
      const source = sourceBlocks.get(binding.blockId), destination = finalBlocks.get(binding.blockId)
      if (!source || !destination) continue
      if (!projectors.has(binding.blockId)) projectors.set(binding.blockId, createUnchangedMergeRangeProjector(source.content, destination.content, budget))
      const range = projectors.get(binding.blockId)?.(binding)
      if (!range) { ambiguous.add(signature); continue }
      const key = publicationJson([binding.blockId, range.from, range.to, binding.raw, binding.syntax])
      const list = mapped.get(key) ?? []; list.push(binding); mapped.set(key, list)
    }
    return { mapped, ambiguous }
  })
  const result: SyncedLinkBinding[] = []
  for (const occurrence of occurrences) {
    const signature = occurrenceKey(occurrence)
    if (sides.some(side => side.ambiguous.has(signature))) return null
    const key = publicationJson([occurrence.blockId, occurrence.from, occurrence.to, occurrence.raw, occurrence.syntax])
    const candidates = sides.map(side => side.mapped.get(key) ?? [])
    if (candidates.some(list => list.length > 1)) return null
    const [before, left, right] = candidates.map(list => list[0]?.target)
    const chosen = three<SyncedLinkTarget | undefined>(before, left, right)
    if (!chosen.matched || !chosen.value) return null
    const { url: _url, ...physicalKey } = occurrence
    result.push({ ...physicalKey, target: structuredClone(chosen.value) })
  }
  return result
}

/** Pure semantic merge; Main must separately authenticate real B and both current sides. */
export function mergeSyncedProtocol5Record(baseValue: SyncedProtocol5Record, localValue: SyncedProtocol5Record,
  remoteValue: SyncedProtocol5Record, choices: Readonly<Record<string, SyncedRecordMergeChoice>> = {}): SyncedRecordMergeResult | null {
  const selected = choicesData(choices), before = readRecord(baseValue), left = readRecord(localValue), right = readRecord(remoteValue)
  if (!live(before) || !live(left) || !live(right) || left.kind !== before.kind || right.kind !== before.kind
    || left.id !== before.id || right.id !== before.id || left.createdAt !== before.createdAt || right.createdAt !== before.createdAt) return null
  if (before.kind === 'synced-group' && (left.kind !== 'synced-group' || right.kind !== 'synced-group'
    || before.creationId !== left.creationId || before.creationId !== right.creationId
    || !same(before.origin, left.origin) || !same(before.origin, right.origin))) return null
  const base = before, local = left, remote = right
  const group = base.kind === 'synced-group', budget: DiffBudget = { cells: MERGE_DIFF_BUDGET_CELLS }
  const conflicts: SyncedRecordMergePart[] = [], unresolved: SyncedRecordMergePart[] = []
  type Part = Omit<SyncedRecordMergePart, 'basePreview' | 'localPreview' | 'remotePreview'>
  function resolve<T>(part: Part, original: T, a: T, b: T, valid: (value: T) => boolean = () => true): T {
    const entry = { ...part, basePreview: display(original), localPreview: display(a), remotePreview: display(b) }
    conflicts.push(entry)
    const choice = selected[part.id]
    let value = a
    if (choice?.choice === 'local') value = a
    else if (choice?.choice === 'remote') value = b
    else if (choice?.choice === 'custom') {
      if (!part.canEditText) return publicationInvalid('该合并字段不接受自定义文字。')
      value = choice.text as T
    } else { unresolved.push(entry); return a }
    if (!valid(value)) { unresolved.push(entry); return a }
    return value
  }
  function scalar<T>(part: Part, original: T, a: T, b: T, valid: (value: T) => boolean = () => true): T {
    const automatic = three(original, a, b)
    return automatic.matched && valid(automatic.value) ? automatic.value : resolve(part, original, a, b, valid)
  }
  function text(part: Part, original: string, a: string, b: string): string {
    const automatic = mergeText(original, a, b, budget)
    return automatic === null ? resolve(part, original, a, b) : automatic
  }
  let metadata: Pick<SyncedPortableHostRecord, 'parentId' | 'sortOrder'> & { title: string; summary: string } | null = null
  if (base.kind === 'document' && local.kind === 'document' && remote.kind === 'document') {
    metadata = {
      title: scalar({ id: 'title', field: 'title', canEditText: true }, base.content.title, local.content.title, remote.content.title,
        value => Boolean(value.trim()) && value === value.trim() && value.length <= 500 && !/[/\\\x00-\x1f]/.test(value) && !['.', '..'].includes(value)),
      summary: text({ id: 'summary', field: 'summary', canEditText: true }, base.content.summary, local.content.summary, remote.content.summary),
      parentId: scalar({ id: 'parentId', field: 'parentId', canEditText: false }, base.parentId, local.parentId, remote.parentId,
        value => value === null || isSyncedBlockId(value) && value !== base.id),
      sortOrder: scalar({ id: 'sortOrder', field: 'sortOrder', canEditText: false }, base.sortOrder, local.sortOrder, remote.sortOrder,
        value => Number.isSafeInteger(value) && value >= 0)
    }
  }
  const forest = (record: LiveRecord): Block[] => record.kind === 'document' ? record.content.blocks : record.blocks
  const original = forest(base), a = forest(local), b = forest(remote)
  const conflictStart = conflicts.length, unresolvedStart = unresolved.length
  let bindings: SyncedLinkBinding[] = [], forestSelected = false
  const forestData = (record: LiveRecord): { blocks: Block[]; bindings: SyncedLinkBinding[] } => ({ blocks: forest(record), bindings: record.kind === 'synced-group' ? record.bindings : [] })
  const chooseForest = (): Block[] => {
    conflicts.length = conflictStart; unresolved.length = unresolvedStart; forestSelected = true
    const choice = resolve({ id: 'blocks', field: 'blocks', canEditText: false }, forestData(base), forestData(local), forestData(remote))
    bindings = structuredClone(choice.bindings)
    return structuredClone(choice.blocks)
  }
  let blocks: Block[]
  if (!same(skeleton(original), skeleton(a)) || !same(skeleton(original), skeleton(b))) blocks = chooseForest()
  else if (same(a, b)) blocks = structuredClone(a)
  else if (same(original, a)) blocks = structuredClone(b)
  else if (same(original, b)) blocks = structuredClone(a)
  else {
    const layouts = [original, a, b].map(columnLayouts), weights = new Map<string, number>()
    for (const [id, layout] of layouts[0]) {
      const valid = (value: ColumnLayout): boolean => value.length === layout.length
        && value.every((column, index) => column.id === layout[index].id && isColumnWeight(column.weight))
        && value.reduce((sum, column) => sum + column.weight, 0) === COLUMN_WEIGHT_TOTAL
      const value = scalar({ id: `block:${id}:column-layout`, field: 'block-property', blockId: id, property: 'columnWeights', canEditText: false },
        layout, layouts[1].get(id)!, layouts[2].get(id)!, valid)
      for (const column of value) weights.set(column.id, column.weight)
    }
    blocks = original.map((block, index) => {
      const localBlock = a[index], remoteBlock = b[index]
      const atom = block.type === 'database-view' || block.type === 'synced-block'
      const part: Part = { id: `block:${block.id}:content`, field: 'block-content', blockId: block.id, canEditText: !atom }
      const content = atom ? scalar(part, block.content, localBlock.content, remoteBlock.content)
        : text(part, block.content, localBlock.content, remoteBlock.content)
      const merged: Block = { ...block, content }
      for (const property of properties) {
        if (block.type === 'column' && property === 'markdownFormat') { merged.markdownFormat = { columnWeight: weights.get(block.id)! }; continue }
        const value = scalar({ id: `block:${block.id}:${property}`, field: 'block-property', blockId: block.id, property, canEditText: false },
          block[property], localBlock[property], remoteBlock[property])
        if (value === undefined) delete merged[property]
        else Object.assign(merged, { [property]: structuredClone(value) })
      }
      return merged
    })
  }
  if (!validForest(blocks, group)) blocks = chooseForest()
  if (group && !forestSelected) {
    const merged = mergeBindings(base as SyncedGroupWire, local as SyncedGroupWire, remote as SyncedGroupWire, blocks as SyncedCanonicalWire[], budget)
    if (merged) bindings = merged
    else blocks = chooseForest()
  }
  function finish(): SyncedProtocol5Record {
    const record: LiveRecord = base.kind === 'synced-group' ? { ...base, blocks: blocks as SyncedCanonicalWire[], bindings }
      : { ...base, parentId: metadata!.parentId, sortOrder: metadata!.sortOrder,
        content: { title: metadata!.title, summary: metadata!.summary, blocks } }
    return validateSyncedProtocol5Record(record, syncedProtocol5RecordKey(record))
  }
  let record: SyncedProtocol5Record
  try { record = finish() }
  catch (cause) {
    if (!(cause instanceof SyncedValidationError) && !(cause instanceof SyncedPublicationError)) throw cause
    if (forestSelected) return null
    blocks = chooseForest()
    try { record = finish() }
    catch (error) { if (error instanceof SyncedValidationError || error instanceof SyncedPublicationError) return null; throw error }
  }
  const known = new Set(conflicts.map(part => part.id))
  if (Object.keys(selected).some(id => !known.has(id))) return publicationInvalid('合并选择包含未知或已经自动解决的字段。')
  return { record, conflicts, unresolved }
}
