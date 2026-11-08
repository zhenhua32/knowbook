import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedGroupWire, SyncedInstanceGuard, SyncedStructureAction, SyncedStructureInput } from '../../shared/synced-blocks'
import { validateSyncedInstanceGuard } from '../../shared/syncedBlockInputs'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { markdownEngine } from '../../shared/markdownEngine'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference, wikiDisplayText } from '../../shared/markdownWiki'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload, SyncedValidationError,
  validateSyncedGroupWire, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { BlockIdentityRepository } from './block-identities'
import { hostTime, type HostContent, type StrictHostDocument } from './synced-host-document-read'
import { captureSyncedCreateSourceFacts, createRawHash } from './synced-host-create-plan'
import type { HostBirth } from './synced-host-journal'
import { projectHostStructureHeadings } from './synced-host-create-headings'
import { planSyncedHeadingRewrites2, readSyncedHostHeadingsOwned2, type SyncedProjectedHeading2 } from './synced-heading-projection2'
import { readSyncedBindingSources } from './synced-stored-binding-read'
import { applyNavigation3TextEdits, createNavigation3RangeProjection, renderNavigation3Destination, type Navigation3FinalTarget } from './restore-knowledge-navigation3-rewrite-cells'

export type HostDetachInput = Extract<SyncedStructureInput, { mode: 'command' }> & {
  action: Extract<SyncedStructureAction, { kind: 'detach' }>
}
export type DetachBlockMap = Array<{ from: string; to: string }>
type Destination = { documentId: string; documentPath: string; documentBirth: string; blockBirth: string | null; headingHash?: string }
export type DetachSource = { source: SyncedGroupWire; revision: string; users: SyncedInstanceGuard[]; hostPath: string;
  blockMap: DetachBlockMap; destinations: Array<Destination | null>; headingHash?: string }

export class UnsupportedSyncedHostDetach extends Error {
  constructor(readonly reason: 'semantic-binding' | 'heading-rewrite') { super('无法证明解除同步后的链接和解析语境。') }
}
const unsupported = (): never => { throw new UnsupportedSyncedHostDetach('semantic-binding') }
const unsupportedHeading = (): never => { throw new UnsupportedSyncedHostDetach('heading-rewrite') }
const bad = (): never => { throw new Error('解除同步原件或目标映射损坏。') }
const encode = canonicalSyncedPortableJson
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const address = (id: string | undefined, from: number, to: number) => encode([id ?? null, from, to])
export const detachUsers = (instances: readonly SyncedInstanceGuard[], selected: string): SyncedInstanceGuard[] => instances
  .filter(instance => instance.instanceId !== selected)
  .map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion }))
  .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
export function isHostDetachInput(input: SyncedStructureInput): input is HostDetachInput {
  return input.mode === 'command' && input.action.kind === 'detach'
}

/** Only actual live ownership can authorize a new ordinary link. The group’s
 * stored path and state are historical hints. Intra-group links use the copy. */
export function captureDetachDestinations(db: Database.Database, source: SyncedGroupWire, hosts: ReadonlyMap<string, StrictHostDocument>,
  local?: { documentId: string; headings: SyncedProjectedHeading2[] }): DetachSource['destinations'] {
  const repository = new BlockIdentityRepository(db), own = new Set(source.blocks.map(block => block.id))
  const headings = new Map<string, SyncedProjectedHeading2[]>()
  if (local) headings.set(local.documentId, local.headings)
  readSyncedBindingSources(db, source.origin, source.blocks, source.bindings)
  return source.bindings.map(({ target }) => {
    if (target.kind === 'unresolved-url' || target.state !== 'live') return unsupported()
    if (target.kind === 'block' && own.has(target.id)) return null
    const owner = target.kind === 'block' ? repository.resolveLiveOwner(target.id) : null
    if (target.kind === 'block' && owner?.kind !== 'document') return unsupported()
    const host = hosts.get(target.kind === 'heading' ? target.documentId : owner?.id ?? target.id)
    if (!host) return unsupported()
    const blockBirth = target.kind === 'block' ? host.births.get(target.id) ?? unsupported() : null
    const destination = { documentId: host.detail.id, documentPath: host.detail.path, documentBirth: host.createdAt, blockBirth }
    if (target.kind !== 'heading') return destination
    let actual = headings.get(target.documentId)
    if (!actual) {
      actual = readSyncedHostHeadingsOwned2(db, target.documentId)?.headings ?? unsupportedHeading()
      headings.set(target.documentId, actual)
    }
    const matches = actual.filter(heading => heading.slug === target.slug)
    if (matches.length !== 1) return unsupportedHeading()
    return { ...destination, headingHash: createRawHash(matches[0]) }
  })
}

