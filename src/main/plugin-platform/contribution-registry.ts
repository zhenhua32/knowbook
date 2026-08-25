import type {
  PluginActiveOwner,
  PluginContributionDescriptor,
  PluginPlatformScope
} from '@shared/plugin-platform'
import {
  getPluginPlatformScopeSpecificity,
  isPluginPlatformScopeVisible
} from './scope'
import {
  normalizeContributionOrder,
  normalizeRegistryId
} from './registry-validation'

export interface RegisteredPluginContribution<T = unknown> {
  owner: PluginActiveOwner
  descriptor: Required<PluginContributionDescriptor>
  value: T
}

export interface StagedPluginContribution<T = unknown> {
  descriptor: PluginContributionDescriptor
  value: T
}

/** Ordered, scope-aware contribution registry owned by PluginPlatformKernel. */
export class PluginContributionRegistry {
  private readonly contributionsByNamespace = new Map<string, readonly RegisteredPluginContribution[]>()

  validateNamespace(stagedContributions: readonly StagedPluginContribution[]): void {
    const seen = new Set<string>()
    for (const contribution of normalizeStagedContributions(stagedContributions)) {
      const key = `${contribution.descriptor.slot}\u0000${contribution.descriptor.id}`
      if (seen.has(key)) {
        throw new Error(
          `Plugin contributed "${contribution.descriptor.id}" to slot "${contribution.descriptor.slot}" more than once.`
        )
      }
      seen.add(key)
    }
  }

  replaceNamespace(
    namespaceKey: string,
    owner: PluginActiveOwner,
    stagedContributions: readonly StagedPluginContribution[]
  ): void {
    const registered = normalizeStagedContributions(stagedContributions)
      .map((contribution): RegisteredPluginContribution => ({
        owner,
        descriptor: contribution.descriptor,
        value: contribution.value
      }))
    this.contributionsByNamespace.set(namespaceKey, registered)
  }

  removeNamespace(namespaceKey: string): void {
    this.contributionsByNamespace.delete(namespaceKey)
  }

  list<T>(slot: string, consumerScope: PluginPlatformScope): RegisteredPluginContribution<T>[] {
    const normalizedSlot = normalizeRegistryId(slot, 'contribution slot')
    const visible = [...this.contributionsByNamespace.values()]
      .flat()
      .filter((contribution) => (
        contribution.descriptor.slot === normalizedSlot
        && isPluginPlatformScopeVisible(contribution.owner.scope, consumerScope)
      ))

    const mostSpecificByLogicalId = new Map<string, RegisteredPluginContribution>()
    for (const contribution of visible) {
      const logicalId = `${contribution.owner.pluginId}\u0000${contribution.descriptor.id}`
      const current = mostSpecificByLogicalId.get(logicalId)
      if (
        !current
        || getPluginPlatformScopeSpecificity(contribution.owner.scope)
          > getPluginPlatformScopeSpecificity(current.owner.scope)
      ) {
        mostSpecificByLogicalId.set(logicalId, contribution)
      }
    }

    return [...mostSpecificByLogicalId.values()]
      .sort((left, right) => (
        left.descriptor.order - right.descriptor.order
        || left.owner.pluginId.localeCompare(right.owner.pluginId)
        || left.descriptor.id.localeCompare(right.descriptor.id)
      )) as RegisteredPluginContribution<T>[]
  }
}

function normalizeStagedContributions(
  contributions: readonly StagedPluginContribution[]
): RegisteredPluginContributionDraft[] {
  return contributions.map((contribution) => ({
    descriptor: Object.freeze({
      slot: normalizeRegistryId(contribution.descriptor.slot, 'contribution slot'),
      id: normalizeRegistryId(contribution.descriptor.id, 'contribution id'),
      order: normalizeContributionOrder(contribution.descriptor.order)
    }),
    value: contribution.value
  }))
}

type RegisteredPluginContributionDraft = {
  descriptor: Required<PluginContributionDescriptor>
  value: unknown
}
