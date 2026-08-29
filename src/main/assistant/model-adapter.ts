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
}

export interface AssistantModelCompletion {
  content: string
  toolCalls: AssistantModelToolCall[]
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
            tool_choice: 'auto',
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
  let usage: PluginJsonValue | undefined
  const toolDeltas = new Map<number, { name: string; arguments: string }>()
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
      const text = parseStreamingText(delta.content)
      if (text) {
        content += text
        if (content.length > 100_000) throw new Error('Assistant stream text exceeds 100000 characters.')
        await onChunk?.(text)
      }
      if (delta.tool_calls === undefined) continue
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
        if (call.function !== undefined) {
          const fn = objectValue(call.function, 'Assistant stream tool function')
          if (fn.name !== undefined) {
            if (typeof fn.name !== 'string') throw new Error('Assistant stream tool name is invalid.')
            current.name += fn.name
          }
          if (fn.arguments !== undefined) {
            if (typeof fn.arguments !== 'string') throw new Error('Assistant stream tool arguments are invalid.')
            current.arguments += fn.arguments
            if (current.arguments.length > 1024 * 1024) throw new Error('Assistant stream tool arguments are too large.')
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
  const toolCalls: AssistantModelToolCall[] = []
  for (const [, delta] of [...toolDeltas.entries()].sort(([left], [right]) => left - right)) {
    const tool = toolByProviderName.get(delta.name)
    if (!tool) throw new Error(`Assistant model requested unavailable tool "${delta.name}".`)
    let arguments_: unknown
    try {
      arguments_ = JSON.parse(delta.arguments || '{}')
    } catch (error) {
      throw new Error(`Assistant tool "${delta.name}" returned invalid streaming arguments.`, { cause: error })
    }
    toolCalls.push({
      name: tool.eventName,
      arguments: clonePluginRuntimeJson(arguments_, `Assistant tool ${delta.name} arguments`)
    })
  }
  const normalizedContent = content.trim()
  if (!normalizedContent && toolCalls.length === 0) {
    throw new Error('Assistant model returned neither text nor tool calls.')
  }
  return { content: normalizedContent, toolCalls, ...(usage === undefined ? {} : { usage }) }
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
      content: message.content || null,
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
  const content = parseContent(message.content)
  const toolCalls: AssistantModelToolCall[] = []
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) {
      throw new Error('Assistant model returned an invalid tool call list.')
    }
    for (const rawCall of message.tool_calls) {
      const call = objectValue(rawCall, 'Assistant tool call')
      const fn = objectValue(call.function, 'Assistant tool function')
      const providerName = requiredString(fn.name, 'Assistant tool name', 128)
      const tool = toolByProviderName.get(providerName)
      if (!tool) {
        throw new Error(`Assistant model requested unavailable tool "${providerName}".`)
      }
      const rawArguments = typeof fn.arguments === 'string' ? fn.arguments : '{}'
      let parsedArguments: unknown
      try {
        parsedArguments = JSON.parse(rawArguments)
      } catch (error) {
        throw new Error(`Assistant tool "${providerName}" returned invalid JSON arguments: ${errorMessage(error)}`)
      }
      toolCalls.push({
        name: tool.eventName,
        arguments: clonePluginRuntimeJson(parsedArguments, `Assistant tool ${providerName} arguments`)
      })
    }
  }
  if (!content && toolCalls.length === 0) {
    throw new Error('Assistant model returned neither text nor tool calls.')
  }
  return {
    content,
    toolCalls,
    ...(root.usage === undefined ? {} : {
      usage: clonePluginRuntimeJson(root.usage, 'Assistant model usage')
    })
  }
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
