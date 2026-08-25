import type { PluginPlatformScope } from '@shared/plugin-platform'

const MAX_SCOPE_ID_LENGTH = 500

export function validatePluginPlatformScope(scope: PluginPlatformScope): void {
  switch (scope.kind) {
    case 'app':
      return
    case 'workspace':
      requireScopeId(scope.workspaceId, 'workspace id')
      return
    case 'session':
      requireScopeId(scope.workspaceId, 'workspace id')
      requireScopeId(scope.sessionId, 'session id')
  }
}

export function getPluginPlatformScopeKey(scope: PluginPlatformScope): string {
  validatePluginPlatformScope(scope)
  switch (scope.kind) {
    case 'app':
      return 'app'
    case 'workspace':
      return `workspace:${encodeURIComponent(scope.workspaceId)}`
    case 'session':
      return `session:${encodeURIComponent(scope.workspaceId)}:${encodeURIComponent(scope.sessionId)}`
  }
}

export function getPluginNamespaceKey(pluginId: string, scope: PluginPlatformScope): string {
  return `${getPluginPlatformScopeKey(scope)}::${pluginId}`
}

export function getPluginPlatformScopeSpecificity(scope: PluginPlatformScope): number {
  switch (scope.kind) {
    case 'app':
      return 0
    case 'workspace':
      return 1
    case 'session':
      return 2
  }
}

export function isPluginPlatformScopeVisible(
  provider: PluginPlatformScope,
  consumer: PluginPlatformScope
): boolean {
  if (provider.kind === 'app') {
    return true
  }
  if (provider.kind === 'workspace') {
    return consumer.kind !== 'app' && provider.workspaceId === consumer.workspaceId
  }
  return consumer.kind === 'session'
    && provider.workspaceId === consumer.workspaceId
    && provider.sessionId === consumer.sessionId
}

function requireScopeId(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Plugin ${label} is required.`)
  }
  if (value.length > MAX_SCOPE_ID_LENGTH) {
    throw new Error(`Plugin ${label} exceeds ${MAX_SCOPE_ID_LENGTH} characters.`)
  }
}
