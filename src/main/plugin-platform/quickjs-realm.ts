import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginJsonValue,
  PluginRevisionPackage
} from '@shared/plugin-platform'
import {
  EvalFlags,
  JSException,
  QuickJS,
  type Deferred,
  type JSValueHandle
} from 'quickjs-wasi'
import type {
  NoNodePluginRuntimeInstance,
  PluginRuntimeActivationSnapshot
} from './activation-coordinator'
import {
  clonePluginRuntimeJson,
  parsePluginRuntimeJson,
  stringifyPluginRuntimeJson
} from './runtime-json'
import { resolvePluginStandardModules } from './standard-modules'

const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024
const DEFAULT_EXECUTION_SLICE_MS = 250
const DEFAULT_ASYNC_COMMAND_TIMEOUT_MS = 10_000
const MAX_HANDLER_COUNT = 256
const MAX_ERROR_MESSAGE_CHARS = 2_000
const BRIDGE_PREFIX = '__knowbook_capability_bridge_'

type DeadlineControl = {
  deadline: number
}

export interface QuickJsWasiRealmOptions {
  memoryLimitBytes?: number
  executionSliceMs?: number
  asyncCommandTimeoutMs?: number
  wasm?: BufferSource | WebAssembly.Module
}

export interface QuickJsWasiRealmInput {
  identity: PluginActivationIdentity
  package: PluginRevisionPackage
  callCapability: (owner: PluginActiveOwner, call: PluginCapabilityCall) => Promise<PluginJsonValue>
  options?: QuickJsWasiRealmOptions
}

/**
 * One untrusted v2 plugin realm. Node is used only by this host adapter to load
 * the WASM binary; plugin source executes exclusively inside QuickJS.
 */
export class QuickJsWasiPluginRealm implements NoNodePluginRuntimeInstance {
  private readonly handlers = new Map<string, JSValueHandle>()
  private readonly pendingCapabilityPromises = new Set<Deferred>()
  private activateFunction: JSValueHandle | null = null
  private jsonParse: JSValueHandle | null = null
  private jsonStringify: JSValueHandle | null = null
  private owner: PluginActiveOwner | null = null
  private commandFailure: ((error: Error) => void) | null = null
  private disposed = false

  private constructor(
    private readonly vm: QuickJS,
    private readonly identity: PluginActivationIdentity,
    private readonly package_: PluginRevisionPackage,
    private readonly callCapability_: QuickJsWasiRealmInput['callCapability'],
    private readonly deadlineControl: DeadlineControl,
    private readonly executionSliceMs: number,
    private readonly asyncCommandTimeoutMs: number
  ) {}

  static async create(input: QuickJsWasiRealmInput): Promise<QuickJsWasiPluginRealm> {
    assertPackageIdentity(input.identity, input.package)
    const memoryLimitBytes = normalizePositiveLimit(
      input.options?.memoryLimitBytes,
      DEFAULT_MEMORY_LIMIT_BYTES,
      'QuickJS memory limit'
    )
    const executionSliceMs = normalizePositiveLimit(
      input.options?.executionSliceMs,
      DEFAULT_EXECUTION_SLICE_MS,
      'QuickJS execution slice'
    )
    const asyncCommandTimeoutMs = normalizePositiveLimit(
      input.options?.asyncCommandTimeoutMs,
      DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
      'QuickJS async command timeout'
    )
    const bridgeGlobalName = `${BRIDGE_PREFIX}${randomUUID().replaceAll('-', '')}`
    const standardModules = resolvePluginStandardModules(
      input.package.manifest.standardModules,
      bridgeGlobalName
    )
    const deadlineControl: DeadlineControl = { deadline: Number.POSITIVE_INFINITY }
    const wasm = input.options?.wasm ?? await loadQuickJsWasm()
    const vm = await QuickJS.create({
      wasm,
      memoryLimit: memoryLimitBytes,
      interruptHandler: () => performance.now() >= deadlineControl.deadline,
      timezoneOffset: 0,
      moduleLoader: {
        normalize: (_baseName, specifier) => {
          if (!standardModules.has(specifier)) {
            throw new Error(`Plugin import "${specifier}" is not declared or installed.`)
          }
          return specifier
        },
        load: (moduleName) => {
          const source = standardModules.get(moduleName)
          if (source === undefined) {
            throw new Error(`Plugin module "${moduleName}" is unavailable.`)
          }
          return source
        }
      },
      // Suppress QuickJS/WASI stdout and stderr. Plugin logs are a future,
      // quota-controlled capability rather than ambient process output.
      wasi: (memory) => ({
        fd_write: (_fd: number, iovsPointer: number, iovsLength: number, writtenPointer: number) => {
          const view = new DataView(memory.buffer)
          let written = 0
          for (let index = 0; index < iovsLength; index += 1) {
            written += view.getUint32(iovsPointer + index * 8 + 4, true)
          }
          view.setUint32(writtenPointer, written, true)
          return 0
        }
      })
    })

    const realm = new QuickJsWasiPluginRealm(
      vm,
      input.identity,
      input.package,
      input.callCapability,
      deadlineControl,
      executionSliceMs,
      asyncCommandTimeoutMs
    )
    try {
      await realm.initialize(standardModules, bridgeGlobalName)
      return realm
    } catch (error) {
      await realm.dispose()
      throw error
    }
  }

