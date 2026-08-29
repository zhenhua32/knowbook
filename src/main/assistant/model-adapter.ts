import type { PluginJsonValue } from '@shared/plugin-platform'
import { buildAiChatCompletionsEndpoint } from '../ai-service'
import { buildAiAuthorizationHeader } from '../ai-auth'
import type { AssistantModelMessage } from './projection'
import { clonePluginRuntimeJson } from '../plugin-platform/runtime-json'

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000
const MAX_ERROR_BODY_CHARS = 4_000

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export interface AssistantModelToolDefinition {
  /** Provider-safe function name. Canonical event names stay inside the host. */
  name: string
  eventName: string
  description: string
  parameters: PluginJsonValue
}

export interface AssistantModelCompletionInput {
  apiKey: string
  baseUrl: string
  model: string
  systemPrompt: string
  messages: readonly AssistantModelMessage[]
  tools: readonly AssistantModelToolDefinition[]
  signal?: AbortSignal
  onChunk?: (text: string) => void | Promise<void>
}

export interface AssistantModelToolCall {
  name: string
  arguments: PluginJsonValue
  /** Provider returned arguments that could not be parsed; the host must not execute this call. */
  argumentsError?: string
}

export interface AssistantModelCompletion {
  content: string
  toolCalls: AssistantModelToolCall[]
  /** Opaque provider reasoning that must be replayed with tool-call history. */
  reasoningContent?: string
  usage?: PluginJsonValue
}

export interface AssistantModelAdapter {
  readonly capabilities: {
    streaming: boolean
    nativeToolCalling: boolean
    jsonSchema: boolean
    multimodal: boolean
  }
  complete(input: AssistantModelCompletionInput): Promise<AssistantModelCompletion>
}

export interface OpenAiCompatibleAssistantModelAdapterOptions {
  fetchImplementation?: FetchImplementation
  timeoutMilliseconds?: number
}

export class OpenAiCompatibleAssistantModelAdapter implements AssistantModelAdapter {
  readonly capabilities = Object.freeze({
    streaming: true,
    nativeToolCalling: true,
    jsonSchema: true,
    multimodal: false
  })
  private readonly fetchImplementation: FetchImplementation
  private readonly timeoutMilliseconds: number

