import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginJsonValue
} from '@shared/plugin-platform'
import { QuickJsWasiPluginRealm } from './quickjs-realm'
import {
  activationSnapshotToJson,
  fromQuickJsRuntimePackagePayload,
  type QuickJsRuntimeCapabilityResult,
  type QuickJsRuntimeHostMessage,
  type QuickJsRuntimeProcessMessage,
  type QuickJsRuntimeRequest
} from './quickjs-runtime-protocol'
import { clonePluginRuntimeJson } from './runtime-json'

const MAX_ERROR_CHARS = 2_000

type PendingCapability = {
  owner: PluginActiveOwner
  resolve: (value: PluginJsonValue) => void
  reject: (error: Error) => void
}

class QuickJsRuntimeServer {
  private readonly pendingCapabilities = new Map<number, PendingCapability>()
  private readonly activeRequests = new Map<number, AbortController>()
  private realm: QuickJsWasiPluginRealm | null = null
  private identity: PluginActivationIdentity | null = null
  private owner: PluginActiveOwner | null = null
  private capabilitySequence = 0

  constructor(private readonly send: (message: QuickJsRuntimeProcessMessage) => void) {}

  async execute(request: QuickJsRuntimeRequest): Promise<PluginJsonValue> {
    if (request.command.type === 'initialize') {
      return this.initialize(request)
    }

    const identity = this.requireIdentity()
    if (!sameActivationIdentity(identity, request.identity)) {
      throw new Error('Runtime request identity is stale or invalid.')
    }

    switch (request.command.type) {
      case 'activate':
        return activationSnapshotToJson(await this.requireRealm().activate())
      case 'migrate-state':
        return clonePluginRuntimeJson(
          await this.requireRealm().migrateState(request.command.input),
          'Runtime state migration output'
        )
      case 'validate-handlers':
        this.requireRealm().validateHandlers(request.command.handlerIds)
        return null
      case 'health':
        return clonePluginRuntimeJson(this.requireRealm().health(), 'Runtime health')
      case 'invoke-handler': {
        if (!('epoch' in request.identity)) {
          throw new Error('Handler invocation requires an active owner identity.')
        }
        this.commit(request.identity)
        const controller = new AbortController()
        this.activeRequests.set(request.requestId, controller)
        try {
          return await this.requireRealm().invokeHandler(
            request.identity,
            request.command.handlerId,
            clonePluginRuntimeJson(request.command.input, 'Runtime handler input'),
            controller.signal
          )
        } finally {
          this.activeRequests.delete(request.requestId)
        }
      }
      case 'dispose':
        await this.dispose()
        return null
      default:
        throw new Error('Unknown QuickJS runtime command.')
    }
  }

  commit(owner: PluginActiveOwner): void {
    const identity = this.requireIdentity()
    if (!sameActivationIdentity(identity, owner)) {
      throw new Error('Runtime commit owner is stale or invalid.')
    }
    if (this.owner && !sameActiveOwner(this.owner, owner)) {
      throw new Error('Runtime has already committed a different owner.')
    }
    this.requireRealm().commit(owner)
    this.owner = structuredClone(owner)
  }

  cancel(requestId: number, identity: PluginActivationIdentity | PluginActiveOwner): void {
    const current = this.identity
    if (!current || !sameActivationIdentity(current, identity)) {
      return
    }
    this.activeRequests.get(requestId)?.abort(new Error('Plugin handler invocation was cancelled.'))
  }

  resolveCapability(message: QuickJsRuntimeCapabilityResult): void {
    const pending = this.pendingCapabilities.get(message.capabilityRequestId)
    if (!pending || !sameActiveOwner(pending.owner, message.identity)) {
      return
    }
    this.pendingCapabilities.delete(message.capabilityRequestId)
    if (message.ok && message.output !== undefined) {
      pending.resolve(clonePluginRuntimeJson(message.output, 'Runtime capability result'))
      return
    }
    pending.reject(new Error(safeError(message.error, 'Capability call failed.')))
  }

  async dispose(): Promise<void> {
    for (const controller of this.activeRequests.values()) {
      controller.abort(new Error('QuickJS runtime was disposed.'))
    }
    this.activeRequests.clear()
    for (const pending of this.pendingCapabilities.values()) {
      pending.reject(new Error('QuickJS runtime was disposed.'))
    }
    this.pendingCapabilities.clear()
    const realm = this.realm
    this.realm = null
    this.owner = null
    if (realm) {
      await realm.dispose()
    }
  }