  async activate(): Promise<PluginRuntimeActivationSnapshot> {
    this.assertUsable()
    if (!this.activateFunction) {
      return { contributions: [] }
    }
    const context = {
      identity: this.identity,
      manifest: this.package_.manifest,
      views: this.package_.views
    }
    return await this.runJsonFunction(
      this.activateFunction,
      [context],
      'Plugin activation result'
    ) as unknown as PluginRuntimeActivationSnapshot
  }

  commit(owner: PluginActiveOwner): void {
    this.assertUsable()
    if (!sameActivationIdentity(this.identity, owner)) {
      throw new Error('Committed plugin owner does not match the isolated runtime identity.')
    }
    if (!Number.isSafeInteger(owner.epoch) || owner.epoch < 1) {
      throw new Error('Committed plugin owner epoch is invalid.')
    }
    this.owner = structuredClone(owner)
  }

  async invokeHandler(
    owner: PluginActiveOwner,
    handlerId: string,
    input: PluginJsonValue,
    signal: AbortSignal
  ): Promise<PluginJsonValue> {
    this.assertUsable()
    this.assertCurrentOwner(owner)
    const handler = this.handlers.get(handlerId)
    if (!handler) {
      throw new Error(`Plugin handler "${handlerId}" is not registered.`)
    }
    if (signal.aborted) {
      throw normalizeAbortReason(signal.reason)
    }

    return await Promise.race([
      this.runJsonFunction(handler, [input, { identity: owner }], `Plugin handler "${handlerId}" result`),
      rejectWhenAborted(signal)
    ])
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.owner = null
    this.commandFailure?.(new Error('QuickJS plugin realm was disposed.'))
    this.commandFailure = null
    for (const deferred of this.pendingCapabilityPromises) {
      try {
        const error = this.vm.newError('QuickJS plugin realm was disposed.')
        try {
          deferred.reject(error)
        } finally {
          error.dispose()
        }
      } catch {
        // The VM may already be unusable after a WASM trap.
      }
      deferred.handle.dispose()
    }
    this.pendingCapabilityPromises.clear()
    this.activateFunction?.dispose()
    this.activateFunction = null
    for (const handler of this.handlers.values()) {
      handler.dispose()
    }
    this.handlers.clear()
    this.jsonParse?.dispose()
    this.jsonParse = null
    this.jsonStringify?.dispose()
    this.jsonStringify = null
    this.vm.dispose()
  }

  private async initialize(
    standardModules: ReadonlyMap<string, string>,
    bridgeGlobalName: string
  ): Promise<void> {
    const helpers = this.runGuestSync(() => this.vm.evalCode(`Object.freeze({
      parse: JSON.parse,
      stringify: JSON.stringify
    })`, '<knowbook-json>'))
    try {
      this.jsonParse = helpers.getProp('parse')
      this.jsonStringify = helpers.getProp('stringify')
    } finally {
      helpers.dispose()
    }

    if (standardModules.has('@knowbook/std/plugin')) {
      const bridge = this.vm.newFunction(bridgeGlobalName, (...args) => {
        return this.handleCapabilityCall(args)
      })
      try {
        this.vm.setProp(this.vm.global, bridgeGlobalName, bridge)
      } finally {
        bridge.dispose()
      }
    }

    for (const moduleId of standardModules.keys()) {
      const preloadSource = `import ${JSON.stringify(moduleId)}; export {};`
      const namespace = await this.evaluateModule(preloadSource, `<preload:${moduleId}>`)
      namespace.dispose()
    }

    // The public standard module captures the only host callback in a module
    // closure. Ensure no bridge remains as an ambient global before user code.
    this.runGuestSync(() => {
      this.vm.evalCode(`delete globalThis[${JSON.stringify(bridgeGlobalName)}]`, '<bridge-cleanup>')
        .dispose()
    })

    const namespace = await this.evaluateModule(this.package_.workerSource, 'worker.js')
    try {
      this.capturePluginExports(namespace)
    } finally {
      namespace.dispose()
    }
  }