  constructor(options: OpenAiCompatibleAssistantModelAdapterOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async complete(input: AssistantModelCompletionInput): Promise<AssistantModelCompletion> {
    const endpoint = buildAiChatCompletionsEndpoint(input.baseUrl)
    const authorization = buildAiAuthorizationHeader(input.apiKey)
    const toolByEventName = new Map(input.tools.map((tool) => [tool.eventName, tool]))
    const toolByProviderName = new Map(input.tools.map((tool) => [tool.name, tool]))
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMilliseconds)
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutController.signal])
      : timeoutController.signal

    try {
      let response: Response
      try {
        response = await this.fetchImplementation(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authorization
          },
          body: JSON.stringify({
            model: input.model,
            messages: [
              { role: 'system', content: input.systemPrompt },
              ...input.messages.map((message) => toProviderMessage(message, toolByEventName))
            ],
            tools: input.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
              }
            })),
            stream: true,
            stream_options: { include_usage: true },
            temperature: 0.2
          }),
          signal
        })
      } catch (error) {
        if (input.signal?.aborted) {
          throw new Error('Assistant request was cancelled.', { cause: error })
        }
        if (timeoutController.signal.aborted) {
          throw new Error(`Assistant request timed out after ${this.timeoutMilliseconds} ms.`)
        }
        throw new Error(`Assistant request failed before the model responded: ${errorMessage(error)}`)
      }

      if (!response.ok) {
        const body = await readResponseText(response, signal).catch(() => response.statusText)
        throw new Error(`Assistant request failed (${response.status}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}`)
      }

      if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        return await parseStreamingCompletion(response, toolByProviderName, input.onChunk, signal)
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error(`Assistant model returned invalid JSON: ${errorMessage(error)}`)
      }
      return parseCompletion(payload, toolByProviderName)
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function parseStreamingCompletion(
  response: Response,
  toolByProviderName: ReadonlyMap<string, AssistantModelToolDefinition>,
  onChunk: AssistantModelCompletionInput['onChunk'],
  signal: AbortSignal
): Promise<AssistantModelCompletion> {
  if (!response.body) throw new Error('Assistant streaming response has no body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoningContent = ''
  let usage: PluginJsonValue | undefined
  let contentStreamMode: 'pending' | 'visible' | 'tool-markup' = 'pending'
  let pendingStreamText = ''
  const toolDeltas = new Map<number, { name: string; arguments: string; argumentsError?: string }>()
  const consumeText = async (text: string): Promise<void> => {
    if (!text) return
    content += text
    if (content.length > 100_000) throw new Error('Assistant stream text exceeds 100000 characters.')
    if (!onChunk) return
    if (contentStreamMode === 'visible') {
      await onChunk(text)
      return
    }
    if (contentStreamMode === 'tool-markup') return
    pendingStreamText += text
    const classification = classifyInitialStreamText(pendingStreamText)
    if (classification === 'pending') return
    contentStreamMode = classification
    if (classification === 'visible') await onChunk(pendingStreamText)
    pendingStreamText = ''
  }
  const consumeLine = async (line: string): Promise<void> => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch (error) {
      throw new Error('Assistant stream contains invalid JSON.', { cause: error })
    }
    const root = objectValue(payload, 'Assistant stream event')
    if (root.usage !== undefined) usage = clonePluginRuntimeJson(root.usage, 'Assistant stream usage')
    if (!Array.isArray(root.choices)) return
    for (const rawChoice of root.choices) {
      const choice = objectValue(rawChoice, 'Assistant stream choice')
      if (!choice.delta) continue
      const delta = objectValue(choice.delta, 'Assistant stream delta')
      if (delta.reasoning_content !== null && delta.reasoning_content !== undefined) {
        if (typeof delta.reasoning_content !== 'string') {
          throw new Error('Assistant stream reasoning content is invalid.')
        }
        reasoningContent += delta.reasoning_content
        if (reasoningContent.length > 100_000) {
          throw new Error('Assistant stream reasoning content exceeds 100000 characters.')
        }
      }
      const text = parseStreamingText(delta.content)
      await consumeText(text)
      // Several OpenAI-compatible providers emit an explicit null on ordinary
      // content/final chunks. It means "no tool-call delta", not malformed data.
      if (delta.tool_calls === null || delta.tool_calls === undefined) continue
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 16) {
        throw new Error('Assistant stream tool calls are invalid.')
      }
      for (const rawCall of delta.tool_calls) {
        const call = objectValue(rawCall, 'Assistant stream tool call')
        if (!Number.isSafeInteger(call.index) || (call.index as number) < 0 || (call.index as number) >= 16) {
          throw new Error('Assistant stream tool call index is invalid.')
        }
        const index = call.index as number
        const current = toolDeltas.get(index) ?? { name: '', arguments: '' }
        if (call.function !== null && call.function !== undefined) {
          const fn = objectValue(call.function, 'Assistant stream tool function')
          if (fn.name !== null && fn.name !== undefined) {
            if (typeof fn.name !== 'string') throw new Error('Assistant stream tool name is invalid.')
            current.name = mergeToolNameDelta(current.name, fn.name, toolByProviderName)
          }
          if (fn.arguments !== null && fn.arguments !== undefined) {
            if (typeof fn.arguments !== 'string') {
              current.argumentsError ??= 'Assistant stream tool arguments must be a JSON string.'
            } else {
              current.arguments = mergeToolArgumentDelta(current.arguments, fn.arguments)
              if (current.arguments.length > 1024 * 1024) throw new Error('Assistant stream tool arguments are too large.')
            }
          }
        }
        toolDeltas.set(index, current)
      }
    }
  }
  try {
    while (true) {
      if (signal.aborted) throw new Error('Assistant response body was cancelled.')
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = done ? '' : lines.pop() ?? ''
      for (const line of lines) await consumeLine(line)
      if (done) {
        if (buffer) await consumeLine(buffer)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const nativeToolCalls: AssistantModelToolCall[] = []
  for (const [, delta] of [...toolDeltas.entries()].sort(([left], [right]) => left - right)) {
    const tool = resolveProviderTool(delta.name, toolByProviderName)
    if (!tool) throw new Error(`Assistant model requested unavailable tool "${delta.name}".`)
    let arguments_: PluginJsonValue
    let argumentsError = delta.argumentsError
    if (argumentsError) {
      // A malformed model argument is recoverable at the agent boundary. Keep
      // the call name, replace the untrusted payload with an inert object, and
      // let the next model step regenerate the complete arguments. Never pass
      // the malformed text to a tool or persist it in assistant history.
      arguments_ = {}
    } else {
      try {
        arguments_ = clonePluginRuntimeJson(JSON.parse(delta.arguments || '{}'), `Assistant tool ${delta.name} arguments`)
      } catch (error) {
        arguments_ = {}
        argumentsError = `Assistant tool "${delta.name}" returned invalid streaming arguments: ${errorMessage(error)}`
      }
    }
    nativeToolCalls.push({
      name: tool.eventName,
      arguments: arguments_,
      ...(argumentsError ? { argumentsError } : {})
    })
  }
  const taggedToolCalls = parseTaggedToolCalls(content, toolByProviderName)
  const toolCalls = mergeRecoveredToolCalls(nativeToolCalls, taggedToolCalls)
  const normalizedContent = stripTaggedToolCalls(content).trim()
  if (pendingStreamText && normalizedContent) {
    await onChunk?.(normalizedContent)
  }
  if (!normalizedContent && toolCalls.length === 0) {
    throw new Error('Assistant model returned neither text nor tool calls.')
  }
  // Replay provider reasoning byte-for-byte at the string level. Some
  // compatible APIs validate this field against the preceding tool call.
  const normalizedReasoningContent = reasoningContent
  return {
    content: normalizedContent,
    toolCalls,
    ...(normalizedReasoningContent ? { reasoningContent: normalizedReasoningContent } : {}),
    ...(usage === undefined ? {} : { usage })
  }
}

function parseStreamingText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw new Error('Assistant streaming content is invalid.')
  return value.map((part) => {
    if (typeof part === 'string') return part
    const item = objectValue(part, 'Assistant streaming content part')
    return typeof item.text === 'string' ? item.text : ''
  }).join('')
}

function toProviderMessage(
  message: AssistantModelMessage,
  toolByEventName: ReadonlyMap<string, AssistantModelToolDefinition>
): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    }
  }
  if (message.tool) {
    const tool = toolByEventName.get(message.tool.name)
    if (!tool) {
      throw new Error(`Stored assistant tool "${message.tool.name}" is no longer available.`)
    }
    return {
      role: 'assistant',
      // MiMo and some other compatible providers require the content field to
      // remain present for tool-call history, even when its value is empty.
      content: message.content,
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      tool_calls: [{
        id: message.tool.id,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(message.tool.arguments)
        }
      }]
    }
  }
  return { role: message.role, content: message.content }
}

