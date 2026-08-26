import type { PluginJsonValue, PluginPlatformScope } from './plugin-platform'

declare const assistantIdBrand: unique symbol
type AssistantId<Kind extends string> = string & { readonly [assistantIdBrand]: Kind }

export type AssistantSessionId = AssistantId<'session'>
export type AssistantTurnId = AssistantId<'turn'>
export type AssistantStepId = AssistantId<'step'>
export type AssistantToolCallId = AssistantId<'tool-call'>
export type AssistantApprovalId = AssistantId<'approval'>

export type AssistantSessionStatus = 'active' | 'cancelled' | 'error'

export interface AssistantSessionSummary {
  id: AssistantSessionId
  workspaceId: string
  title: string
  activeDocumentId: string | null
  modelConfig: PluginJsonValue
  status: AssistantSessionStatus
  activeTurnId: AssistantTurnId | null
  lastSeq: number
  createdAt: string
  updatedAt: string
}

export interface CreateAssistantSessionRequest {
  title?: string
  activeDocumentId?: string | null
}

export interface SendAssistantMessageRequest {
  sessionId: AssistantSessionId
  text: string
}

export interface SendAssistantMessageResult {
  sessionId: AssistantSessionId
  turnId: AssistantTurnId
  status: 'completed' | 'awaiting-approval' | 'cancelled' | 'failed'
}

export interface ResolveAssistantApprovalRequest {
  sessionId: AssistantSessionId
  approvalId: AssistantApprovalId
  decision: 'allowed-once' | 'rejected' | 'cancelled'
}

export interface AssistantSessionChangedEvent {
  sessionId: AssistantSessionId
  lastSeq: number
}

export type AssistantEventSurface = 'conversation' | 'trajectory' | 'audit-only'

export interface AssistantEventPayloadMap {
  'session.created': {
    title: string
    workspaceId: string
    activeDocumentId: string | null
    modelConfig: PluginJsonValue
  }
  'session.title.updated': { title: string }
  'turn.started': { turnId: AssistantTurnId }
  'turn.ended': {
    turnId: AssistantTurnId
    status: 'completed' | 'cancelled' | 'failed' | 'interrupted'
  }
  'step.started': {
    turnId: AssistantTurnId
    stepId: AssistantStepId
    provider: string
    model: string
    visibleTools: string[]
  }
  'step.ended': {
    turnId: AssistantTurnId
    stepId: AssistantStepId
    status: 'completed' | 'cancelled' | 'failed' | 'awaiting-approval'
    usage?: PluginJsonValue
  }
  'user.message': {
    turnId: AssistantTurnId
    text: string
    attachments?: PluginJsonValue[]
  }
  'assistant.chunk': {
    turnId: AssistantTurnId
    stepId: AssistantStepId
    text: string
  }
  'assistant.message': {
    turnId: AssistantTurnId
    stepId: AssistantStepId
    text: string
  }
  'tool.call': {
    turnId: AssistantTurnId
    stepId: AssistantStepId
    toolCallId: AssistantToolCallId
    tool: string
    version: number
    arguments: PluginJsonValue
  }
  'tool.result': {
    turnId: AssistantTurnId
    stepId: AssistantStepId
    toolCallId: AssistantToolCallId
    status: 'succeeded' | 'failed' | 'cancelled' | 'awaiting-approval'
    result: PluginJsonValue
  }
  'approval.requested': {
    turnId: AssistantTurnId
    toolCallId: AssistantToolCallId
    approvalId: AssistantApprovalId
    pluginId: string
    revisionId: string
    scope: PluginPlatformScope
    permissions: PluginJsonValue
    summary: string
    risk: 'low' | 'medium' | 'high'
    expiresAt: string
  }
  'approval.resolved': {
    approvalId: AssistantApprovalId
    decision: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    grantSetId?: string
  }
  'plugin.revision.defined': {
    turnId: AssistantTurnId
    pluginId: string
    revisionId: string
    previousRevisionId: string | null
  }
  'plugin.validation.completed': {
    turnId: AssistantTurnId
    pluginId: string
    revisionId: string
    status: 'passed' | 'warning' | 'failed'
    diagnostics: PluginJsonValue
  }
  'plugin.run.requested': {
    turnId: AssistantTurnId
    toolCallId: AssistantToolCallId
    pluginId: string
    revisionId: string
    runId: string
  }
  'plugin.run.started': { pluginId: string; revisionId: string; runId: string }
  'plugin.run.succeeded': { pluginId: string; revisionId: string; runId: string; epoch: number }
  'plugin.run.failed': { pluginId: string; revisionId: string; runId: string; error: PluginJsonValue }
  'plugin.run.stopped': { pluginId: string; revisionId: string; runId: string }
  'plugin.rollback.completed': {
    pluginId: string
    fromRevisionId: string
    toRevisionId: string
    runId: string
  }
  'session.cancelled': { reason: string }
  'session.error': { error: PluginJsonValue }
}

export type AssistantEventType = keyof AssistantEventPayloadMap

export type AssistantEvent<Type extends AssistantEventType = AssistantEventType> = {
  [EventType in Type]: {
    id: string
    sessionId: AssistantSessionId
    seq: number
    type: EventType
    surface: AssistantEventSurface
    payload: AssistantEventPayloadMap[EventType]
    createdAt: string
  }
}[Type]

export type AppendAssistantEventInput<Type extends AssistantEventType> = {
  type: Type
  payload: AssistantEventPayloadMap[Type]
}

export const ASSISTANT_EVENT_SURFACES: Readonly<Record<AssistantEventType, AssistantEventSurface>> = {
  'session.created': 'audit-only',
  'session.title.updated': 'audit-only',
  'turn.started': 'trajectory',
  'turn.ended': 'trajectory',
  'step.started': 'audit-only',
  'step.ended': 'audit-only',
  'user.message': 'conversation',
  'assistant.chunk': 'conversation',
  'assistant.message': 'conversation',
  'tool.call': 'trajectory',
  'tool.result': 'trajectory',
  'approval.requested': 'trajectory',
  'approval.resolved': 'trajectory',
  'plugin.revision.defined': 'trajectory',
  'plugin.validation.completed': 'trajectory',
  'plugin.run.requested': 'trajectory',
  'plugin.run.started': 'trajectory',
  'plugin.run.succeeded': 'trajectory',
  'plugin.run.failed': 'trajectory',
  'plugin.run.stopped': 'trajectory',
  'plugin.rollback.completed': 'trajectory',
  'session.cancelled': 'audit-only',
  'session.error': 'audit-only'
}

export function assistantSessionId(value: string): AssistantSessionId {
  return value as AssistantSessionId
}

export function assistantTurnId(value: string): AssistantTurnId {
  return value as AssistantTurnId
}

export function assistantStepId(value: string): AssistantStepId {
  return value as AssistantStepId
}

export function assistantToolCallId(value: string): AssistantToolCallId {
  return value as AssistantToolCallId
}

export function assistantApprovalId(value: string): AssistantApprovalId {
  return value as AssistantApprovalId
}