  private capturePluginExports(namespace: JSValueHandle): void {
    let definition: JSValueHandle | null = null
    const defaultExport = getDataProperty(namespace, 'default', 'Plugin default export')
    if (defaultExport && !defaultExport.isUndefined) {
      definition = defaultExport
    } else {
      defaultExport?.dispose()
      definition = namespace.dup()
    }

    try {
      if (!definition.isObject || definition.isProxy) {
        throw new Error('Plugin definition must be a non-Proxy object.')
      }
      const activate = getDataProperty(definition, 'activate', 'Plugin activate export')
      if (activate && !activate.isUndefined) {
        if (!activate.isFunction) {
          activate.dispose()
          throw new Error('Plugin activate export must be a function.')
        }
        this.activateFunction = activate
      } else {
        activate?.dispose()
      }

      const handlers = getDataProperty(definition, 'handlers', 'Plugin handlers export')
      if (handlers && !handlers.isUndefined) {
        try {
          this.captureHandlers(handlers)
        } finally {
          handlers.dispose()
        }
      } else {
        handlers?.dispose()
      }
    } finally {
      definition.dispose()
    }
  }

  private captureHandlers(handlers: JSValueHandle): void {
    if (!handlers.isObject || handlers.isArray || handlers.isProxy) {
      throw new Error('Plugin handlers export must be a non-Proxy object.')
    }
    const ids = handlers.keys()
    if (ids.length > MAX_HANDLER_COUNT) {
      throw new Error(`Plugin may register at most ${MAX_HANDLER_COUNT} handlers.`)
    }
    for (const id of ids) {
      if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(id) || id.length > 200) {
        throw new Error(`Plugin handler id "${id}" is invalid.`)
      }
      const handler = getDataProperty(handlers, id, `Plugin handler "${id}"`)
      if (!handler || !handler.isFunction) {
        handler?.dispose()
        throw new Error(`Plugin handler "${id}" must be a function data property.`)
      }
      this.handlers.set(id, handler)
    }
  }

  private async evaluateModule(source: string, filename: string): Promise<JSValueHandle> {
    const promise = this.runGuestSync(() => this.vm.evalCode(
      source,
      filename,
      EvalFlags.TYPE_MODULE | EvalFlags.STRICT
    ))
    try {
      return await this.awaitGuestValue(promise, `Module "${filename}" evaluation`)
    } finally {
      promise.dispose()
    }
  }

  private async runJsonFunction(
    function_: JSValueHandle,
    inputs: unknown[],
    label: string
  ): Promise<PluginJsonValue> {
    const arguments_ = inputs.map((input, index) => this.parseHostJson(
      input,
      `${label} argument ${index}`
    ))
    let result: JSValueHandle | null = null
    let settled: JSValueHandle | null = null
    try {
      result = this.runGuestSync(() => this.vm.callFunction(
        function_,
        this.vm.undefined,
        ...arguments_
      ))
      settled = await this.awaitGuestValue(result, label)
      return this.serializeGuestJson(settled, label)
    } finally {
      settled?.dispose()
      result?.dispose()
      for (const argument of arguments_) {
        argument.dispose()
      }
    }
  }

  private parseHostJson(value: unknown, label: string): JSValueHandle {
    const parse = this.requireJsonParse()
    const serialized = stringifyPluginRuntimeJson(value, label)
    const string = this.vm.newString(serialized)
    try {
      return this.runGuestSync(() => this.vm.callFunction(parse, this.vm.undefined, string))
    } finally {
      string.dispose()
    }
  }

  private serializeGuestJson(value: JSValueHandle, label: string): PluginJsonValue {
    const stringify = this.requireJsonStringify()
    const serialized = this.runGuestSync(() => this.vm.callFunction(
      stringify,
      this.vm.undefined,
      value
    ))
    try {
      if (!serialized.isString) {
        throw new Error(`${label} must be JSON serializable.`)
      }
      return parsePluginRuntimeJson(serialized.toString(), label)
    } finally {
      serialized.dispose()
    }
  }

  private handleCapabilityCall(args: JSValueHandle[]): JSValueHandle {
    const deferred = this.vm.newPromise()
    this.pendingCapabilityPromises.add(deferred)

    let call: PluginCapabilityCall
    let owner: PluginActiveOwner
    try {
      if (args.length !== 1 || !args[0].isString) {
        throw new Error('Capability bridge accepts exactly one serialized JSON argument.')
      }
      call = parseCapabilityCall(args[0].toString())
      owner = this.requireCurrentOwner()
    } catch (error) {
      this.rejectDeferred(deferred, error)
      return deferred.handle
    }

    void this.callCapability_(owner, call).then(
      (result) => this.resolveDeferred(deferred, result),
      (error) => this.rejectDeferred(deferred, error)
    )
    return deferred.handle
  }

  private resolveDeferred(deferred: Deferred, result: PluginJsonValue): void {
    if (!this.pendingCapabilityPromises.delete(deferred) || this.disposed) {
      return
    }
    try {
      const serialized = stringifyPluginRuntimeJson(result, 'Capability result')
      const handle = this.vm.newString(serialized)
      try {
        deferred.resolve(handle)
      } finally {
        handle.dispose()
        deferred.handle.dispose()
      }
      this.resumeGuestJobs()
    } catch (error) {
      deferred.handle.dispose()
      this.failCurrentCommand(normalizeError(error))
    }
  }

  private rejectDeferred(deferred: Deferred, error: unknown): void {
    if (!this.pendingCapabilityPromises.delete(deferred) && this.disposed) {
      return
    }
    if (this.disposed) {
      deferred.handle.dispose()
      return
    }
    try {
      const guestError = this.vm.newError(safeErrorMessage(error))
      try {
        deferred.reject(guestError)
      } finally {
        guestError.dispose()
        deferred.handle.dispose()
      }
      this.resumeGuestJobs()
    } catch (resumeError) {
      deferred.handle.dispose()
      this.failCurrentCommand(normalizeError(resumeError))
    }
  }

  private resumeGuestJobs(): void {
    try {
      this.runGuestSync(() => this.vm.executePendingJobs())
    } catch (error) {
      this.failCurrentCommand(normalizeError(error))
    }
  }

  private async awaitGuestValue(value: JSValueHandle, label: string): Promise<JSValueHandle> {
    if (!value.isPromise) {
      return value.dup()
    }
    const settlement = this.vm.resolvePromise(value)
    const commandFailure = new Promise<never>((_resolve, reject) => {
      this.commandFailure = reject
    })
    try {
      this.runGuestSync(() => this.vm.executePendingJobs())
      const result = await Promise.race([
        settlement,
        commandFailure,
        rejectAfter(this.asyncCommandTimeoutMs, `${label} timed out.`)
      ])
      if ('error' in result) {
        const error = guestExceptionToError(result.error, label)
        result.error.dispose()
        throw error
      }
      return result.value
    } finally {
      this.commandFailure = null
    }
  }

  private runGuestSync<T>(operation: () => T): T {
    this.assertUsable()
    this.deadlineControl.deadline = performance.now() + this.executionSliceMs
    try {
      return operation()
    } catch (error) {
      throw normalizeGuestError(error)
    } finally {
      this.deadlineControl.deadline = Number.POSITIVE_INFINITY
    }
  }

  private failCurrentCommand(error: Error): void {
    this.commandFailure?.(error)
  }

  private assertCurrentOwner(owner: PluginActiveOwner): void {
    const current = this.requireCurrentOwner()
    if (!sameActiveOwner(current, owner)) {
      throw new Error('Plugin invocation owner is stale.')
    }
  }

  private requireCurrentOwner(): PluginActiveOwner {
    if (!this.owner) {
      throw new Error('Plugin capabilities are unavailable before atomic commit.')
    }
    return this.owner
  }

  private requireJsonParse(): JSValueHandle {
    if (!this.jsonParse) {
      throw new Error('QuickJS JSON parser is unavailable.')
    }
    return this.jsonParse
  }

  private requireJsonStringify(): JSValueHandle {
    if (!this.jsonStringify) {
      throw new Error('QuickJS JSON serializer is unavailable.')
    }
    return this.jsonStringify
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('QuickJS plugin realm is disposed.')
    }
  }
}