function parseCompletion(
  payload: unknown,
  toolByProviderName: ReadonlyMap<string, AssistantModelToolDefinition>
): AssistantModelCompletion {
  const root = objectValue(payload, 'Assistant response')
  if (!Array.isArray(root.choices) || root.choices.length === 0) {
    throw new Error('Assistant model returned no choices.')
  }
  const choice = objectValue(root.choices[0], 'Assistant response choice')
  const message = objectValue(choice.message, 'Assistant response message')
  const rawContent = parseContent(message.content)
  const reasoningContent = parseOptionalReasoningContent(message.reasoning_content)
  const nativeToolCalls: AssistantModelToolCall[] = []
  if (message.tool_calls !== null && message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) {
      throw new Error('Assistant model returned an invalid tool call list.')
    }
    for (const rawCall of message.tool_calls) {
      const call = objectValue(rawCall, 'Assistant tool call')
      const fn = objectValue(call.function, 'Assistant tool function')
      const providerName = requiredString(fn.name, 'Assistant tool name', 128)
      const tool = resolveProviderTool(providerName, toolByProviderName)
      if (!tool) {
        throw new Error(`Assistant model requested unavailable tool "${providerName}".`)
      }
      const rawArguments = fn.arguments === undefined || fn.arguments === null
        ? '{}'
        : typeof fn.arguments === 'string' ? fn.arguments : null
      let parsedArguments: PluginJsonValue
      let argumentsError: string | undefined
      if (rawArguments === null) {
        parsedArguments = {}
        argumentsError = `Assistant tool "${providerName}" returned invalid JSON arguments: arguments must be a JSON string.`
      } else {
        try {
          parsedArguments = clonePluginRuntimeJson(JSON.parse(rawArguments), `Assistant tool ${providerName} arguments`)
        } catch (error) {
          parsedArguments = {}
          argumentsError = `Assistant tool "${providerName}" returned invalid JSON arguments: ${errorMessage(error)}`
        }
      }
      nativeToolCalls.push({
        name: tool.eventName,
        arguments: parsedArguments,
        ...(argumentsError ? { argumentsError } : {})
      })
    }
  }
  const taggedToolCalls = parseTaggedToolCalls(rawContent, toolByProviderName)
  const toolCalls = mergeRecoveredToolCalls(nativeToolCalls, taggedToolCalls)
  const content = stripTaggedToolCalls(rawContent).trim()
  if (!content && toolCalls.length === 0) {
    throw new Error('Assistant model returned neither text nor tool calls.')
  }
  return {
    content,
    toolCalls,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(root.usage === undefined ? {} : {
      usage: clonePluginRuntimeJson(root.usage, 'Assistant model usage')
    })
  }
}