export function requiresDetachHeadingProof(source: SyncedGroupWire): boolean {
  return source.bindings.some(binding => binding.target.kind === 'heading')
    || getMarkdownHeadingTargets(source.blocks, '').some(heading => heading.blockId !== null)
}

/** The materialized copy may take over the exact detached occurrence only.
 * Other copies, heading suffixes and every surrounding anchor retain identity. */
export function assertDetachHeadingContinuity(host: StrictHostDocument, before: HostContent, after: HostContent,
  groups: ReadonlyMap<string, SyncedGroupSnapshot>, births: readonly HostBirth[], record: DetachSource, instanceId: string, comparePersisted: boolean) {
  if (host.detail.title !== before.title || host.detail.title !== after.title) return unsupportedHeading()
  const birthMap = new Map([...host.births, ...births.map(item => [item.blockId, item.createdAt] as const)])
  const previous = projectHostStructureHeadings(host, before, groups, birthMap, { instanceId, wire: record.source }, unsupportedHeading)
  const next = projectHostStructureHeadings(host, after, groups, birthMap, null, unsupportedHeading)
  if (comparePersisted && planSyncedHeadingRewrites2(projectHostStructureHeadings(host, host.content, groups, birthMap, null, unsupportedHeading), previous).size)
    return unsupportedHeading()
  const originals = new Map(record.source.blocks.map(block => [block.id, block.createdAt])), copies = new Map(record.blockMap.map(item => [item.to, item.from]))
  const instance = { hostDocumentId: host.detail.id, hostCreatedAt: host.createdAt, instanceId,
    instanceCreatedAt: birthMap.get(instanceId) ?? unsupportedHeading(), groupId: record.source.id,
    creationId: record.source.creationId, groupCreatedAt: record.source.createdAt }
  const equivalent = (headings: readonly SyncedProjectedHeading2[]) => headings.map(({ blockId, key, slug, text, location }) => {
    const sourceId = location.kind === 'ordinary' ? copies.get(location.blockId) : undefined
    if (sourceId !== undefined) location = { kind: 'canonical', instance, canonicalBlockId: sourceId,
      canonicalCreatedAt: originals.get(sourceId) ?? unsupportedHeading() }
    return { location, slug, text, ordinal: blockId === null ? null : key.slice(blockId.length) }
  })
  const initial = equivalent(previous), projected = equivalent(next)
  if (encode(initial) !== encode(projected)) return unsupportedHeading()
  return { hash: createRawHash(initial), local: { documentId: host.detail.id, headings: previous } }
}

