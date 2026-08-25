import type { PluginStandardModuleRequest } from '@shared/plugin-platform'

export interface PluginStandardModuleDefinition {
  id: string
  version: string
  createSource: (bridgeGlobalName: string) => string
}

const PLUGIN_MODULE_ID = '@knowbook/std/plugin'
const PLUGIN_MODULE_VERSION = '1.0.0'

const BUILTIN_STANDARD_MODULES = new Map<string, PluginStandardModuleDefinition>([
  [standardModuleKey(PLUGIN_MODULE_ID, PLUGIN_MODULE_VERSION), {
    id: PLUGIN_MODULE_ID,
    version: PLUGIN_MODULE_VERSION,
    createSource: createPluginModuleSource
  }]
])

export function resolvePluginStandardModules(
  requests: readonly PluginStandardModuleRequest[],
  bridgeGlobalName: string
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>()
  for (const request of requests) {
    const definition = BUILTIN_STANDARD_MODULES.get(standardModuleKey(request.id, request.version))
    if (!definition) {
      throw new Error(`Standard module "${request.id}@${request.version}" is not installed.`)
    }
    resolved.set(definition.id, definition.createSource(bridgeGlobalName))
  }
  return resolved
}

export function listPluginStandardModules(): Array<{ id: string; version: string }> {
  return [...BUILTIN_STANDARD_MODULES.values()]
    .map(({ id, version }) => ({ id, version }))
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

function createPluginModuleSource(bridgeGlobalName: string): string {
  const globalKey = JSON.stringify(bridgeGlobalName)
  return `
const hostCall = globalThis[${globalKey}];
delete globalThis[${globalKey}];
if (typeof hostCall !== 'function') {
  throw new Error('KnowBook capability bridge is unavailable.');
}
const stringify = JSON.stringify;
const parse = JSON.parse;

export const version = '${PLUGIN_MODULE_VERSION}';

export function definePlugin(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('Plugin definition must be an object.');
  }
  return definition;
}

export async function callCapability(call) {
  const serialized = stringify(call);
  if (typeof serialized !== 'string') {
    throw new TypeError('Capability call must be JSON serializable.');
  }
  return parse(await hostCall(serialized));
}
`
}

function standardModuleKey(id: string, version: string): string {
  return `${id}\0${version}`
}