let quickJsWasmPromise: Promise<Uint8Array> | null = null

export function loadQuickJsWasm(): Promise<Uint8Array> {
  if (!quickJsWasmPromise) {
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('quickjs-wasi/quickjs.wasm')
    quickJsWasmPromise = readFile(wasmPath)
  }
  return quickJsWasmPromise
}

function getDataProperty(
  object: JSValueHandle,
  key: string,
  label: string
): JSValueHandle | null {
  if (object.isProxy) {
    throw new Error(`${label} cannot be read from a Proxy.`)
  }
  const descriptor = object.getOwnPropertyDescriptor(key)
  if (!descriptor) {
    return null
  }
  descriptor.get?.dispose()
  descriptor.set?.dispose()
  if (!descriptor.value) {
    throw new Error(`${label} must be a data property.`)
  }
  return descriptor.value
}

function parseCapabilityCall(serialized: string): PluginCapabilityCall {
  const value = parsePluginRuntimeJson(serialized, 'Capability call')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Capability call must be an object.')
  }
  const unknownKey = Object.keys(value).find(
    (key) => !['callId', 'capability', 'version', 'input'].includes(key)
  )
  if (unknownKey) {
    throw new Error(`Capability call contains unknown field "${unknownKey}".`)
  }
  const capability = value.capability
  const version = value.version
  if (
    typeof capability !== 'string'
    || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(capability)
    || capability.length > 120
  ) {
    throw new Error('Capability call id is invalid.')
  }
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error('Capability call version is invalid.')
  }
  const callId = value.callId
  if (callId !== undefined && (typeof callId !== 'string' || !callId.trim() || callId.length > 200)) {
    throw new Error('Capability call callId is invalid.')
  }
  if (!Object.hasOwn(value, 'input')) {
    throw new Error('Capability call input is required.')
  }
  return {
    ...(callId === undefined ? {} : { callId }),
    capability,
    version: version as number,
    input: value.input
  }
}

