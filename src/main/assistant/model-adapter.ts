import type { PluginJsonValue } from '@shared/plugin-platform'
import { buildAiChatCompletionsEndpoint } from '../ai-service'
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
  complete(input: AssistantModelCompletionInput): Promise<AssistantModelCompletion>
}

export interface OpenAiCompatibleAssistantModelAdapterOptions {
  fetchImplementation?: FetchImplementation
  timeoutMilliseconds?: number
}

export class OpenAiCompatibleAssistantModelAdapter implements AssistantModelAdapter {
  private readonly fetchImplementation: FetchImplementation
  private readonly timeoutMilliseconds: number

  constructor(options: OpenAiCompatibleAssistantModelAdapterOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async complete(input: AssistantModelCompletionInput): Promise<AssistantModelCompletion> {
    const endpoint = buildAiChatCompletionsEndpoint(input.baseUrl)
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
            Authorization: `Bearer ${input.apiKey}`
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
