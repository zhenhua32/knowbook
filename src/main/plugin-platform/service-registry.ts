import type {
  PluginActiveOwner,
  PluginPlatformScope,
  PluginServiceDescriptor
} from '@shared/plugin-platform'
import {
  getPluginPlatformScopeKey,
  getPluginPlatformScopeSpecificity,
  isPluginPlatformScopeVisible
} from './scope'
import {
  normalizeRegistryId,
  normalizeRegistryPriority,
  normalizeRegistryVersion
} from './registry-validation'

export interface RegisteredPluginService<T = unknown> {
  owner: PluginActiveOwner
  descriptor: Required<PluginServiceDescriptor>
  value: T
}

export interface StagedPluginService<T = unknown> {
  descriptor: PluginServiceDescriptor
  value: T
}

/** Read-through service registry. Namespace mutations are performed by PluginPlatformKernel. */
export class PluginServiceRegistry {
  private readonly servicesByNamespace = new Map<string, readonly RegisteredPluginService[]>()

  validateNamespace(
    namespaceKey: string,
    owner: PluginActiveOwner,
    stagedServices: readonly StagedPluginService[]
  ): void {
    const normalized = normalizeStagedServices(stagedServices)
    const seenServiceIds = new Set<string>()

    for (const service of normalized) {
      if (seenServiceIds.has(service.descriptor.id)) {
        throw new Error(`Plugin registered service "${service.descriptor.id}" more than once.`)
      }
      seenServiceIds.add(service.descriptor.id)
    }

    const scopeKey = getPluginPlatformScopeKey(owner.scope)
    for (const [candidateNamespaceKey, registeredServices] of this.servicesByNamespace) {
      if (candidateNamespaceKey === namespaceKey) {
        continue
      }
      for (const registered of registeredServices) {
        if (getPluginPlatformScopeKey(registered.owner.scope) !== scopeKey) {
          continue
        }
        const staged = normalized.find((service) => (
          service.descriptor.id === registered.descriptor.id
          && service.descriptor.priority === registered.descriptor.priority
        ))
        if (staged) {
          throw new Error(
            `Service "${staged.descriptor.id}" already has a provider at priority ${staged.descriptor.priority} in ${scopeKey}.`
          )
        }
      }
    }
  }

  replaceNamespace(
    namespaceKey: string,
    owner: PluginActiveOwner,
    stagedServices: readonly StagedPluginService[]
  ): void {
    const registered = normalizeStagedServices(stagedServices).map((service): RegisteredPluginService => ({
      owner,
      descriptor: service.descriptor,
      value: service.value
    }))
    this.servicesByNamespace.set(namespaceKey, registered)
  }

  removeNamespace(namespaceKey: string): void {
    this.servicesByNamespace.delete(namespaceKey)
  }

  resolve<T>(serviceId: string, consumerScope: PluginPlatformScope): RegisteredPluginService<T> | null {
    const normalizedServiceId = normalizeRegistryId(serviceId, 'service id')
    const candidates = [...this.servicesByNamespace.values()]
      .flat()
      .filter((service) => (
        service.descriptor.id === normalizedServiceId
        && isPluginPlatformScopeVisible(service.owner.scope, consumerScope)
      ))
      .sort(compareServiceCandidates)

    return (candidates[0] as RegisteredPluginService<T> | undefined) ?? null
  }

  listVisible(consumerScope: PluginPlatformScope): RegisteredPluginService[] {
    const winners = new Map<string, RegisteredPluginService>()
    const visible = [...this.servicesByNamespace.values()]
      .flat()
      .filter((service) => isPluginPlatformScopeVisible(service.owner.scope, consumerScope))
      .sort(compareServiceCandidates)

    for (const service of visible) {
      if (!winners.has(service.descriptor.id)) {
        winners.set(service.descriptor.id, service)
      }
    }
    return [...winners.values()].sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id))
  }
}

function normalizeStagedServices(services: readonly StagedPluginService[]): RegisteredPluginServiceDraft[] {
  return services.map((service) => ({
    descriptor: Object.freeze({
      id: normalizeRegistryId(service.descriptor.id, 'service id'),
      version: normalizeRegistryVersion(service.descriptor.version),
      priority: normalizeRegistryPriority(service.descriptor.priority)
    }),
    value: service.value
  }))
}

type RegisteredPluginServiceDraft = {
  descriptor: Required<PluginServiceDescriptor>
  value: unknown
}

function compareServiceCandidates(left: RegisteredPluginService, right: RegisteredPluginService): number {
  return getPluginPlatformScopeSpecificity(right.owner.scope)
    - getPluginPlatformScopeSpecificity(left.owner.scope)
    || right.descriptor.priority - left.descriptor.priority
    || left.owner.pluginId.localeCompare(right.owner.pluginId)
}
