import { canBlockNestUnder, isListBlockType, isTaskBlockType, isOrderedListBlockType } from './blockTypes'
import { columnStructureErrorCode } from './columnStructure'
import { assertDatabaseViewStructure } from './databaseViewBlock'
import { normalizeMarkdownFormat, type MarkdownBlockFormat } from './markdownFormat'
import { parseStrictJson } from './strictJson'
import type {
  SyncedBlockPayloadV1, SyncedCanonicalEdit, SyncedCanonicalWire, SyncedGroupWire,
  SyncedGroupSnapshot, SyncedHistoryState, SyncedInstanceGuard, SyncedInstancePosition, SyncedLinkBinding, SyncedLinkTarget,
  SyncedOriginV1, SyncedStableBlockDraft, SyncedValidationCode
} from './synced-blocks'

export const SYNCED_GROUP_MAX_BYTES = 5 * 1024 * 1024
export const SYNCED_PROJECTED_MAX_BYTES = 16 * 1024 * 1024
export const SYNCED_MAX_BLOCKS = 100_000
export const SYNCED_MAX_DEPTH = 6
export const SYNCED_BLOCK_FENCE_INFO = 'knowbook-synced-block-v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const highlights = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'])

export class SyncedValidationError extends Error {
  constructor(readonly code: SyncedValidationCode, message: string,
    readonly blockingInstances: SyncedInstanceGuard[] = []) {
    super(message)
    this.name = 'SyncedValidationError'
  }
}
function fail(code: SyncedValidationCode, message = '同步块内容或结构无效，未修改正文。'): never {
  throw new SyncedValidationError(code, message)
}
export function isSyncedUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
export function isSyncedBlockId(value: unknown): value is string { return typeof value === 'string' && !!value.trim() }
export function syncedPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
}
export function assertSyncedShape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!syncedPlainRecord(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('forest')
}
function opaque(value: unknown): string { return isSyncedBlockId(value) ? value : fail('identity') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : fail('identity') }
function text(value: unknown): string { return typeof value === 'string' ? value : fail('forest') }
function timestamp(value: unknown): string {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : fail('forest')
}

export function validateSyncedBlockPayload(value: unknown): SyncedBlockPayloadV1 {
  assertSyncedShape(value, ['version', 'groupId'])
  if (value.version !== 1) return fail('forest')
  return { version: 1, groupId: uuid(value.groupId) }
}
export function parseSyncedBlockPayload(content: string): SyncedBlockPayloadV1 {
  try { return validateSyncedBlockPayload(parseStrictJson(content, { maxBytes: 1024, maxDepth: 4 })) }
  catch (error) { if (error instanceof SyncedValidationError) throw error; return fail('forest') }
}
export function serializeSyncedBlockPayload(value: SyncedBlockPayloadV1): string {
  const payload = validateSyncedBlockPayload(value)
  return JSON.stringify({ version: payload.version, groupId: payload.groupId })
}

const blockRequired = ['id', 'type', 'content', 'checked', 'depth', 'parentBlockId'] as const
const blockOptional = ['tags', 'language', 'listStart', 'markdownFormat', 'highlight'] as const

function blockFormat(type: string, value: unknown): MarkdownBlockFormat | undefined {
  if (value === undefined) return undefined
  if (!syncedPlainRecord(value)) return fail('forest')
  const allowed = isOrderedListBlockType(type) || type === 'todo' || type === 'bulleted-list'
    ? ['listMarker', 'listLoose'] : type === 'code' ? ['codeInfo', 'emptyCode']
      : type === 'callout' ? ['calloutKind', 'calloutIcon', 'calloutTone']
        : type === 'toggle' ? ['toggleDefaultOpen'] : type === 'column' ? ['columnWeight'] : []
  if (Object.keys(value).some(key => !allowed.includes(key))) return fail('forest')
  const normalized = normalizeMarkdownFormat(type, value)
  if (Object.entries(value).some(([key, item]) => item !== undefined && item !== normalized?.[key as keyof MarkdownBlockFormat])) return fail('forest')
  return normalized
}

interface ForestOptions { canonical: boolean; wire: boolean; template?: true }
/** This validates authored relationships before any normalizer can repair them. */
function forest(value: unknown, options: ForestOptions): SyncedStableBlockDraft[] | SyncedCanonicalWire[] {
  if (Array.isArray(value) && value.length > SYNCED_MAX_BLOCKS) return fail('forest')
  return persistedForest(value, options)
}

