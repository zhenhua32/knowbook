// Pure DATA kernel. It reads no SQL and mints no owner or permit.
// The owned business reader opens reverse-bound originals and predecessors;
// the writer rechecks the native point inside its transaction before applying
// this independently reconstructed projection.
import type { SyncedBindingKey, SyncedLinkTarget, SyncedGroupWire } from '../../shared/synced-blocks'
import { isSyncedUuid, assertSyncedShape } from '../../shared/syncedBlockValidation'
import { validateSyncedBindingKey } from '../../shared/syncedBlockInputs'
import { hostHash, hostEqual, hostEncode, decodeHostJournal } from './synced-host-journal'
import { restoreHeadingTitleOrdinaryFields3, type HeadingTitleOrdinaryRestoreFact3 } from './synced-heading-title-style-facts3'
import { restyleHeadingTitleOrdinaryBlocks3, restyleHeadingTitleGroupProjection3, type HeadingTitleRestoreGroupStyle3 } from './synced-heading-title-style3'
import type { HeadingTitle3Companion, HeadingTitle3Group } from './synced-heading-title3-codec'
import type { SyncedStructureApplied } from '../../shared/synced-blocks'
import { decodeSyncedMetadataCaptureRecord2 } from './synced-metadata-capture-record2'
import { projectSyncedHostHeadingFacts2, planSyncedHeadingRewrites2, type SyncedHeadingLocation2 } from './synced-heading-projection2'
import { projectSyncedMetadataGroupLinks2, type SyncedMetadataDocumentDestination2 } from './synced-metadata-group-links2'
import { projectSyncedMetadataCell2 } from './synced-metadata-cell2'
import { projectHeadingTitleOrdinaryCells3, validateHeadingTitleOrdinaryWiki3, validateHeadingTitleOrdinaryDocuments3, type HeadingTitleOrdinaryDocument3, type HeadingTitleOrdinaryWiki3 } from './synced-heading-title-ordinary3'
export type { HeadingTitleOrdinaryWiki3 } from './synced-heading-title-ordinary3'
import { findWikiHeading } from '../../shared/markdownWiki'
import { getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { HeadingTitle3WikiStyleRequired, projectHeadingTitleWikiDocuments3, resolveHeadingTitleWikiStyle3, type HeadingTitleWikiDocuments3 } from './synced-heading-title-wiki-style3'

type Point = ReturnType<typeof decodeSyncedMetadataCaptureRecord2>
type StyleNamespace3 = Pick<Point['capture']['namespaces'][number], 'host' | 'path'>
export interface HeadingTitleRestoreStyle3 { from: StyleNamespace3; to: StyleNamespace3 }
/** These DATA templates come from the same reverse-bound immutable initial
 * operation, never a caller's arbitrary historical block snapshot. */
export function headingTitleRestoreTemplate3(namespace: StyleNamespace3, styles: readonly HeadingTitleRestoreStyle3[] = []) {
  const style = styles.find(item => item.from.host.documentId === namespace.host.documentId)
  return style && style.from.path === namespace.path && hostEqual(style.from.host, namespace.host) ? style.to.host.blocks : undefined
}
type HeadingTarget = Extract<SyncedLinkTarget, { kind: 'heading' }>
type OrdinaryLocation = Extract<SyncedHeadingLocation2, { kind: 'ordinary' }>
export interface HeadingTitleCoveredKey3 {
  birthOperationId: string
  birthKey: SyncedBindingKey
  key: SyncedBindingKey
  target: HeadingTarget
  location: OrdinaryLocation
  headingKey: string
}
export interface HeadingTitleSubtree3 {
  id: string; createdAt: string; parentId: string | null; title: string; path: string; sortOrder: number
}
export interface HeadingTitlePointEdgeInput3 {
  before: Point
  after: Point
  rootId: string
  persistedTitle: string
  afterTitle: string
  createdAt: string
  subtree: readonly HeadingTitleSubtree3[]
  afterRevision: string
  previousCovered: readonly HeadingTitleCoveredKey3[]
  ordinaryWiki: readonly HeadingTitleOrdinaryWiki3[]
  wikiDocuments: readonly HeadingTitleOrdinaryDocument3[]
  restoreStyles?: readonly HeadingTitleRestoreStyle3[]
  restoreGroups?: readonly HeadingTitleRestoreGroupStyle3[]
  restoreOrdinary?: readonly HeadingTitleOrdinaryRestoreFact3[]
}
const bad = (message: string): never => { throw Error('Heading title point3 DATA invalid: ' + message) }
const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey) => hostEncode([blockId, from, to, raw, syntax])
const onlyKey = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
const same = (left: unknown, right: unknown) => hostEqual(left, right)
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
export const headingTitlePointMaterial3 = (point: Pick<Point, 'workspaceScope' | 'recoveryEpoch' | 'requestHash' | 'capture' | 'sources' | 'groupHistories'>) => ({ workspaceScope: point.workspaceScope, recoveryEpoch: point.recoveryEpoch,
  requestHash: point.requestHash, capture: point.capture, sources: point.sources, groupHistories: point.groupHistories })