function assertPackageIdentity(
  identity: PluginActivationIdentity,
  package_: PluginRevisionPackage
): void {
  if (identity.pluginId !== package_.manifest.id || identity.revisionId !== package_.revisionId) {
    throw new Error('Plugin package does not match the requested activation identity.')
  }
}

function sameActivationIdentity(
  identity: PluginActivationIdentity,
  owner: PluginActiveOwner
): boolean {
  return identity.pluginId === owner.pluginId
    && identity.revisionId === owner.revisionId
    && identity.runId === owner.runId
    && identity.grantSetId === owner.grantSetId
    && JSON.stringify(identity.scope) === JSON.stringify(owner.scope)
}

function sameActiveOwner(left: PluginActiveOwner, right: PluginActiveOwner): boolean {
  return sameActivationIdentity(left, right) && left.epoch === right.epoch
}

function normalizePositiveLimit(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return normalized
}

function normalizeGuestError(error: unknown): Error {
  if (error instanceof JSException) {
    const normalized = new Error(
      `${error.name || 'Error'}: ${error.message || 'QuickJS execution failed.'}`,
      { cause: error }
    )
    error.dispose()
    return normalized
  }
  return normalizeError(error)
}

function guestExceptionToError(handle: JSValueHandle, label: string): Error {
  if (handle.isError) {
    const name = getStringDataProperty(handle, 'name') ?? 'Error'
    const message = getStringDataProperty(handle, 'message') ?? `${label} rejected.`
    return new Error(`${name}: ${message}`)
  }
  if (handle.isString) {
    return new Error(`${label} rejected: ${handle.toString()}`)
  }
  return new Error(`${label} rejected.`)
}

function getStringDataProperty(object: JSValueHandle, key: string): string | null {
  const property = getDataProperty(object, key, `Guest error ${key}`)
  if (!property) {
    return null
  }
  try {
    return property.isString ? property.toString() : null
  } finally {
    property.dispose()
  }
}

function safeErrorMessage(error: unknown): string {
  return normalizeError(error).message.slice(0, MAX_ERROR_MESSAGE_CHARS)
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(error.trim().slice(0, MAX_ERROR_MESSAGE_CHARS))
  }
  return new Error('QuickJS plugin runtime failed.')
}

function normalizeAbortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Plugin invocation was cancelled.')
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(normalizeAbortReason(signal.reason)), { once: true })
  })
}

function rejectAfter(timeoutMs: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    timeout.unref?.()
  })
}