  private async initialize(request: QuickJsRuntimeRequest): Promise<PluginJsonValue> {
    if (this.realm || this.identity) {
      throw new Error('QuickJS runtime has already been initialized.')
    }
    if (!isActivationIdentity(request.identity) || 'epoch' in request.identity) {
      throw new Error('Runtime initialization identity is invalid.')
    }
    const identity = structuredClone(request.identity)
    const package_ = fromQuickJsRuntimePackagePayload(request.command.type === 'initialize'
      ? request.command.package
      : neverCommand())
    this.identity = identity
    try {
      this.realm = await QuickJsWasiPluginRealm.create({
        identity,
        package: package_,
        callCapability: (owner, call) => this.callCapability(owner, call)
      })
      return null
    } catch (error) {
      this.identity = null
      throw error
    }
  }

  private callCapability(
    owner: PluginActiveOwner,
    call: PluginCapabilityCall
  ): Promise<PluginJsonValue> {
    if (!this.owner || !sameActiveOwner(this.owner, owner)) {
      return Promise.reject(new Error('Runtime capability owner is stale or unavailable.'))
    }
    const capabilityRequestId = ++this.capabilitySequence
    return new Promise<PluginJsonValue>((resolve, reject) => {
      this.pendingCapabilities.set(capabilityRequestId, { owner, resolve, reject })
      this.send({
        kind: 'capability-call',
        capabilityRequestId,
        identity: owner,
        call: clonePluginRuntimeJson(call, 'Runtime capability call') as unknown as PluginCapabilityCall
      })
    })
  }

  private requireRealm(): QuickJsWasiPluginRealm {
    if (!this.realm) {
      throw new Error('QuickJS runtime is not initialized.')
    }
    return this.realm
  }

  private requireIdentity(): PluginActivationIdentity {
    if (!this.identity) {
      throw new Error('QuickJS runtime is not initialized.')
    }
    return this.identity
  }
}

function neverCommand(): never {
  throw new Error('Invalid runtime initialize command.')
}

function isActivationIdentity(value: unknown): value is PluginActivationIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.pluginId === 'string'
    && typeof candidate.revisionId === 'string'
    && typeof candidate.runId === 'string'
    && typeof candidate.grantSetId === 'string'
    && !!candidate.scope
    && typeof candidate.scope === 'object'
}

function sameActivationIdentity(
  left: PluginActivationIdentity,
  right: PluginActivationIdentity | PluginActiveOwner
): boolean {
  return left.pluginId === right.pluginId
    && left.revisionId === right.revisionId
    && left.runId === right.runId
    && left.grantSetId === right.grantSetId
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
}

function sameActiveOwner(left: PluginActiveOwner, right: PluginActiveOwner): boolean {
  return sameActivationIdentity(left, right) && left.epoch === right.epoch
}

function safeError(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().slice(0, MAX_ERROR_CHARS)
  }
  return fallback
}

function errorMessage(error: unknown): string {
  return safeError(error instanceof Error ? error.message : error, 'QuickJS runtime command failed.')
}

const parentPort = process.parentPort
const server = new QuickJsRuntimeServer((message) => parentPort.postMessage(message))
let commandQueue = Promise.resolve()

parentPort.on('message', (event) => {
  const message = event.data as QuickJsRuntimeHostMessage
  if (!message || typeof message !== 'object') {
    return
  }
  if (message.kind === 'capability-result') {
    server.resolveCapability(message)
    return
  }
  if (message.kind === 'cancel') {
    server.cancel(message.requestId, message.identity)
    return
  }
  if (message.kind === 'commit') {
    try {
      server.commit(message.identity)
    } catch {
      // The next request will fail the same identity check and surface it.
    }
    return
  }
  if (message.kind !== 'request' || !Number.isSafeInteger(message.requestId)) {
    return
  }

  commandQueue = commandQueue.then(async () => {
    let response: QuickJsRuntimeProcessMessage
    try {
      const output = await server.execute(message)
      response = {
        kind: 'response',
        requestId: message.requestId,
        identity: message.identity,
        ok: true,
        output
      }
    } catch (error) {
      response = {
        kind: 'response',
        requestId: message.requestId,
        identity: message.identity,
        ok: false,
        error: errorMessage(error)
      }
    }
    parentPort.postMessage(response)
  }).catch((error) => {
    parentPort.postMessage({
      kind: 'response',
      requestId: message.requestId,
      identity: message.identity,
      ok: false,
      error: errorMessage(error)
    } satisfies QuickJsRuntimeProcessMessage)
  })
})
