import type { PluginJsonValue, PluginPlatformScope } from '@shared/plugin-platform'
import { clonePluginRuntimeJson } from '../plugin-platform/runtime-json'
import type { AssistantModelToolDefinition } from './model-adapter'

export interface AssistantToolDescriptor extends AssistantModelToolDefinition {
  version: 1
  outputSchema: PluginJsonValue
  display: { title: string; category: 'inspect' | 'workspace' | 'documents' | 'plugins' }
  visibleScopes: readonly PluginPlatformScope['kind'][]
  concurrentSafe: boolean
  requiredCapabilities: readonly string[]
  approvalPolicy: 'none' | 'user-intent' | 'explicit-revision'
  timeoutMs: number
  maxResultBytes: number
}

export interface AssistantToolExecutionContext {
  scope: PluginPlatformScope
  signal: AbortSignal
  grantedCapabilities?: readonly string[]
}

export class AssistantToolRegistry {
  private readonly tools = new Map<string, AssistantToolDescriptor>()
  private readonly activeExecutions = new Map<string, number>()
  private readonly guards: Array<(
    descriptor: AssistantToolDescriptor,
    context: AssistantToolExecutionContext,
    args: PluginJsonValue
  ) => boolean | Promise<boolean>> = []

  register(descriptor: AssistantToolDescriptor): void {
    if (this.tools.has(descriptor.eventName)) {
      throw new Error(`Assistant tool "${descriptor.eventName}" is already registered.`)
    }
    if (descriptor.version !== 1 || descriptor.timeoutMs < 1 || descriptor.maxResultBytes < 1) {
      throw new Error(`Assistant tool "${descriptor.eventName}" limits are invalid.`)
    }
    this.tools.set(descriptor.eventName, Object.freeze({ ...descriptor }))
  }

  addMonotonicGuard(guard: AssistantToolRegistry['guards'][number]): () => void {
    this.guards.push(guard)
    return () => {
      const index = this.guards.indexOf(guard)
      if (index >= 0) this.guards.splice(index, 1)
    }
  }

  listModelTools(): AssistantModelToolDefinition[] {
    return [...this.tools.values()].map(({ name, eventName, description, parameters }) => ({
      name, eventName, description, parameters
    }))
  }

  listDescriptors(): AssistantToolDescriptor[] {
    return [...this.tools.values()].map((descriptor) => structuredClone(descriptor))
  }

  validateArguments(name: string, raw: PluginJsonValue): PluginJsonValue {
    const descriptor = this.require(name)
    const args = clonePluginRuntimeJson(raw, `Assistant tool ${name} arguments`)
    validateClosedObjectSchema(args, descriptor.parameters, `Assistant tool ${name} arguments`)
    return args
  }

  async execute(
    name: string,
    args: PluginJsonValue,
    context: AssistantToolExecutionContext,
    operation: (signal: AbortSignal) => Promise<PluginJsonValue>
  ): Promise<PluginJsonValue> {
    const descriptor = this.require(name)
    if (!descriptor.visibleScopes.includes(context.scope.kind)) {
      throw new Error(`Assistant tool "${name}" is not visible in ${context.scope.kind} scope.`)
    }
    for (const guard of this.guards) {
      if (!await guard(descriptor, context, args)) {
        throw new Error(`Assistant tool "${name}" was denied by a monotonic guard.`)
      }
    }
    if (context.grantedCapabilities) {
      const granted = new Set(context.grantedCapabilities)
      const missing = descriptor.requiredCapabilities.find((capability) => !granted.has(capability))
      if (missing) throw new Error(`Assistant tool "${name}" requires capability "${missing}".`)
    }
    const active = this.activeExecutions.get(name) ?? 0
    if (!descriptor.concurrentSafe && active > 0) {
      throw new Error(`Assistant tool "${name}" does not allow concurrent execution.`)
    }
    if (context.signal.aborted) throw abortError(context.signal.reason)
    const controller = new AbortController()
    const abort = () => controller.abort(context.signal.reason)
    context.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error(
      `Assistant tool "${name}" timed out after ${descriptor.timeoutMs}ms.`
    )), descriptor.timeoutMs)
    this.activeExecutions.set(name, active + 1)
    try {
      const result = await Promise.race([
        operation(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(abortError(controller.signal.reason)), { once: true })
        })
      ])
      const normalized = clonePluginRuntimeJson(result, `Assistant tool ${name} result`)
      validateJsonSchema(normalized, descriptor.outputSchema, `Assistant tool ${name} result`)
      if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > descriptor.maxResultBytes) {
        throw new Error(`Assistant tool "${name}" result exceeds ${descriptor.maxResultBytes} bytes.`)
      }
      return normalized
    } finally {
      clearTimeout(timeout)
      context.signal.removeEventListener('abort', abort)
      const remaining = (this.activeExecutions.get(name) ?? 1) - 1
      if (remaining > 0) this.activeExecutions.set(name, remaining)
      else this.activeExecutions.delete(name)
    }
  }

  private require(name: string): AssistantToolDescriptor {
    const descriptor = this.tools.get(name)
    if (!descriptor) throw new Error(`Assistant tool "${name}" is unavailable.`)
    return descriptor
  }
}

function validateClosedObjectSchema(value: PluginJsonValue, schema: PluginJsonValue, label: string): void {
  validateJsonSchema(value, schema, label)
}

function validateJsonSchema(value: PluginJsonValue, schema: PluginJsonValue, label: string): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return
  const allowedTypes = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === 'string')
    : typeof schema.type === 'string' ? [schema.type] : []
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    throw new Error(`${label} must match type ${allowedTypes.join(' or ')}.`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    throw new Error(`${label} is not an allowed value.`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${label} is below its minimum.`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${label} exceeds its maximum.`)
  }
  if (typeof value === 'string' && typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    throw new Error(`${label} exceeds its maximum length.`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${label} has too many items.`)
    if (schema.items !== undefined) {
      value.forEach((entry, index) => validateJsonSchema(entry, schema.items as PluginJsonValue, `${label}[${index}]`))
    }
    return
  }
  if (!value || typeof value !== 'object') return
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {}
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key))
    if (unknown) throw new Error(`${label} contains unknown field "${unknown}".`)
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (typeof key === 'string' && !Object.hasOwn(value, key)) throw new Error(`${label} requires ${key}.`)
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) validateJsonSchema(value[key], propertySchema, `${label}.${key}`)
  }
}

function matchesType(value: PluginJsonValue, type: string): boolean {
  switch (type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'string': return typeof value === 'string'
    case 'array': return Array.isArray(value)
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    default: return false
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Assistant tool execution was cancelled.')
}
