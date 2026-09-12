import type { InvokeSystemPluginMainInput } from '@shared/contracts'
import {
  normalizeSystemPluginServiceRpcJson,
  type SystemPluginServiceRpcIdentity,
  type SystemPluginServiceRpcJson
} from './service-rpc'

export type SystemPluginRendererHandler = (
  input: SystemPluginServiceRpcJson
) => SystemPluginServiceRpcJson | Promise<SystemPluginServiceRpcJson>

export interface SystemPluginRendererBridgeOptions {
  isRevisionActive(identity: Readonly<SystemPluginServiceRpcIdentity>): boolean
  timeoutMs?: number
  maxConcurrentRequests?: number
  maxPayloadBytes?: number
}

interface Registration {
  handler: SystemPluginRendererHandler
  pending: Set<(error: Error) => void>
}

/** Revision-scoped Main handlers for the confirmed System Plugin v3 renderer. */
export class SystemPluginRendererBridge {
  private readonly registrations = new Map<string, Registration>()
  private readonly timeoutMs: number
  private readonly maxConcurrentRequests: number
  private readonly maxPayloadBytes: number
  private activeRequests = 0

  constructor(private readonly options: SystemPluginRendererBridgeOptions) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000, 'Renderer bridge timeout')
    this.maxConcurrentRequests = positiveInteger(options.maxConcurrentRequests, 32, 'Renderer bridge concurrency')
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes, 1_048_576, 'Renderer bridge payload size')
  }

  forPlugin(identity: SystemPluginServiceRpcIdentity): {
    handle(method: string, handler: SystemPluginRendererHandler): () => void
  } {
    const owner = Object.freeze(normalizeIdentity(identity))
    return Object.freeze({
      handle: (method: string, handler: SystemPluginRendererHandler): (() => void) => {
        const key = registrationKey(owner, normalizeMethod(method))
        if (typeof handler !== 'function') throw new TypeError('Renderer Main handler must be a function.')
        if (this.registrations.has(key)) throw new Error(`Renderer Main method "${method}" is already registered.`)
        const registration: Registration = { handler, pending: new Set() }
        this.registrations.set(key, registration)
        return () => {
          if (this.registrations.get(key) !== registration) return
          this.registrations.delete(key)
          for (const reject of registration.pending) {
            reject(new Error('Renderer Main handler has been disposed.'))
          }
          registration.pending.clear()
        }
      }
    })
  }

  async invoke(input: InvokeSystemPluginMainInput): Promise<SystemPluginServiceRpcJson> {
    const request = normalizeSystemPluginServiceRpcJson(input, this.maxPayloadBytes)
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Renderer Main request must be a plain object.')
    }
    if (Object.keys(request).some((key) => !['pluginId', 'revisionHash', 'method', 'input'].includes(key))) {
      throw new Error('Renderer Main request has an unsupported shape.')
    }
    const identity = normalizeIdentity(request)
    this.assertActive(identity)
    const method = normalizeMethod(request.method)
    const key = registrationKey(identity, method)
    const registration = this.registrations.get(key)
    if (!registration) throw new Error(`Renderer Main method "${method}" is not registered.`)
    if (this.activeRequests >= this.maxConcurrentRequests) throw new Error('Renderer Main bridge is busy.')

    this.activeRequests += 1
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectPending: (error: Error) => void = () => undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectPending = reject
      registration.pending.add(reject)
      timer = setTimeout(() => reject(new Error(`Renderer Main request timed out after ${this.timeoutMs}ms.`)), this.timeoutMs)
    })
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.assertActive(identity)
          if (this.registrations.get(key) !== registration) throw new Error('Renderer Main handler has been disposed.')
          return registration.handler(request.input ?? null)
        }),
        interrupted
      ])
      this.assertActive(identity)
      if (this.registrations.get(key) !== registration) throw new Error('Renderer Main handler has been disposed.')
      return normalizeSystemPluginServiceRpcJson(result, this.maxPayloadBytes)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      registration.pending.delete(rejectPending)
      this.activeRequests -= 1
    }
  }

  private assertActive(identity: SystemPluginServiceRpcIdentity): void {
    if (!this.options.isRevisionActive(identity)) {
      throw new Error('Renderer Main requests require the exact staging or active System Plugin v3 revision.')
    }
  }
}

function normalizeIdentity(input: { pluginId?: unknown; revisionHash?: unknown }): SystemPluginServiceRpcIdentity {
  const { pluginId, revisionHash } = input
  for (const value of [pluginId, revisionHash]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) {
      throw new Error('Renderer Main plugin identity is invalid.')
    }
  }
  return { pluginId: pluginId as string, revisionHash: revisionHash as string }
}

function normalizeMethod(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(value)) {
    throw new Error('Renderer Main method is invalid.')
  }
  return value
}

function registrationKey(identity: SystemPluginServiceRpcIdentity, method: string): string {
  return JSON.stringify([identity.pluginId, identity.revisionHash, method])
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new TypeError(`${label} must be a positive integer.`)
  return normalized
}