export function validateDetachSource(value: unknown): DetachSource {
  assertSyncedShape(value, ['source', 'revision', 'users', 'hostPath', 'blockMap', 'destinations'], ['headingHash'])
  const source = validateSyncedGroupWire(value.source)
  if (!isSyncedUuid(value.revision) || !Array.isArray(value.users) || typeof value.hostPath !== 'string' || !value.hostPath
    || !Array.isArray(value.blockMap) || value.blockMap.length !== source.blocks.length
    || !Array.isArray(value.destinations) || value.destinations.length !== source.bindings.length) return bad()
  const headingHash = value.headingHash
  if (requiresDetachHeadingProof(source) ? !digest(headingHash) : headingHash !== undefined) return bad()
  const users = value.users.map(validateSyncedInstanceGuard)
  if (new Set(users.map(user => user.instanceId)).size !== users.length) return bad()
  const blockMap = value.blockMap.map((item, index) => {
    assertSyncedShape(item, ['from', 'to'])
    if (item.from !== source.blocks[index].id || !isSyncedUuid(item.to)) return bad()
    return { from: source.blocks[index].id, to: item.to }
  })
  const ids = new Set(source.blocks.map(block => block.id))
  if (new Set(blockMap.map(item => item.to)).size !== blockMap.length || blockMap.some(item => ids.has(item.to))) return bad()
  const destinations = value.destinations.map((item, index): Destination | null => {
    const target = source.bindings[index].target
    if (target.kind === 'unresolved-url' || target.state !== 'live') return bad()
    if (target.kind === 'block' && ids.has(target.id)) return item === null ? null : bad()
    assertSyncedShape(item, ['documentId', 'documentPath', 'documentBirth', 'blockBirth'], target.kind === 'heading' ? ['headingHash'] : [])
    if (!isSyncedBlockId(item.documentId) || typeof item.documentPath !== 'string' || !item.documentPath
      || target.kind === 'document' && (item.documentId !== target.id || item.blockBirth !== null)
      || target.kind === 'heading' && (item.documentId !== target.documentId || item.blockBirth !== null || !digest(item.headingHash))) return bad()
    return { documentId: item.documentId, documentPath: item.documentPath, documentBirth: hostTime(item.documentBirth),
      blockBirth: target.kind === 'block' ? hostTime(item.blockBirth) : null,
      ...(target.kind === 'heading' ? { headingHash: item.headingHash as string } : {}) }
  })
  return { source, revision: value.revision, users, hostPath: value.hostPath, blockMap, destinations,
    ...(digest(headingHash) ? { headingHash } : {}) }
}

/** Pure historical replay. Exact canonical destination spans are rewritten,
 * then both the copied and surviving bodies are checked in the real host parse. */