function persistedForest(value: unknown, options: ForestOptions): SyncedStableBlockDraft[] | SyncedCanonicalWire[] {
  if (!Array.isArray(value) || options.canonical && !value.length) return fail('forest')
  const result: SyncedStableBlockDraft[] = [], ids = new Set<string>(), ancestors: SyncedStableBlockDraft[] = []
  for (const raw of value) {
    assertSyncedShape(raw, options.wire ? [...blockRequired, 'createdAt'] : blockRequired, blockOptional)
    const id = opaque(raw.id), type = text(raw.type), content = text(raw.content)
    if (!type || type !== type.trim()) return fail('forest')
    if (options.canonical && type === 'synced-block') return fail('nested-sync', '同步块内不能再次包含同步块。')
    if (ids.has(id)) return fail('identity')
    ids.add(id)
    if (typeof raw.checked !== 'boolean' || !isTaskBlockType(type) && raw.checked) return fail('forest')
    if (typeof raw.depth !== 'number' || !Number.isSafeInteger(raw.depth) || raw.depth < 0 || raw.depth > SYNCED_MAX_DEPTH) return fail('depth')
    const parentBlockId = raw.parentBlockId === null ? null : opaque(raw.parentBlockId)
    const parent = raw.depth ? ancestors[raw.depth - 1] : undefined
    const deferredReference = !options.canonical && !options.template && type === 'synced-block' && parent && isListBlockType(parent.type)
    if (raw.depth === 0 ? parentBlockId !== null
      : !parent || parent.id !== parentBlockId || !canBlockNestUnder(parent.type, type) && !deferredReference) return fail('forest')
    if (raw.tags !== undefined && (!Array.isArray(raw.tags) || Array.from(raw.tags).some(tag => typeof tag !== 'string' || !tag.trim())
      || new Set(raw.tags).size !== raw.tags.length)) return fail('forest')
    if (raw.language !== undefined && (type !== 'code' || typeof raw.language !== 'string' || !raw.language.trim()
      || raw.language !== raw.language.trim())) return fail('forest')
    if (raw.listStart !== undefined && (!isOrderedListBlockType(type) || typeof raw.listStart !== 'number'
      || !Number.isSafeInteger(raw.listStart) || raw.listStart < 0 || raw.listStart > 999_999_999)) return fail('forest')
    if (raw.highlight !== undefined && (typeof raw.highlight !== 'string' || !highlights.has(raw.highlight))) return fail('forest')
    const markdownFormat = blockFormat(type, raw.markdownFormat)
    if (type === 'synced-block' && !options.template) {
      uuid(id); parseSyncedBlockPayload(content)
      if (raw.checked || raw.language !== undefined || raw.listStart !== undefined || raw.markdownFormat !== undefined) return fail('forest')
    }
    const block: SyncedStableBlockDraft = { id, type, content, checked: raw.checked, depth: raw.depth, parentBlockId,
      ...(raw.tags === undefined ? {} : { tags: [...raw.tags as string[]] }),
      ...(raw.language === undefined ? {} : { language: raw.language as string }),
      ...(raw.listStart === undefined ? {} : { listStart: raw.listStart as number }),
      ...(markdownFormat === undefined ? {} : { markdownFormat }),
      ...(raw.highlight === undefined ? {} : { highlight: raw.highlight as string }) }
    result.push(options.wire ? { ...block, createdAt: timestamp(raw.createdAt) } as SyncedCanonicalWire : block)
    ancestors.length = raw.depth + 1; ancestors[raw.depth] = block
  }
  if (columnStructureErrorCode(result, { checkParentIds: true, allowSyncedPlaceholders: !options.canonical && !options.template })) return fail('forest')
  try { assertDatabaseViewStructure(result) } catch { return fail('forest') }
  return result
}

export function validateSyncedCanonicalEdit(value: unknown): SyncedCanonicalEdit[] {
  return forest(value, { canonical: true, wire: false }) as SyncedCanonicalEdit[]
}
export function validateSyncedCanonicalWire(value: unknown): SyncedCanonicalWire[] {
  return forest(value, { canonical: true, wire: true }) as SyncedCanonicalWire[]
}
export function validateSyncedHostForest(value: unknown): SyncedStableBlockDraft[] {
  return forest(value, { canonical: false, wire: false }) as SyncedStableBlockDraft[]
}
/** Persisted ordinary history can exceed the authored host item count. Source
 * readers must bound the complete SQL bytes before parsing its JSON. This is
 * only a data codec; the live host/wire entry points retain their own limit. */
