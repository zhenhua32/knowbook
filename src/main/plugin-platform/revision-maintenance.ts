import type { SqlitePluginPlatformRepository } from './repository'
import type { PluginRevisionStore } from './revision-store'

export interface PluginRevisionMaintenanceResult {
  deletedRevisionIds: string[]
  failedObjectDeletionIds: string[]
  removedStagingNames: string[]
  removedOrphanedObjectIds: string[]
}

/** Applies the conservative v2 retention policy; referenced audit history is never collected. */
export function runPluginRevisionMaintenance(
  repository: Pick<
    SqlitePluginPlatformRepository,
    'listRevisionIds' | 'listRevisionGarbageCandidates' | 'deleteRevisionIfUnreferenced'
  >,
  revisions: Pick<PluginRevisionStore, 'remove' | 'sweepStaging' | 'sweepOrphanedObjects'>,
  options: { retainPerPlugin?: number; olderThanMs?: number; nowMs?: number } = {}
): PluginRevisionMaintenanceResult {
  const removedStagingNames = revisions.sweepStaging({
    olderThanMs: options.olderThanMs,
    nowMs: options.nowMs
  })
  const deletedRevisionIds: string[] = []
  const failedObjectDeletionIds: string[] = []
  for (const revisionId of repository.listRevisionGarbageCandidates(options)) {
    if (!repository.deleteRevisionIfUnreferenced(revisionId)) {
      continue
    }
    deletedRevisionIds.push(revisionId)
    try {
      revisions.remove(revisionId)
    } catch {
      failedObjectDeletionIds.push(revisionId)
    }
  }
  const removedOrphanedObjectIds = revisions.sweepOrphanedObjects(
    new Set(repository.listRevisionIds()),
    { olderThanMs: options.olderThanMs, nowMs: options.nowMs }
  )
  return {
    deletedRevisionIds,
    failedObjectDeletionIds,
    removedStagingNames,
    removedOrphanedObjectIds
  }
}
