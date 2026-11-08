import type { SyncedGroupWire, SyncedInstanceGuard } from '../../shared/synced-blocks'
import { validateSyncedBindingKey } from '../../shared/syncedBlockInputs'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, syncedPlainRecord, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { canonicalSyncedPortableJson as encode } from '../../shared/syncedBlockPortable'
import { hostTime, type HostContent } from './synced-host-document-read'
import { createDetachRangeProjection, projectDetachedHost, type DetachBlockId, type DetachTextEdit, type HostDetachInput } from './synced-host-detach-plan'
import { planDetachDefinitionNamespace } from './synced-host-detach-namespace'
import type { DetachCopiedLink, DetachSourceProjection } from './synced-host-detach-links'
import type { DetachHeadingProof } from './synced-host-detach-heading'
import { parseDetachedCanonicalDestination } from './synced-host-detach-canonical'

export interface HostDetachEvidence {
  revision: string
  wire: SyncedGroupWire
  survivors: SyncedInstanceGuard[]
  allocation: DetachBlockId[]
  projection: DetachSourceProjection
}

function invalid(): never { throw new Error('解除同步原件与完整宿主、同步组或副本链接不一致。') }
const id = (value: unknown) => isSyncedBlockId(value) ? value : invalid()
const uuid = (value: unknown) => isSyncedUuid(value) ? value : invalid()
const string = (value: unknown) => typeof value === 'string' ? value : invalid()
const offset = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()

function list<T>(value: unknown, read: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return invalid()
  const items = value.map(read)
  if (new Set(items.map(key)).size !== items.length) return invalid()
  return items
}

function guard(value: unknown): SyncedInstanceGuard {
  assertSyncedShape(value, ['instanceId', 'hostDocumentId', 'bindingVersion'])
  return { instanceId: uuid(value.instanceId), hostDocumentId: id(value.hostDocumentId), bindingVersion: uuid(value.bindingVersion) }
}

function readLink(value: unknown): DetachCopiedLink {
  assertSyncedShape(value, ['source', 'destination', 'url', 'resolved'])
  const { resolved } = value
  assertSyncedShape(resolved, ['target', 'documentCreatedAt', 'blockCreatedAt'], ['heading', 'canonical'])
  const { target } = resolved
  const source = validateSyncedBindingKey(value.source), destination = validateSyncedBindingKey(value.destination), url = string(value.url)
  if (syncedPlainRecord(target) && target.kind === 'unresolved-url') {
    assertSyncedShape(target, ['kind', 'path', 'fragment'])
    if (resolved.documentCreatedAt !== null || resolved.blockCreatedAt !== null || resolved.heading !== undefined || resolved.canonical !== undefined) return invalid()
    return { source, destination, url, resolved: { target: { kind: 'unresolved-url', path: string(target.path),
      fragment: target.fragment === null ? null : string(target.fragment) }, documentCreatedAt: null, blockCreatedAt: null } }
  }
  assertSyncedShape(target, ['kind', 'state'], ['id', 'documentId', 'slug'])
  if (target.state !== 'live') return invalid()
  if (resolved.canonical !== undefined) {
    assertSyncedShape(resolved.canonical, ['original'])
    const { original } = resolved.canonical
    assertSyncedShape(original, ['operationId', 'historyToken'])
    const address = parseDetachedCanonicalDestination(source.syntax, url)
    if (source.syntax !== destination.syntax || target.kind !== 'block' || target.slug !== undefined
      || target.documentId !== null || resolved.documentCreatedAt !== null || resolved.heading !== undefined
      || !address || target.id !== address.blockId || resolved.blockCreatedAt !== address.blockCreatedAt) return invalid()
    return { source, destination, url, resolved: { target: { kind: 'block', id: address.blockId, documentId: null, state: 'live' },
      documentCreatedAt: null, blockCreatedAt: address.blockCreatedAt,
      canonical: { original: { operationId: uuid(original.operationId), historyToken: uuid(original.historyToken) } } } }
  }
  let typed: Exclude<DetachCopiedLink['resolved']['target'], { kind: 'unresolved-url' }>
  let heading: DetachHeadingProof | undefined
  if (target.kind === 'document' && target.documentId === undefined && target.slug === undefined && resolved.heading === undefined && resolved.blockCreatedAt === null)
    typed = { kind: 'document', id: id(target.id), state: 'live' }
  else if (target.kind === 'block' && target.slug === undefined && resolved.heading === undefined && typeof resolved.blockCreatedAt === 'string')
    typed = { kind: 'block', id: id(target.id), documentId: id(target.documentId), state: 'live' }
  else if (target.kind === 'heading' && target.id === undefined && typeof resolved.blockCreatedAt === 'string') {
    assertSyncedShape(resolved.heading, ['original', 'headingKey', 'blockId'])
    const { original, headingKey, blockId } = resolved.heading
    assertSyncedShape(original, ['kind', 'operationId', 'companionHash'])
    if (original.kind !== 'heading-create-birth' && original.kind !== 'heading-title-transition'
      || typeof original.companionHash !== 'string' || !/^[a-f0-9]{64}$/.test(original.companionHash)) return invalid()
    heading = { original: { kind: original.kind, operationId: uuid(original.operationId), companionHash: original.companionHash },
      headingKey: string(headingKey), blockId: id(blockId) }
    typed = { kind: 'heading', documentId: id(target.documentId), slug: string(target.slug), state: 'live' }
  }
  else return invalid()
  return { source, destination, url,
    resolved: { target: typed, documentCreatedAt: hostTime(resolved.documentCreatedAt), blockCreatedAt: resolved.blockCreatedAt === null ? null : hostTime(resolved.blockCreatedAt),
      ...(heading ? { heading } : {}) } }
}