function assertNativeChangedWiki3(wire:SyncedGroupWire,bindings:readonly SyncedGroupWire['bindings'][number][],documents:HeadingTitleWikiDocuments3,namespaces:Point['capture']['namespaces'],blockOwners:ReadonlyMap<string,{documentId:string;createdAt:string}>){
  const byId=new Map(namespaces.map(namespace=>[namespace.host.documentId,namespace]))
  const headings=new Map<string,ReturnType<typeof getMarkdownHeadingTargets>>()
  const occurrences=new Map(collectSyncedBindingOccurrences(wire.origin,wire.blocks).map(item=>[key(item),item]))
  const refuse=(message:string):never=>{throw new HeadingTitle3WikiStyleRequired(message)}
  for(const binding of bindings){
    const target=binding.target
    if(target.kind==='unresolved-url'||target.state!=='live')return refuse('changed canonical Wiki lacks a live typed target')
    const occurrence=occurrences.get(key(binding))??refuse('changed canonical Wiki lacks its complete parser Key')
    const {document,reference}=resolveHeadingTitleWikiStyle3(occurrence.url,wire.origin.pathAtCreation,documents)
    const expectedId=target.kind==='document'?target.id:target.kind==='block'?blockOwners.get(target.id)?.documentId:target.documentId
    if(expectedId!==document.documentId)return refuse('changed canonical Wiki resolves to another actual document')
    if(/[#|\[\]\r\n]/.test(document.path))return refuse('canonical Wiki legacy target path has no symmetric original path adapter')
    if(target.kind==='document'){
      if(reference.fragment)return refuse('changed canonical Wiki document acquired a fragment')
      continue
    }
    const fragment=reference.fragment,blockId=fragment.startsWith('^')?fragment.slice(1):fragment
    if(target.kind==='block'){
      if(blockId!==target.id)return refuse('changed canonical Wiki block differs from its native fragment')
      continue
    }
    const namespace=byId.get(document.documentId)
    if(!namespace||namespace.host.createdAt!==document.documentCreatedAt||namespace.path!==document.path
      ||namespace.host.blocks.some(block=>block.id===blockId))return refuse('changed canonical Wiki lacks its exact native heading namespace')
    let native=headings.get(document.documentId)
    if(!native){native=getMarkdownHeadingTargets(namespace.host.blocks,namespace.host.title);headings.set(document.documentId,native)}
    if(findWikiHeading(fragment,native)?.slug!==target.slug)return refuse('changed canonical Wiki resolves to another native heading')
  }
}

type SideInput = Pick<HeadingTitlePointEdgeInput3, 'rootId' | 'persistedTitle' | 'afterTitle' | 'createdAt' | 'subtree' | 'ordinaryWiki' | 'wikiDocuments' | 'restoreStyles' | 'restoreGroups' | 'restoreOrdinary'>
  &{before:Pick<Point,'capture'|'sources'>}
function destinations3(input: SideInput): Map<string, SyncedMetadataDocumentDestination2> {
  const items = new Map(input.subtree.map(item => [item.id, item]))
  if (items.size !== input.subtree.length || !items.has(input.rootId)) return bad('complete unique native subtree required')
  const root = items.get(input.rootId)!
  for (const item of input.subtree) if (!time(item.createdAt) || !Number.isSafeInteger(item.sortOrder)
    || typeof item.title !== 'string' || !item.title || typeof item.path !== 'string') return bad('native subtree facts invalid')
  if (root.title !== input.persistedTitle || (root.parentId === null ? root.path !== root.title : !root.path.endsWith('/' + root.title)))
    return bad('native root title/path differs')
  const rootParent = root.path.slice(0, root.path.length - root.title.length)
  const paths = new Map<string, string>([[input.rootId, rootParent + input.afterTitle]]), queue = [input.rootId]
  for (let index = 0; index < queue.length; index++) for (const item of input.subtree) if (item.parentId === queue[index]) {
    if (paths.has(item.id)) return bad('subtree cycle')
    const parent = items.get(queue[index])!
    if (item.path !== parent.path + '/' + item.title) return bad('native descendant path drift')
    paths.set(item.id, paths.get(queue[index])! + '/' + item.title); queue.push(item.id)
  }
  if (paths.size !== items.size) return bad('subtree parent closure differs')
  return new Map(input.subtree.map(item => [item.id, { documentId: item.id, beforeCreatedAt: item.createdAt, afterCreatedAt: item.createdAt,
    beforePath: item.path, afterPath: paths.get(item.id)!, headings: new Map<string, string>() }]))
}

/** Pure projected-side DATA. It is not a historical point, original birth,
 * currentness claim, SQL owner or permission. Only the committed A point is
 * independently persisted and reopened by the owned business writer. */
export class HeadingTitle3CascadeRequired extends Error{constructor(message:string){super('Heading title3 requires continuity adapter: '+message);this.name='HeadingTitle3CascadeRequired'}}
export function planHeadingTitleSideData3(input: SideInput) {
  const destinations=destinations3(input),beforeNamespaces=new Map(input.before.capture.namespaces.map(namespace=>[namespace.host.documentId,namespace]))
  const captures=new Map(input.ordinaryWiki.map(source=>[source.documentId,source]))
  if(beforeNamespaces.size!==input.before.capture.namespaces.length||captures.size!==input.ordinaryWiki.length||captures.size!==beforeNamespaces.size)
    return bad('complete unique native ordinary source closure required')
  const subtreeById=new Map(input.subtree.map(item=>[item.id,item])),subtreeByPath=new Map(input.subtree.map(item=>[item.path,item]))
  if(subtreeByPath.size!==input.subtree.length)return bad('subtree path identities overlap')
  const wikiDocuments=validateHeadingTitleOrdinaryDocuments3(input.wikiDocuments),documentById=new Map(wikiDocuments.map(item=>[item.documentId,item]))
  for(const namespace of input.before.capture.namespaces){const item=documentById.get(namespace.host.documentId)
    if(!item||item.documentCreatedAt!==namespace.host.createdAt||item.path!==namespace.path||item.title!==namespace.host.title)return bad('single actual Wiki naming scope differs from original point namespace')}
  for(const item of input.subtree){const document=documentById.get(item.id)
    if(!document||document.documentCreatedAt!==item.createdAt||document.path!==item.path||document.title!==item.title)return bad('single actual Wiki naming scope differs from original complete subtree')}
  let namingScope:HeadingTitleOrdinaryWiki3['documents']|undefined
  for(const namespace of input.before.capture.namespaces){
    const captured=captures.get(namespace.host.documentId)
    if(!captured)return bad('ordinary source capture missing')
    validateHeadingTitleOrdinaryWiki3(namespace,captured,input.before.capture.namespaces)
    if(captured.links.length){
      if(namingScope&&!same(namingScope,captured.documents))return bad('one native before point carries contradictory complete Wiki naming scopes')
      namingScope=captured.documents
      if(!same(wikiDocuments,captured.documents))return bad('ordinary Wiki capture differs from single actual original naming scope')
    }
    for(const item of input.subtree){const document=captured.documents.find(document=>document.documentId===item.id)
      if(captured.links.length&&(!document||document.documentCreatedAt!==item.createdAt||document.path!==item.path||document.title!==item.title))
        return bad('actual complete naming scope differs from affected subtree identity/title/path')}
    for(const link of captured.links)if(link.target){
      const original=subtreeById.get(link.target.documentId)??subtreeByPath.get(link.target.path)
      if(original&&(original.id!==link.target.documentId||original.createdAt!==link.target.documentCreatedAt||original.path!==link.target.path))
        return bad('captured affected Wiki target differs from its native subtree birth/path')
    }
  }
  const titled=input.before.capture.namespaces.map(namespace=>{
    const destination=destinations.get(namespace.host.documentId)
    if(!destination)return namespace
    const item=subtreeById.get(namespace.host.documentId)!
    if(!item||item.createdAt!==namespace.host.createdAt||item.path!==namespace.path||item.title!==namespace.host.title
      ||item.parentId!==namespace.host.parentId||item.sortOrder!==namespace.host.sortOrder)return bad('original complete namespace differs from native subtree')
    if(namespace.instances.length||namespace.host.blocks.some(block=>block.type==='synced-block'))
      throw new HeadingTitle3CascadeRequired('changed canonical namespace')
    const host={...namespace.host,title:namespace.host.documentId===input.rootId?input.afterTitle:namespace.host.title}
    const headings=projectSyncedHostHeadingFacts2({...host,births:new Map(host.births)},new Map(),new Map())
    destination.headings=planSyncedHeadingRewrites2(namespace.headings,headings)
    return{...namespace,host,path:destination.afterPath,headings}
  })
  const changes=new Map([...destinations.values()].filter(item=>item.beforePath!==item.afterPath||item.headings.size)
    .map(item=>[item.beforePath,{before:item.beforePath,after:item.afterPath,headings:new Map(item.headings)}]))
  const afterWikiDocuments=projectHeadingTitleWikiDocuments3(wikiDocuments,destinations,input.rootId,input.afterTitle)
  const expectedNamespaces=titled.map(selected=>{
    const old=beforeNamespaces.get(selected.host.documentId)!,captured=captures.get(selected.host.documentId)!
    const ordinary=projectHeadingTitleOrdinaryCells3(old,selected.path,changes,changes.has(old.path),captured,input.before.capture.namespaces,{before:wikiDocuments,after:afterWikiDocuments,sourcePath:old.path})
    const template=input.restoreOrdinary?undefined:headingTitleRestoreTemplate3(old,input.restoreStyles)
    const restored=input.restoreOrdinary?restoreHeadingTitleOrdinaryFields3({documentId:old.host.documentId,documentCreatedAt:old.host.createdAt,
      path:old.path,blocks:old.host.blocks,births:new Map(old.host.births)},ordinary.blocks,selected.path,input.restoreOrdinary,undefined,{before:wikiDocuments,after:afterWikiDocuments,sourcePath:old.path})
      :template?restyleHeadingTitleOrdinaryBlocks3(old.host.blocks,ordinary.blocks,selected.path,template,undefined,undefined,{before:wikiDocuments,after:afterWikiDocuments,sourcePath:old.path}):null
    const rewritten={blocks:restored?.blocks??ordinary.blocks,changed:(restored?.blocks??ordinary.blocks).some((block,index)=>block.content!==old.host.blocks[index].content)}
    const nonordinary=old.instances.length||old.host.blocks.some(block=>block.type==='synced-block')
    if(nonordinary){if(rewritten.changed||old.path!==selected.path||old.host.title!==selected.host.title)throw new HeadingTitle3CascadeRequired('ordinary maintenance in a canonical namespace');return old}
    const host={...selected.host,blocks:rewritten.blocks}
    const headings=projectSyncedHostHeadingFacts2({...host,births:new Map(host.births)},new Map(),new Map())
    const actualRewrites=planSyncedHeadingRewrites2(old.headings,headings),expectedRewrites=destinations.get(host.documentId)?.headings??new Map<string,string>()
    if(!same([...actualRewrites],[...expectedRewrites]))throw new HeadingTitle3CascadeRequired('ordinary cell maintenance introduces an additional heading cascade')
    const namespaceHash=hostHash({documentId:host.documentId,createdAt:host.createdAt,path:selected.path,
      contentHash:hostHash({title:host.title,summary:host.summary,blocks:host.blocks}),births:host.births,instances:[],headings})
    return{...selected,host,headings,namespaceHash,updatedAt:host.documentId===input.rootId||rewritten.changed?input.createdAt:old.updatedAt}
  })
  const owners=new Map<string,{documentId:string;createdAt:string}>()
  for(const target of input.before.capture.targets)if(target.status==='current-block'&&target.owner==='document')owners.set(target.blockId,{documentId:target.ownerId,createdAt:target.createdAt})
  const projection=restyleHeadingTitleGroupProjection3(projectSyncedMetadataGroupLinks2(input.before.sources[0].wire,destinations,owners),input.restoreGroups,{before:wikiDocuments,after:afterWikiDocuments,sourcePath:input.before.sources[0].wire.origin.pathAtCreation})
  const changedWiki=new Set(projection.edits.filter(edit=>edit.key.syntax==='wiki').map(edit=>key(edit.key)))
  if(changedWiki.size){
    const indexes=projection.before.bindings.flatMap((binding,index)=>changedWiki.has(key(binding))?[index]:[])
    assertNativeChangedWiki3(projection.before,indexes.map(index=>projection.before.bindings[index]),wikiDocuments,input.before.capture.namespaces,owners)
    assertNativeChangedWiki3(projection.after,indexes.map(index=>projection.after.bindings[index]),afterWikiDocuments,expectedNamespaces,owners)
  }
  return{destinations,namespaces:expectedNamespaces,projection}
}

/** Reconstruct the initial operation's exact effective sides from its actual
 * before/after point originals and journal. Only a later inverse consumes this
 * DATA; it must also match the current complete from-side before using a style
 * template. No canonical body is restored from these historical values. */
export function deriveHeadingTitleRestorationStyles3(initial: {
  companion: HeadingTitle3Companion
  envelope: { result: SyncedStructureApplied }
  materials: readonly { group: HeadingTitle3Group; sourcePoint: Point; afterPoint: Point }[]
  journal: Parameters<typeof decodeHostJournal>[0] | null
}, direction: 'undo' | 'redo'): HeadingTitleRestoreStyle3[] {
  const saved = initial.companion
  if (saved.intent.kind !== 'apply') return bad('style source is not the actual initial user action')
  const styles = new Map<string, HeadingTitleRestoreStyle3>()
  const hold = (working: StyleNamespace3, after: StyleNamespace3) => {
    const next = direction === 'undo' ? { from: after, to: working } : { from: working, to: after }
    const previous = styles.get(working.host.documentId)
    if (previous && !same(previous, next)) return bad('original groups disagree on one complete style namespace')
    styles.set(working.host.documentId, next)
  }
  for (const material of initial.materials) {
    const working = planHeadingTitleSideData3({ before: material.sourcePoint, rootId: saved.hostId, persistedTitle: saved.persistedTitle,
      afterTitle: saved.intent.workingTitle, createdAt: saved.createdAt, subtree: saved.subtree, ordinaryWiki: material.group.ordinaryWiki,wikiDocuments:saved.wikiDocuments })
    for (const namespace of working.namespaces) {
      const after = material.afterPoint.capture.namespaces.find(item => item.host.documentId === namespace.host.documentId)
      if (!after) return bad('original after-side style namespace missing')
      hold({ host: namespace.host, path: namespace.path }, { host: after.host, path: after.path })
    }
  }
  // A renamed ancestor can contain references while only its ordinary child
  // appears in target points. The real original journal/ACK still provide the
  // actor's full exact sides when raw W is already its effective W. If not,
  // this fallback supplies nothing; the writer's full target hash remains the
  // final guard rather than guessing or copying a canonical snapshot.
  if (!styles.has(saved.hostId) && initial.journal) {
    const journal = decodeHostJournal(initial.journal), raw = journal.before[0], ack = initial.envelope.result.hosts[0]
    const root = saved.subtree.find(item => item.id === saved.hostId)
    const after = { title: ack.after.title, summary: ack.after.summary,
      blocks: ack.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) }
    if (raw?.documentId === saved.hostId && root && hostHash(raw.content) === saved.workingContentHash && hostHash(after) === saved.afterContentHash) {
      const facts = { documentId: saved.hostId, createdAt: saved.hostCreatedAt, parentId: saved.hostParentId, sortOrder: root.sortOrder,
        births: journal.births.filter(item => item.documentId === saved.hostId).map((item): [string, string] => [item.blockId, item.createdAt]) }
      hold({ path: saved.workingPath, host: { ...facts, ...raw.content } }, { path: saved.afterPath, host: { ...facts, ...after } })
    }
  }
  return [...styles.values()]
}

/** Full data reconstruction for one actual P→A title-only continuity edge.
 * It accepts no same-slug fallback: every changed incoming heading Key must
 * retain its original physical Key lineage AND exact native heading birth.
 * W navigation and the complete incoming closure across BOTH W and A must be
 * validated independently by the owned business original reader/writer. Only
 * the actual committed A may become the next durable predecessor. */
export function deriveHeadingTitlePointEdge3(input: HeadingTitlePointEdgeInput3) {
  if (input.before.kind !== 'synced-metadata2-read-baseline-record' || input.after.kind !== 'synced-metadata2-read-baseline-record'
    || input.before.sources.length !== 1 || input.after.sources.length !== 1 || !time(input.createdAt)
    || !isSyncedUuid(input.afterRevision) || !same([input.before.workspaceScope, input.before.recoveryEpoch, input.before.requestHash],
      [input.after.workspaceScope, input.after.recoveryEpoch, input.after.requestHash])) return bad('point scope/domain differs')
  const beforeSource = input.before.sources[0], afterSource = input.after.sources[0], before = beforeSource.wire
  const after = afterSource.wire
  if (!same([before.id, before.creationId, before.createdAt, before.origin, beforeSource.topologyRevision],
    [after.id, after.creationId, after.createdAt, after.origin, afterSource.topologyRevision])
    || afterSource.revision !== input.afterRevision || !same(input.before.groupHistories, input.after.groupHistories)
    || input.before.groupHistories.length !== 1 || input.before.groupHistories[0].position !== 0
    || input.before.groupHistories[0].history.undoToken !== null || input.before.groupHistories[0].history.redoToken !== null)
    return bad('source incarnation/topology/user-history differs')
  const { destinations, namespaces: expectedNamespaces, projection: projected } = planHeadingTitleSideData3(input)
  const beforeNamespaces = new Map(input.before.capture.namespaces.map(namespace => [namespace.host.documentId, namespace]))
  const afterNamespaces = new Map(expectedNamespaces.map(namespace => [namespace.host.documentId, namespace]))
  const covered = new Map(input.previousCovered.map(item => [key(item.key), item]))
  if (covered.size !== input.previousCovered.length || input.previousCovered.some(item => !isSyncedUuid(item.birthOperationId))) return bad('covered Key identities differ')
  const currentTargets = new Map(input.before.capture.targets.map(target => [key(target.key), target]))
  const beforeBindings = new Map(before.bindings.map(binding => [key(binding), binding]))
  for (const proof of input.previousCovered) {
    assertSyncedShape(proof, ['birthOperationId', 'birthKey', 'key', 'target', 'location', 'headingKey'])
    validateSyncedBindingKey(proof.birthKey); validateSyncedBindingKey(proof.key)
    const binding = beforeBindings.get(key(proof.key)), actual = currentTargets.get(key(proof.key))
    if (!binding || binding.target.kind !== 'heading' || !same(binding.target, proof.target)
      || !actual || actual.status !== 'current-heading' || actual.heading.location.kind !== 'ordinary'
      || actual.heading.key!==proof.headingKey||!same(actual.heading.location, proof.location)) return bad('a carried covered Key/target/birth differs from its full before point')
  }
  for (const binding of before.bindings) {
    if (binding.target.kind !== 'heading') continue
    const destination = destinations.get(binding.target.documentId)
    if (!destination || destination.beforePath === destination.afterPath && !destination.headings.size) continue
    const proof = covered.get(key(binding)), actual = currentTargets.get(key(binding))
    if (!proof || !same(proof.target, binding.target) || !actual || actual.status !== 'current-heading'
      || binding.target.state !== 'live' || actual.heading.location.kind !== 'ordinary'
      || actual.heading.key!==proof.headingKey||!same(actual.heading.location, proof.location) || proof.location.documentId !== binding.target.documentId
      || beforeNamespaces.get(binding.target.documentId)?.namespaceHash !== actual.namespaceHash) return bad('actual incoming Key has no continuous original heading birth')
  }
  if (!same(projected.after, after)) return bad('after wire is not complete exact native navigation projection')
  if (!projected.changed && afterSource.revision !== beforeSource.revision) return bad('unchanged wire acquired a new revision')
  const cells = new Map(before.blocks.map(block => [block.id, projectSyncedMetadataCell2(block.content,
    before.bindings.filter(binding => binding.blockId === block.id).map(onlyKey), projected.edits.filter(edit => edit.blockId === block.id))]))
  const afterBindings = new Map(after.bindings.map(binding => [key(binding), binding]))
  const expectedTargets = input.before.capture.targets.map(target => {
    const projectedKey = cells.get(target.key.blockId)?.project(target.key)
    const binding = projectedKey && afterBindings.get(key(projectedKey))
    if (!projectedKey || !binding) return bad('full target Key projection differs')
    const common = { ...target, key: projectedKey, storedTarget: binding.target }
    if (target.status === 'current-heading') {
      const namespace = afterNamespaces.get(target.documentId)
      const matches = namespace?.headings.filter(heading => heading.key===target.heading.key&&same(heading.location, target.heading.location)) ?? []
      const slug=binding.target.kind==='heading'?binding.target.slug:null
      if (!namespace || matches.length !== 1 || slug===null || slug !== matches[0].slug
        || namespace.headings.filter(heading => heading.slug === slug).length !== 1) return bad('projected target lost its unique exact heading birth')
      return { ...common, namespaceHash: namespace.namespaceHash, heading: matches[0] }
    }
    if (target.status === 'current-document') return { ...common, path: destinations.get(target.documentId)?.afterPath ?? target.path }
    return common
  })
  const groups = input.before.capture.groups.map(group => group.kind === 'transition-source' && group.groupId === before.id
    ? { ...group, sourceWireHash: hostHash(after), revision: afterSource.revision, topologyRevision: afterSource.topologyRevision } : group)
  const { captureHash: _oldCaptureHash, ...captureBody } = input.before.capture
  const sources = captureBody.sources.map(source => source.groupId === before.id ? { ...source, sourceRevision: afterSource.revision,
    sourceTopologyRevision: afterSource.topologyRevision, sourceWireHash: hostHash(after) } : source)
  const nextCaptureBody = { ...captureBody, sources, groups, namespaces: expectedNamespaces, targets: expectedTargets }
  const expectedCapture = { ...nextCaptureBody, captureHash: hostHash({ domain: 'knowbook.synced.metadata2.current-target-capture.v2', capture: nextCaptureBody }) }
  if (!same(expectedCapture, input.after.capture)) return bad('whole namespace/target point after-state differs')
  const nextCovered = input.previousCovered.map(item => {
    const nextKey = cells.get(item.key.blockId)?.project(item.key), binding = nextKey && afterBindings.get(key(nextKey))
    const target = nextKey && expectedTargets.find(target => key(target.key) === key(nextKey))
    if (!nextKey || !binding || binding.target.kind !== 'heading' || !target || target.status !== 'current-heading'
      || item.headingKey!==target.heading.key||!same(item.location, target.heading.location)) return bad('covered original Key/birth does not survive exact cell projection')
    return { ...item, key: nextKey, target: binding.target }
  })
  return { before: before as SyncedGroupWire, after: after as SyncedGroupWire, edits: projected.edits, covered: nextCovered,
    beforePoint: input.before, afterPoint: input.after, writePermit: false as const, currentMutationAuthorized: false as const }
}