export function validatePersistedHostForest(value: unknown): SyncedStableBlockDraft[] {
  return persistedForest(value, { canonical: false, wire: false }) as SyncedStableBlockDraft[]
}
/** Saved templates are ordinary drafts. Their synced-block text/IDs are not
 * group authority, and their parent relationships have no deferred projection.
 * Assert only: do not project a template into a validated host/group DTO. */
export function assertPersistedTemplateForest(value: unknown): void {
  persistedForest(value, { canonical: false, wire: false, template: true })
}
export function syncedCanonicalEdits(blocks: readonly SyncedCanonicalWire[]): SyncedCanonicalEdit[] {
  return validateSyncedCanonicalEdit(blocks.map(({ createdAt: _createdAt, ...block }) => block))
}

/** Projection depth is transparent: the instance consumes no extra child level. */
export function validateSyncedCanonicalProjection(blocks: readonly SyncedCanonicalEdit[], instances: readonly SyncedInstancePosition[]): void {
  if (!blocks.length) return fail('forest')
  const incompatible = instances.filter(instance => instance.depth === 0 ? instance.parentType !== null
    : instance.parentType === null || blocks.some(block => block.depth === 0 && !canBlockNestUnder(instance.parentType!, block.type)))
  if (incompatible.length) throw new SyncedValidationError('forest', '同步正文包含不能放入宿主容器的块，请先调整这些实例。',
    incompatible.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })))
  const maxDepth = blocks.reduce((depth, block) => Math.max(depth, block.depth), 0)
  const blocking = instances.filter(instance => !Number.isSafeInteger(instance.depth) || instance.depth < 0
    || instance.depth + maxDepth > SYNCED_MAX_DEPTH)
  if (blocking.length) throw new SyncedValidationError('depth', '同步块在部分引用位置超过六层，请先调整这些实例。',
    blocking.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })))
}

export function validateSyncedOrigin(value: unknown): SyncedOriginV1 {
  assertSyncedShape(value, ['version', 'documentId', 'pathAtCreation', 'firstInstanceId'])
  if (value.version !== 1) return fail('forest')
  return { version: 1, documentId: opaque(value.documentId), pathAtCreation: text(value.pathAtCreation), firstInstanceId: uuid(value.firstInstanceId) }
}
function linkTarget(value: unknown): SyncedLinkTarget {
  if (!syncedPlainRecord(value)) return fail('binding')
  const state = (): 'live' | 'missing' => value.state === 'live' || value.state === 'missing' ? value.state : fail('binding')
  if (value.kind === 'document') {
    assertSyncedShape(value, ['kind', 'id', 'state'])
    return { kind: 'document', id: opaque(value.id), state: state() }
  }
  if (value.kind === 'block') {
    assertSyncedShape(value, ['kind', 'id', 'documentId', 'state'])
    return { kind: 'block', id: opaque(value.id), documentId: value.documentId === null ? null : opaque(value.documentId), state: state() }
  }
  if (value.kind === 'heading') {
    assertSyncedShape(value, ['kind', 'documentId', 'slug', 'state'])
    return { kind: 'heading', documentId: opaque(value.documentId), slug: text(value.slug), state: state() }
  }
  if (value.kind === 'unresolved-url') {
    assertSyncedShape(value, ['kind', 'path', 'fragment'])
    return { kind: 'unresolved-url', path: text(value.path), fragment: value.fragment === null ? null : text(value.fragment) }
  }
  return fail('binding')
}
export function validateSyncedBindings(value: unknown, blocks: readonly SyncedCanonicalEdit[]): SyncedLinkBinding[] {
  if (!Array.isArray(value) || value.length > SYNCED_MAX_BLOCKS) return fail('binding')
  const byId = new Map(blocks.map(block => [block.id, block])), ranges = new Map<string, Array<[number, number]>>()
  const result = Array.from<unknown, SyncedLinkBinding>(value, raw => {
    assertSyncedShape(raw, ['blockId', 'from', 'to', 'raw', 'syntax', 'target'])
    const blockId = opaque(raw.blockId), block = byId.get(blockId)
    if (!block || typeof raw.from !== 'number' || typeof raw.to !== 'number' || !Number.isSafeInteger(raw.from)
      || !Number.isSafeInteger(raw.to) || raw.from < 0 || raw.to < raw.from || raw.to > block.content.length
      || typeof raw.raw !== 'string' || block.content.slice(raw.from, raw.to) !== raw.raw
      || raw.syntax !== 'markdown' && raw.syntax !== 'wiki'
      || raw.to === raw.from && (raw.syntax !== 'markdown' || raw.raw !== '')) return fail('binding')
    const used = ranges.get(blockId) ?? []
    used.push([raw.from, raw.to]); ranges.set(blockId, used)
    return { blockId, from: raw.from, to: raw.to, raw: raw.raw, syntax: raw.syntax, target: linkTarget(raw.target) }
  })
  for (const used of ranges.values()) {
    used.sort((first, second) => first[0] - second[0] || first[1] - second[1])
    // An actual empty Markdown destination has a parser-proven insertion point.
    // Reject duplicate points as well as ordinary interval overlaps. Main still
    // proves exact AST coverage; an arbitrary empty substring is not authority.
    for (let index = 1; index < used.length; index++) if (used[index][0] < used[index - 1][1]
      || used[index][0] === used[index - 1][0]) return fail('binding')
  }
  return result
}

