import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  FullTrustPluginContext,
  FullTrustPluginIdentity,
  FullTrustPluginRuntimeBindings,
  SystemPluginDisposable
} from './types'

const RESERVED_CONTEXT_KEYS = new Set([
  'plugin',
  'require',
  'process',
  'registerDisposable'
])

export function createPluginRootRequire(pluginRoot: string): NodeRequire {
  return createRequire(pathToFileURL(join(pluginRoot, 'package.json')))
}

export function createFullTrustPluginContext<TServices extends object>(input: {
  identity: FullTrustPluginIdentity
  services: TServices
  rootRequire?: NodeRequire
  process?: NodeJS.Process
  registerDisposable(disposable: SystemPluginDisposable, label?: string): void
}): FullTrustPluginContext<TServices> {
  assertObject(input.services, 'Full Trust plugin services')
  for (const key of Object.keys(input.services)) {
    if (RESERVED_CONTEXT_KEYS.has(key)) {
      throw new Error(`Full Trust plugin services cannot override runtime field "${key}".`)
    }
  }

  const plugin = Object.freeze({ ...input.identity })
  const bindings: FullTrustPluginRuntimeBindings = {
    plugin,
    require: input.rootRequire ?? createPluginRootRequire(plugin.root),
    process: input.process ?? process,
    registerDisposable: input.registerDisposable
  }

  return Object.assign({}, input.services, bindings) as FullTrustPluginContext<TServices>
}

function assertObject(value: object, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
}