function parseOptionalReasoningContent(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string' || value.length > 100_000) {
    throw new Error('Assistant model returned invalid reasoning content.')
  }
  return value
}

function classifyInitialStreamText(value: string): 'pending' | 'visible' | 'tool-markup' {
  const probe = value.trimStart()
  if (!probe) return 'pending'
  const markers = ['<tool_call>', '<tool_call', '<function=']
  if (markers.some((marker) => probe.startsWith(marker))) return 'tool-markup'
  if (markers.some((marker) => marker.startsWith(probe))) return 'pending'
  return 'visible'
}

function mergeToolNameDelta(
  current: string,
  incoming: string,
  tools: ReadonlyMap<string, AssistantModelToolDefinition>
): string {
  if (!current) return incoming
  if (!incoming || incoming === current) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current
  const combined = current + incoming
  if (tools.has(combined)) return combined
  // Some compatible gateways repeat the complete function name on the final
  // snapshot. If either side is already a published name, prefer that exact
  // identity instead of manufacturing name+name.
  if (tools.has(current) && tools.has(incoming)) return incoming
  return combined
}

function resolveProviderTool(
  rawName: string,
  tools: ReadonlyMap<string, AssistantModelToolDefinition>
): AssistantModelToolDefinition | undefined {
  const name = rawName.trim()
  const exact = tools.get(name)
  if (exact) return exact
  // Last-resort normalization for streams that duplicated a complete name
  // before this host version could merge the snapshots.
  const repeated = [...tools.entries()].find(([candidate]) => (
    name.length > candidate.length
    && name.length % candidate.length === 0
    && candidate.repeat(name.length / candidate.length) === name
  ))
  return repeated?.[1]
}

function parseTaggedToolCalls(
  content: string,
  tools: ReadonlyMap<string, AssistantModelToolDefinition>
): AssistantModelToolCall[] {
  if (!content.includes('<tool_call') || !content.includes('<function=')) return []
  const calls: AssistantModelToolCall[] = []
  const functionPattern = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g
  for (const match of content.matchAll(functionPattern)) {
    const tool = resolveProviderTool(match[1] ?? '', tools)
    if (!tool) continue
    const body = match[2] ?? ''
    const rawArguments: Record<string, PluginJsonValue> = {}
    const propertySchemas = schemaProperties(tool.parameters)
    const parameterPattern = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
    let valid = true
    for (const parameter of body.matchAll(parameterPattern)) {
      const key = parameter[1] ?? ''
      if (!key || Object.hasOwn(rawArguments, key)) {
        valid = false
        break
      }
      try {
        rawArguments[key] = parseTaggedParameter(parameter[2] ?? '', propertySchemas[key])
      } catch {
        valid = false
        break
      }
    }
    if (!valid || Object.keys(rawArguments).length === 0) continue
    try {
      calls.push({
        name: tool.eventName,
        arguments: clonePluginRuntimeJson(rawArguments, `Assistant tagged tool ${tool.name} arguments`)
      })
    } catch {
      // Keep the malformed native call as a recoverable error if the tagged
      // representation also exceeds runtime JSON limits.
    }
  }
  return calls
}