const span = (value: { blockId: string; from: number; to: number }) => encode([value.blockId, value.from, value.to])
function textEdits(value: unknown): DetachTextEdit[] {
  return list(value, raw => {
    assertSyncedShape(raw, ['blockId', 'from', 'to', 'before', 'after'])
    const edit = { blockId: id(raw.blockId), from: offset(raw.from), to: offset(raw.to), before: string(raw.before), after: string(raw.after) }
    if (edit.to < edit.from || edit.before.length !== edit.to - edit.from || edit.before === edit.after) return invalid()
    return edit
  }, span)
}

export function decodeHostDetachEvidence(value: unknown, input: HostDetachInput, before: HostContent): {
  evidence: HostDetachEvidence; after: HostContent
} {
  assertSyncedShape(value, ['revision', 'wire', 'survivors', 'allocation', 'projection'])
  const { projection } = value
  assertSyncedShape(projection, ['edits', 'links'], ['namespaceEdits'])
  const wire = validateSyncedGroupWire(value.wire), revision = uuid(value.revision)
  const groupGuard = input.groups.find(item => item.groupId === wire.id)
  const hostId = input.hostsWorkingBefore[0].documentId
  if (wire.id !== input.action.groupId || groupGuard?.expectedRevision !== revision
    || !input.expectedInstances.some(item => item.instanceId === input.action.instanceId && item.hostDocumentId === hostId)) return invalid()
  const survivors = list(value.survivors, guard, item => item.instanceId)
  if (survivors.some(item => item.instanceId === input.action.instanceId)) return invalid()
  const allocation = list(value.allocation, raw => {
    assertSyncedShape(raw, ['from', 'to']); return { from: id(raw.from), to: uuid(raw.to) }
  }, item => item.from)
  if (encode(wire.blocks.map(block => block.id)) !== encode(allocation.map(item => item.from))) return invalid()
  const copies = new Map(allocation.map(item => [item.from, item.to]))
  const edits = textEdits(projection.edits)
  const namespaceEdits = projection.namespaceEdits === undefined ? [] : textEdits(projection.namespaceEdits)
  // A physical reference or note definition has a closing bracket and colon
  // in its own paragraph. Only those records need the extra parser pass.
  const mayCollide = before.blocks.some(block => block.content.includes(']:')) && wire.blocks.some(block => block.content.includes(']:'))
  if (projection.namespaceEdits !== undefined && !namespaceEdits.length || (mayCollide || namespaceEdits.length > 0)
    && encode(namespaceEdits) !== encode(planDetachDefinitionNamespace(before.blocks, wire).edits)) return invalid()
  const allEdits = [...edits, ...namespaceEdits], byBlock = new Map<string, DetachTextEdit[]>()
  for (const edit of allEdits) {
    const group = byBlock.get(edit.blockId) ?? []
    group.push(edit); byBlock.set(edit.blockId, group)
  }
  const after = projectDetachedHost(before, input.action.instanceId, wire, allocation, allEdits)
  const links = list(projection.links, readLink, link => span(link.source))
  const bindings = new Map(wire.bindings.map(({ target, ...source }) => [span(source), { target, source }]))
  const editsBySpan = new Map(edits.map(edit => [span(edit), edit]))
  const projectors = new Map([...byBlock].map(([id, group]) => [id, createDetachRangeProjection(group)]))
  if (links.length !== bindings.size) return invalid()
  const finalBlocks = new Map(after.blocks.map(block => [block.id, block]))
  for (const { source, destination, url, resolved } of links) {
    const key = span(source), original = bindings.get(key), edit = editsBySpan.get(key)
    const expectedRaw = edit?.after ?? source.raw
    const { from: expectedFrom, to: expectedTo } = projectors.get(source.blockId)?.(source.from, source.to) ?? source
    if (!original || encode(original.source) !== encode(source) || destination.blockId !== copies.get(source.blockId)
      || destination.from !== expectedFrom || destination.to !== expectedTo || destination.raw !== expectedRaw || destination.syntax !== source.syntax
      || finalBlocks.get(destination.blockId)?.content.slice(expectedFrom, expectedTo) !== expectedRaw) return invalid()
    const target = original.target, final = resolved.target
    if (resolved.canonical) {
      const address = parseDetachedCanonicalDestination(source.syntax, url)
      if (!address || address.groupId === wire.id || copies.has(address.blockId) || encode(target) !== encode(final)) return invalid()
    } else if (target.kind === 'unresolved-url') {
      if (encode(target) !== encode(final)) return invalid()
    } else {
      if (target.state !== 'live' || final.kind === 'unresolved-url' || target.kind !== final.kind) return invalid()
      if (target.kind === 'heading') {
        if (!resolved.heading || target.documentId === hostId || encode(target) !== encode(final)) return invalid()
      } else if (final.kind === 'heading' || final.id !== (target.kind === 'block' ? copies.get(target.id) ?? target.id : target.id)
        || final.kind === 'block' && copies.has(target.id) && final.documentId !== hostId) return invalid()
    }
    if (edit) editsBySpan.delete(key)
  }
  if (editsBySpan.size) return invalid()
  return { evidence: { revision, wire, survivors, allocation, projection: { edits, links, ...(namespaceEdits.length ? { namespaceEdits } : {}) } }, after }
}
