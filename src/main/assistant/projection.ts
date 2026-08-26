import type {
  AssistantApprovalId,
  AssistantEvent,
  AssistantStepId,
  AssistantToolCallId,
  AssistantTurnId
} from '@shared/assistant-session'
import type { PluginJsonValue } from '@shared/plugin-platform'

const DEFAULT_MODEL_MESSAGE_LIMIT = 200_000
const DEFAULT_MODEL_ITEM_LIMIT = 32_000

export interface AssistantConversationMessage {
  eventId: string
  seq: number
  turnId: AssistantTurnId
  role: 'user' | 'assistant'
  text: string
}

export interface AssistantStreamingMessage {
  turnId: AssistantTurnId
  stepId: AssistantStepId
  text: string
  lastSeq: number
}

export interface AssistantPendingApproval {
  approvalId: AssistantApprovalId
  requestedEvent: Extract<AssistantEvent, { type: 'approval.requested' }>
}

export interface AssistantSessionProjection {
  messages: AssistantConversationMessage[]
  streaming: AssistantStreamingMessage[]
  trajectory: AssistantEvent[]
  pendingApprovals: AssistantPendingApproval[]
  activeTurnId: AssistantTurnId | null
  lastSeq: number
}

export interface AssistantModelMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: AssistantToolCallId
  tool?: {
    id: AssistantToolCallId
    name: string
    version: number
    arguments: PluginJsonValue
  }
}

export interface DeriveModelMessagesOptions {
  maxTotalCharacters?: number
  maxItemCharacters?: number
}

export function projectAssistantSession(events: readonly AssistantEvent[]): AssistantSessionProjection {
  assertOrdered(events)
  const messages: AssistantConversationMessage[] = []
  const trajectory: AssistantEvent[] = []
  const pendingApprovals = new Map<string, AssistantPendingApproval>()
  const streaming = new Map<string, AssistantStreamingMessage>()
  let activeTurnId: AssistantTurnId | null = null

  for (const event of events) {
    if (event.surface === 'trajectory') {
      trajectory.push(event)
    }
    switch (event.type) {
      case 'turn.started':
        activeTurnId = event.payload.turnId
        break
      case 'turn.ended':
        if (activeTurnId === event.payload.turnId) {
          activeTurnId = null
        }
        break
      case 'user.message':
        messages.push({
          eventId: event.id,
          seq: event.seq,
          turnId: event.payload.turnId,
          role: 'user',
          text: event.payload.text
        })
        break
      case 'assistant.chunk': {
        const key = `${event.payload.turnId}\0${event.payload.stepId}`
        const current = streaming.get(key)
        streaming.set(key, {
          turnId: event.payload.turnId,
          stepId: event.payload.stepId,
          text: `${current?.text ?? ''}${event.payload.text}`,
          lastSeq: event.seq
        })
        break
      }
      case 'assistant.message': {
        const key = `${event.payload.turnId}\0${event.payload.stepId}`
        streaming.delete(key)
        messages.push({
          eventId: event.id,
          seq: event.seq,
          turnId: event.payload.turnId,
          role: 'assistant',
          text: event.payload.text
        })
        break
      }
      case 'approval.requested':
        pendingApprovals.set(event.payload.approvalId, {
          approvalId: event.payload.approvalId,
          requestedEvent: event
        })
        break
      case 'approval.resolved':
        pendingApprovals.delete(event.payload.approvalId)
        break
    }
  }

  return {
    messages,
    streaming: [...streaming.values()].sort((left, right) => left.lastSeq - right.lastSeq),
    trajectory,
    pendingApprovals: [...pendingApprovals.values()],
    activeTurnId,
    lastSeq: events.at(-1)?.seq ?? 0
  }
}

/** Selectively derives provider context; audit/plugin lifecycle events never enter it. */
export function deriveAssistantModelMessages(
  events: readonly AssistantEvent[],
  options: DeriveModelMessagesOptions = {}
): AssistantModelMessage[] {
  assertOrdered(events)
  const maxTotal = normalizeLimit(
    options.maxTotalCharacters ?? DEFAULT_MODEL_MESSAGE_LIMIT,
    'Assistant model context limit'
  )
  const maxItem = normalizeLimit(
    options.maxItemCharacters ?? DEFAULT_MODEL_ITEM_LIMIT,
    'Assistant model item limit'
  )
  const messages: AssistantModelMessage[] = []
  const finalizedToolCalls = new Set<AssistantToolCallId>()
  for (const event of events) {
    if (event.type === 'tool.result' && event.payload.status !== 'awaiting-approval') {
      finalizedToolCalls.add(event.payload.toolCallId)
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'user.message':
        messages.push({ role: 'user', content: clampText(event.payload.text, maxItem) })
        break
      case 'assistant.message':
        messages.push({ role: 'assistant', content: clampText(event.payload.text, maxItem) })
        break
      case 'tool.call':
        messages.push({
          role: 'assistant',
          content: '',
          tool: {
            id: event.payload.toolCallId,
            name: event.payload.tool,
            version: event.payload.version,
            arguments: event.payload.arguments
          }
        })
        break
      case 'tool.result':
        // Approval pauses are UI/trajectory facts. Once a final result exists,
        // the provider must see exactly one response for the tool call id.
        if (event.payload.status === 'awaiting-approval' && finalizedToolCalls.has(event.payload.toolCallId)) {
          break
        }
        messages.push({
          role: 'tool',
          toolCallId: event.payload.toolCallId,
          content: clampText(
            `[UNTRUSTED_TOOL_RESULT status=${event.payload.status}]\n${JSON.stringify(event.payload.result)}`,
            maxItem
          )
        })
        break
    }
  }

  let characters = messages.reduce((total, message) => total + modelMessageSize(message), 0)
  while (messages.length > 0 && characters > maxTotal) {
    const removed = messages.shift() as AssistantModelMessage
    characters -= modelMessageSize(removed)
  }
  return messages
}

function assertOrdered(events: readonly AssistantEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]
    const current = events[index]
    if (current.sessionId !== previous.sessionId || current.seq <= previous.seq) {
      throw new Error('Assistant events must belong to one session in strictly increasing sequence order.')
    }
  }
}

function normalizeLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`${label} must be a positive integer at most 10000000.`)
  }
  return value
}

function clampText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }
  return `${value.slice(0, Math.max(0, limit - 14))}\n[TRUNCATED]`
}

function modelMessageSize(message: AssistantModelMessage): number {
  return message.content.length + (message.tool ? JSON.stringify(message.tool).length : 0)
}