function schemaProperties(schema: PluginJsonValue): Record<string, PluginJsonValue> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const properties = schema.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties
    : {}
}

function parseTaggedParameter(rawValue: string, schema: PluginJsonValue | undefined): PluginJsonValue {
  const value = decodeTaggedEntities(rawValue.trim())
  const types = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? Array.isArray(schema.type)
      ? schema.type.filter((entry): entry is string => typeof entry === 'string')
      : typeof schema.type === 'string' ? [schema.type] : []
    : []
  try {
    const parsed = JSON.parse(value) as unknown
    if (types.length === 0 || types.some((type) => matchesTaggedType(parsed, type))) {
      return clonePluginRuntimeJson(parsed, 'Assistant tagged tool parameter')
    }
  } catch {
    // Tagged tool dialects normally omit quotes around string parameters.
  }
  if (types.includes('string')) return decodeLooseStringEscapes(value)
  throw new Error('Assistant tagged tool parameter does not match its schema type.')
}

function matchesTaggedType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number'
    case 'integer': return Number.isSafeInteger(value)
    case 'array': return Array.isArray(value)
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    default: return false
  }
}

function decodeTaggedEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function decodeLooseStringEscapes(value: string): string {
  return value
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\n')
    .replaceAll('\\t', '\t')
}

function mergeRecoveredToolCalls(
  nativeCalls: readonly AssistantModelToolCall[],
  taggedCalls: readonly AssistantModelToolCall[]
): AssistantModelToolCall[] {
  if (taggedCalls.length === 0) return [...nativeCalls]
  if (nativeCalls.length === 0) return [...taggedCalls]
  const remaining = [...taggedCalls]
  const merged = nativeCalls.map((nativeCall) => {
    const recoveredIndex = remaining.findIndex((candidate) => candidate.name === nativeCall.name)
    if (recoveredIndex < 0) return nativeCall
    const recovered = remaining.splice(recoveredIndex, 1)[0] as AssistantModelToolCall
    return nativeCall.argumentsError ? recovered : nativeCall
  })
  return [...merged, ...remaining]
}

function stripTaggedToolCalls(content: string): string {
  if (!content.includes('<tool_call')) return content
  return content
    .replace(/<tool_call>\s*<function=[^>\s]+>[\s\S]*?<\/function>\s*<\/tool_call>/g, '')
    .replace(/<tool_call[\s\S]*$/g, '')
}

/**
 * OpenAI-compatible providers normally emit argument fragments, but some
 * proxies emit a cumulative snapshot (or repeat the final snapshot). Prefer
 * an unambiguous complete JSON value when one is available so a duplicated
 * snapshot does not poison the tool call.
 */
function mergeToolArgumentDelta(current: string, incoming: string): string {
  if (!current) return incoming
  if (!incoming) return current

  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  // Both values being complete JSON is only meaningful as a repeated or
  // cumulative provider snapshot; keep the newest complete representation.
  if (looksLikeCompleteJson(current) && looksLikeCompleteJson(incoming)
    && isJsonText(current) && isJsonText(incoming)) {
    return incoming
  }
  const overlap = longestBoundaryOverlap(current, incoming)
  if (overlap >= 8) return current + incoming.slice(overlap)
  // Keep ordinary fragments opaque here; the completed value is parsed once
  // after the stream ends. This avoids repeatedly parsing a growing
  // workerSource string when a provider emits many small deltas.
  return current + incoming
}

function longestBoundaryOverlap(current: string, incoming: string): number {
  const maximum = Math.min(current.length, incoming.length)
  for (let length = maximum; length >= 8; length -= 1) {
    if (current.endsWith(incoming.slice(0, length))) return length
  }
  return 0
}

function isJsonText(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function looksLikeCompleteJson(value: string): boolean {
  const trimmed = value.trimEnd()
  return trimmed.endsWith('}') || trimmed.endsWith(']')
}

function parseContent(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value.trim()
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') {
        return part
      }
      const item = objectValue(part, 'Assistant content part')
      return typeof item.text === 'string' ? item.text : ''
    }).join('').trim()
  }
  throw new Error('Assistant model returned invalid message content.')
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    throw new Error('Assistant response body was cancelled.')
  }
  return await Promise.race([
    response.text(),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Assistant response body was cancelled.')), {
        once: true
      })
    })
  ])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