export function planSyncedHostDetach(input: HostDetachInput, record: DetachSource): HostContent {
  const { source, blockMap, destinations, hostPath } = record
  const { instanceId, groupId } = input.action
  if (input.hostsWorkingBefore.length !== 1 || source.id !== groupId) return bad()
  const { documentId, workingBefore } = input.hostsWorkingBefore[0]
  const guard = input.groups.find(group => group.groupId === groupId)
  if (guard?.expectedRevision !== record.revision || record.users.some(user => user.instanceId === instanceId)
    || !input.expectedInstances.some(instance => instance.instanceId === instanceId && instance.hostDocumentId === documentId)) return bad()
  const position = workingBefore.blocks.findIndex(block => block.id === instanceId)
  const reference = workingBefore.blocks[position]
  if (!reference || reference.type !== 'synced-block' || parseSyncedBlockPayload(reference.content).groupId !== groupId)
    throw new SyncedValidationError('binding', '目标引用不是实际宿主中的指定同步块。')
  const ids = new Map(blockMap.map(item => [item.from, item.to]))
  const copied = new Set(ids.values())
  if (workingBefore.blocks.some(block => copied.has(block.id))) return bad()
  const originalLinks = collectDocumentMarkdownLinks(source.blocks)
  const links = new Map(originalLinks.map(link => [address(link.blockId, link.start, link.end), link]))
  const edits = new Map<string, Array<{ from: number; to: number; before: string; after: string }>>()
  const urls = new Map<string, string>()
  source.bindings.forEach((binding, index) => {
    const key = address(binding.blockId, binding.from, binding.to), link = links.get(key)
    if (!link || link.kind === 'image' || (link.kind === 'wiki') !== (binding.syntax === 'wiki')) return unsupported()
    const target = binding.target, external = destinations[index]
    if (target.kind === 'unresolved-url' || target.kind === 'block' && target.id === instanceId) return unsupported()
    const desired: Navigation3FinalTarget = { kind: target.kind, documentId: external?.documentId ?? documentId,
      documentPath: external?.documentPath ?? hostPath, ...(target.kind === 'block' ? { blockId: external ? target.id : ids.get(target.id) }
        : target.kind === 'heading' ? { slug: target.slug } : {}) }
    const rendered = renderNavigation3Destination({ key: binding, url: link.url,
      grammar: { kind: link.kind, syntax: link.kind === 'wiki' ? 'wiki' : link.syntax ?? null } }, { documentId, path: hostPath }, desired)
    if ('reason' in rendered) return unsupported()
    let { url, replacement } = rendered
    if (link.kind === 'wiki' && parseWikiReference(link.url).alias === null && url !== link.url) {
      const label = wikiDisplayText(link.url)
      if (/[|\[\]\r\n]/.test(label)) return unsupported()
      url += '|' + label
      replacement += binding.raw.includes('\\|') ? '\\|' + label : '|' + label
    }
    urls.set(key, link.kind === 'wiki' ? url : markdownEngine.normalizeLink(url))
    if (replacement !== binding.raw) {
      const list = edits.get(binding.blockId) ?? []
      list.push({ from: binding.from, to: binding.to, before: binding.raw, after: replacement })
      edits.set(binding.blockId, list)
    }
  })
  const copies = source.blocks.map(({ createdAt: _createdAt, ...block }) => {
    const cellEdits = edits.get(block.id)
    return { ...block, id: ids.get(block.id)!, parentBlockId: block.parentBlockId === null ? null : ids.get(block.parentBlockId)!,
      content: cellEdits ? applyNavigation3TextEdits(block.content, cellEdits) : block.content }
  })
  const after = { ...workingBefore, blocks: validateSyncedHostForest([...workingBefore.blocks.slice(0, position),
    ...copies.map(block => ({ ...block, depth: reference.depth + block.depth, parentBlockId: block.parentBlockId ?? reference.parentBlockId })),
    ...workingBefore.blocks.slice(position + 1)]) }
  const survivorFacts = captureSyncedCreateSourceFacts(workingBefore.blocks), copyFacts = captureSyncedCreateSourceFacts(copies)
  const finalFacts = captureSyncedCreateSourceFacts(after.blocks)
  const byBlock = (facts: ReturnType<typeof captureSyncedCreateSourceFacts>) => {
    const units = new Map<string, unknown[]>()
    for (const unit of facts.units) {
      const list = units.get(unit.blockId) ?? []
      list.push(unit.semantic); units.set(unit.blockId, list)
    }
    return units
  }
  const expectedUnits = new Map([...byBlock(survivorFacts), ...byBlock(copyFacts)]), actualUnits = byBlock(finalFacts)
  for (const block of after.blocks) if (encode(expectedUnits.get(block.id) ?? []) !== encode(actualUnits.get(block.id) ?? [])) return unsupported()
  const expected = new Map<string, string>(), ranges = new Map(source.blocks.map(block => [block.id, createNavigation3RangeProjection(edits.get(block.id) ?? [])]))
  for (const link of originalLinks) {
    if (!link.blockId) return unsupported()
    const key = address(link.blockId, link.start, link.end), url = urls.get(key) ?? link.url
    if (!urls.has(key) && (link.kind === 'wiki' || link.kind !== 'image' && resolveMarkdownDocumentPath(source.origin.pathAtCreation, url)
      || parseLocalMarkdownUrl(url) && source.origin.pathAtCreation.split('/').slice(0, -1).join('/') !== hostPath.split('/').slice(0, -1).join('/'))) return unsupported()
    const range = ranges.get(link.blockId)?.(link.start, link.end)
    if (!range) return unsupported()
    expected.set(address(ids.get(link.blockId), range.from, range.to), url)
  }
  const actual = collectDocumentMarkdownLinks(after.blocks).filter(link => link.blockId && copied.has(link.blockId))
  if (actual.length !== expected.size || actual.some(link => expected.get(address(link.blockId, link.start, link.end)) !== link.url)) return unsupported()
  return after
}
