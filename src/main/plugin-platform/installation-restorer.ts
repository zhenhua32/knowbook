import { randomUUID } from 'node:crypto'
import type { PluginJsonValue, PluginPlatformScope } from '@shared/plugin-platform'
import type { PluginActivationCoordinator } from './activation-coordinator'
import type { SqlitePluginPlatformRepository } from './repository'

export interface RestoreWorkspacePluginInstallationsInput {
  repository: Pick<
    SqlitePluginPlatformRepository,
    | 'listWorkspaceInstallations'
    | 'recordInstallationError'
    | 'appendPluginLog'
  >
  coordinator: Pick<PluginActivationCoordinator, 'activate'>
  workspaceId: string
  isActive?: (pluginId: string, scope: PluginPlatformScope) => boolean
}

export interface RestoreWorkspacePluginInstallationsResult {
  restoredInstallationIds: string[]
  failedInstallationIds: string[]
  skippedInstallationIds: string[]
}

/** Restores only enabled workspace installations and always creates a fresh run. */
export async function restoreWorkspacePluginInstallations(
  input: RestoreWorkspacePluginInstallationsInput
): Promise<RestoreWorkspacePluginInstallationsResult> {
  const result: RestoreWorkspacePluginInstallationsResult = {
    restoredInstallationIds: [],
    failedInstallationIds: [],
    skippedInstallationIds: []
  }
  const installations = input.repository.listWorkspaceInstallations(
    input.workspaceId,
    { enabledOnly: true }
  )
  for (const installation of installations) {
    if (
      !installation.currentRevisionId
      || !installation.currentGrantSetId
      || input.isActive?.(installation.pluginId, installation.scope)
    ) {
      result.skippedInstallationIds.push(installation.id)
      continue
    }
    try {
      await input.coordinator.activate({
        pluginId: installation.pluginId,
        revisionId: installation.currentRevisionId,
        grantSetId: installation.currentGrantSetId,
        installationId: installation.id,
        scope: installation.scope
      })
      result.restoredInstallationIds.push(installation.id)
    } catch (error) {
      const serialized = serializeInstallationError(error)
      input.repository.recordInstallationError(installation.id, serialized)
      input.repository.appendPluginLog({
        id: randomUUID(),
        pluginId: installation.pluginId,
        revisionId: installation.currentRevisionId,
        level: 'error',
        event: 'installation.restore.failed',
        message: normalizeError(error).message.slice(0, 2_000),
        data: serialized
      })
      result.failedInstallationIds.push(installation.id)
    }
  }
  return result
}

function serializeInstallationError(error: unknown): PluginJsonValue {
  const normalized = normalizeError(error)
  return {
    name: normalized.name.slice(0, 200),
    message: normalized.message.slice(0, 2_000)
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(typeof error === 'string' ? error : 'Plugin installation restore failed.')
}
