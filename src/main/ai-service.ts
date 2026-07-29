import type {
  DocumentDetail,
  PreviewDocumentBlockAiEditInput
} from '@shared/contracts'

const DEFAULT_AI_REQUEST_TIMEOUT_MS = 60_000
const MAX_AI_ERROR_BODY_LENGTH = 4_000

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export type AiChatCompletionInput = {
  apiKey: string
  baseUrl: string
  emptyResponseMessage: string
  failureLabel: string
  model: string
  systemPrompt: string
  temperature: number
  userPrompt: string
  signal?: AbortSignal
}

type AiChatCompletionOptions = {
  fetchImplementation?: FetchImplementation
  timeoutMilliseconds?: number
}

export function shouldGenerateDocumentSummary(
  summary: string,
  blockContents: string[],
  defaultSummary: string
): boolean {
  const normalizedSummary = summary.trim()
  if (normalizedSummary && normalizedSummary !== defaultSummary) {
    return false
  }

  const contentLength = blockContents
    .map((content) => content.trim())
    .filter((content) => content.length > 0)
    .join(' ')
    .trim()
    .length

  return contentLength >= 40
}

export function getDocumentSummarySourceVersion(detail: DocumentDetail): string {
  return JSON.stringify([
    detail.title,
    detail.path,
    detail.summary,
    detail.blocks.map((block) => [
      block.id,
      block.type,
      block.content,
      block.checked,
      block.depth,
      block.parentBlockId
    ])
  ])
}

export function normalizeGeneratedDocumentSummary(summary: string): string | null {
  const normalizedSummary = summary
    .replace(/[\r\n]+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/^[-*\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  return normalizedSummary || null
}

export function resolveDocumentBlockAiEditInstruction(
  input: PreviewDocumentBlockAiEditInput
): string {
  switch (input.mode) {
    case 'summarize':
      return 'Summarize the selected content into concise note content.'
    case 'rewrite':
      return 'Rewrite the selected content for clarity and readability while preserving meaning.'
    case 'table':
      return 'Convert the selected content into a single Markdown table.'
    case 'custom': {
      const instruction = input.instruction?.trim()
      if (!instruction) {
        throw new Error('Custom AI edit instruction is required.')
      }

      return instruction
    }
  }
}

export function normalizeDocumentBlockAiEditResponse(
  mode: PreviewDocumentBlockAiEditInput['mode'],
  responseText: string
): string {
  if (mode !== 'table') {
    return responseText
  }

  const fencedMatch = responseText.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return fencedMatch?.[1]?.trim() || responseText
}

export function buildAiChatCompletionsEndpoint(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim()
  if (!trimmedBaseUrl) {
    throw new Error('Missing AI Base URL. Save a Base URL in AI settings.')
  }

  let endpointUrl: URL
  try {
    endpointUrl = new URL(trimmedBaseUrl)
  } catch {
    throw new Error(`Invalid AI Base URL "${trimmedBaseUrl}". Include http:// or https://.`)
  }

  if (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') {
    throw new Error(`Invalid AI Base URL protocol "${endpointUrl.protocol}". Use http:// or https://.`)
  }

  endpointUrl.search = ''
  endpointUrl.hash = ''
  const normalizedPath = endpointUrl.pathname.replace(/\/+$/, '')
  endpointUrl.pathname = /\/chat\/completions$/i.test(normalizedPath)
    ? normalizedPath
    : `${normalizedPath}/chat/completions`.replace(/\/{2,}/g, '/')
  return endpointUrl.toString()
}

export async function requestAiChatCompletion(
  input: AiChatCompletionInput,
  options: AiChatCompletionOptions = {}
): Promise<string> {
  const endpoint = buildAiChatCompletionsEndpoint(input.baseUrl)
  const fetchImplementation = options.fetchImplementation ?? fetch
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_AI_REQUEST_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds)

  let response: Response
  try {
    response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: 'system',
            content: input.systemPrompt
          },
          {
            role: 'user',
            content: input.userPrompt
          }
        ],
        temperature: input.temperature
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, timeoutSignal])
        : timeoutSignal
    })
  } catch (error) {
    if (input.signal?.aborted) {
      throw error
    }

    if (timeoutSignal.aborted) {
      throw new Error(`${input.failureLabel} timed out after ${timeoutMilliseconds} ms. Endpoint: ${endpoint}.`)
    }

    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${input.failureLabel} failed before the AI service responded. Check the AI Base URL, network connectivity, proxy, and TLS certificate. Endpoint: ${endpoint}. Reason: ${reason}`)
  }

  if (!response.ok) {
    let errorBody = ''
    try {
      errorBody = (await response.text()).slice(0, MAX_AI_ERROR_BODY_LENGTH)
    } catch {
      errorBody = response.statusText
    }
    throw new Error(`${input.failureLabel} failed (${response.status}): ${errorBody}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${input.failureLabel} returned invalid JSON. Endpoint: ${endpoint}. Reason: ${reason}`)
  }

  const content = getAiMessageContent(payload)
  if (!content) {
    throw new Error(input.emptyResponseMessage)
  }

  return content
}

function getAiMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('choices' in payload)) {
    return null
  }

  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) {
    return null
  }

  const firstChoice = choices[0]
  if (!firstChoice || typeof firstChoice !== 'object' || !('message' in firstChoice)) {
    return null
  }

  const message = (firstChoice as { message?: unknown }).message
  if (!message || typeof message !== 'object' || !('content' in message)) {
    return null
  }

  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content.trim() || null : null
}