/** Main must separately prove parsed link targets and portable asset bytes. */
export function validateSyncedGroupWire(value: unknown): SyncedGroupWire {
  assertSyncedShape(value, ['kind', 'id', 'creationId', 'createdAt', 'origin', 'bindings', 'blocks'])
  if (value.kind !== 'synced-group') return fail('forest')
  const blocks = validateSyncedCanonicalWire(value.blocks)
  return { kind: 'synced-group', id: uuid(value.id), creationId: uuid(value.creationId), createdAt: timestamp(value.createdAt),
    origin: validateSyncedOrigin(value.origin), bindings: validateSyncedBindings(value.bindings, blocks), blocks }
}
export function parseSyncedGroupWire(content: string): SyncedGroupWire {
  try { return validateSyncedGroupWire(parseStrictJson(content, { maxBytes: SYNCED_GROUP_MAX_BYTES, maxDepth: 32 })) }
  catch (error) { if (error instanceof SyncedValidationError) throw error; return fail('forest') }
}

export function validateSyncedHistoryState(value: unknown): SyncedHistoryState {
  assertSyncedShape(value, ['cursor', 'undoToken', 'redoToken'])
  return { cursor: uuid(value.cursor), undoToken: value.undoToken === null ? null : uuid(value.undoToken),
    redoToken: value.redoToken === null ? null : uuid(value.redoToken) }
}

/** Local snapshots may contain long localized file URLs; portable byte proof is a separate step. */
export function validateSyncedGroupSnapshot(value: unknown): SyncedGroupSnapshot {
  assertSyncedShape(value, ['groupId', 'creationId', 'createdAt', 'revision', 'topologyRevision', 'origin', 'bindings', 'blocks',
    'instances', 'history', 'maxRelativeDepth'])
  const blocks = validateSyncedCanonicalWire(value.blocks)
  if (!Array.isArray(value.instances) || value.instances.length > SYNCED_MAX_BLOCKS) return fail('binding')
  const ids = new Set<string>()
  const instances = Array.from<unknown, SyncedInstancePosition>(value.instances, raw => {
    assertSyncedShape(raw, ['instanceId', 'hostDocumentId', 'bindingVersion', 'depth', 'parentBlockId', 'parentType'])
    const instanceId = uuid(raw.instanceId)
    if (ids.has(instanceId)) return fail('identity')
    ids.add(instanceId)
    if (typeof raw.depth !== 'number' || !Number.isSafeInteger(raw.depth) || raw.depth < 0 || raw.depth > SYNCED_MAX_DEPTH) return fail('depth')
    const parentBlockId = raw.parentBlockId === null ? null : opaque(raw.parentBlockId)
    const parentType = raw.parentType === null ? null : text(raw.parentType)
    if (raw.depth === 0 ? parentBlockId !== null || parentType !== null : parentBlockId === null || parentType === null
      || !isListBlockType(parentType) && !['callout', 'toggle', 'column'].includes(parentType)) return fail('forest')
    return { instanceId, hostDocumentId: opaque(raw.hostDocumentId), bindingVersion: uuid(raw.bindingVersion), depth: raw.depth, parentBlockId, parentType }
  })
  const maxRelativeDepth = blocks.reduce((maximum, block) => Math.max(maximum, block.depth), 0)
  if (value.maxRelativeDepth !== maxRelativeDepth) return fail('depth')
  validateSyncedCanonicalProjection(blocks, instances)
  return { groupId: uuid(value.groupId), creationId: uuid(value.creationId), createdAt: timestamp(value.createdAt),
    revision: uuid(value.revision), topologyRevision: uuid(value.topologyRevision), origin: validateSyncedOrigin(value.origin),
    bindings: validateSyncedBindings(value.bindings, blocks), blocks, instances, history: validateSyncedHistoryState(value.history), maxRelativeDepth }
}
