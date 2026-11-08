import type { SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import { getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import type { HostContent, StrictHostDocument } from './synced-host-document-read'
import type { HostBirth } from './synced-host-journal'
import { UnsupportedSyncedHostCreate } from './synced-host-create-plan'
import { planSyncedHeadingRewrites2, projectSyncedHostHeadingFacts2, type SyncedHeadingGroupFacts2,
  type SyncedHeadingInstanceIdentity2, type SyncedProjectedHeading2 } from './synced-heading-projection2'

export const hasCreateHeadings = (wire: SyncedGroupWire) => getMarkdownHeadingTargets(wire.blocks, '').some(heading => heading.blockId !== null)
const unsupported = (): never => { throw new UnsupportedSyncedHostCreate('heading-rewrite') }

/** Data-only projection for one already-validated host structure transition. */
export function projectHostStructureHeadings(host: StrictHostDocument, side: HostContent, groups: ReadonlyMap<string, SyncedGroupSnapshot>,
  births: ReadonlyMap<string, string>, replacement: { instanceId: string; wire: SyncedGroupWire } | null,
  refuse: () => never): SyncedProjectedHeading2[] {
  const referencedGroups = new Map<string, SyncedHeadingGroupFacts2>(), instances = new Map<string, SyncedHeadingInstanceIdentity2>()
  for (const ref of side.blocks) if (ref.type === 'synced-block') {
    const id = parseSyncedBlockPayload(ref.content).groupId
    const candidate = replacement?.instanceId === ref.id && replacement.wire.id === id ? replacement.wire : null
    const current = groups.get(id)
    const group = candidate ? { ...candidate, groupId: id } : current ?? refuse()
    if (!candidate && !current?.instances.some(instance => instance.instanceId === ref.id && instance.hostDocumentId === host.detail.id)) return refuse()
    referencedGroups.set(id, group)
    instances.set(ref.id, { hostDocumentId: host.detail.id, hostCreatedAt: host.createdAt, instanceId: ref.id,
      instanceCreatedAt: births.get(ref.id) ?? refuse(), groupId: id, creationId: group.creationId, groupCreatedAt: group.createdAt })
  }
  return projectSyncedHostHeadingFacts2({ ...side, documentId: host.detail.id, createdAt: host.createdAt, parentId: host.parentId,
    sortOrder: host.sortOrder, births }, referencedGroups, instances)
}

/** The only allowed heading movement is ordinary block → its original ID
 * and birth in the one new exact instance. Title and other occurrence
 * namespaces must remain equivalent, including duplicate suffixes. */
export function assertCreateHeadingContinuity(host: StrictHostDocument, working: HostContent, after: HostContent,
  groups: ReadonlyMap<string, SyncedGroupSnapshot>, wire: SyncedGroupWire, births: readonly HostBirth[],
  selectedIds: readonly string[], comparePersisted: boolean): SyncedProjectedHeading2[] {
  if (host.detail.title !== working.title || host.detail.title !== after.title) throw new UnsupportedSyncedHostCreate('heading-rewrite')
  const birthMap = new Map([...host.births, ...births.map(item => [item.blockId, item.createdAt] as const)])
  const selected = new Set(selectedIds)
  const project = (side: HostContent, proposed: boolean) => projectHostStructureHeadings(host, side, groups, birthMap,
    proposed ? { instanceId: wire.origin.firstInstanceId, wire } : null, unsupported)
  const before = project(working, false), next = project(after, true)
  if (comparePersisted && planSyncedHeadingRewrites2(project(host.content, false), before).size) return unsupported()
  const equivalent = (headings: readonly SyncedProjectedHeading2[]) => headings.map(({ blockId, key, slug, text, location }) => {
    if (location.kind === 'canonical' && location.instance.instanceId === wire.origin.firstInstanceId) {
      if (location.instance.groupId !== wire.id || !selected.has(location.canonicalBlockId) || birthMap.get(location.canonicalBlockId) !== location.canonicalCreatedAt) return unsupported()
      location = { kind: 'ordinary', documentId: host.detail.id, documentCreatedAt: host.createdAt,
        blockId: location.canonicalBlockId, blockCreatedAt: location.canonicalCreatedAt }
    }
    return { location, slug, text, ordinal: blockId === null ? null : key.slice(blockId.length) }
  })
  if (canonicalSyncedPortableJson(equivalent(before)) !== canonicalSyncedPortableJson(equivalent(next))) return unsupported()
  return before
}
