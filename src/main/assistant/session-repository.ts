import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  ASSISTANT_EVENT_SURFACES,
  assistantApprovalId,
  assistantSessionId,
  assistantTurnId,
  type AppendAssistantEventInput,
  type AssistantApprovalId,
  type AssistantEvent,
  type AssistantEventPayloadMap,
  type AssistantEventSurface,
  type AssistantEventType,
  type AssistantSessionId,
  type AssistantTurnId
} from '@shared/assistant-session'
import type { PluginJsonValue, PluginPlatformScope } from '@shared/plugin-platform'
import { validatePluginPlatformScope } from '../plugin-platform/scope'

const MAX_EVENT_BYTES = 1024 * 1024
const MAX_EVENT_DEPTH = 32
const MAX_EVENT_ITEMS = 20_000
const MAX_EVENT_PAGE_SIZE = 1_000

export type AssistantSessionStatus = 'active' | 'cancelled' | 'error'

export interface AssistantSessionRecord {
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

export interface CreateAssistantSessionInput {
  id?: AssistantSessionId
  workspaceId: string
  title: string
  activeDocumentId?: string | null
  modelConfig: PluginJsonValue
}

type SessionRow = {
  id: string
  workspace_id: string
  title: string
  active_document_id: string | null
  model_config_json: string
  status: AssistantSessionStatus
  active_turn_id: string | null
  next_seq: number
  created_at: string
  updated_at: string
}

type EventRow = {
  id: string
  session_id: string
  seq: number
  type: AssistantEventType
  surface: AssistantEventSurface
  payload_json: string
  created_at: string
}

export interface SqliteAssistantSessionRepositoryOptions {
  now?: () => Date
}

/** Append-only fact store for assistant messages, tools, approvals, and plugin runs. */
export class SqliteAssistantSessionRepository {
  private readonly now: () => Date

  constructor(
    private readonly db: Database.Database,
    options: SqliteAssistantSessionRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  createSession(input: CreateAssistantSessionInput): AssistantSessionRecord {
    const id = input.id ?? assistantSessionId(randomUUID())
    const sessionId = normalizeId(id, 'Assistant session id')
    const workspaceId = normalizeId(input.workspaceId, 'Assistant workspace id')
    const title = normalizeText(input.title, 'Assistant session title', 500)
    const activeDocumentId = input.activeDocumentId
      ? normalizeId(input.activeDocumentId, 'Assistant active document id')
      : null
    const modelConfig = normalizeEventJson(input.modelConfig, 'Assistant model config')
    const modelConfigJson = JSON.stringify(modelConfig)
    const now = this.now().toISOString()

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO assistant_sessions (
          id, workspace_id, title, active_document_id, model_config_json,
          status, active_turn_id, next_seq, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 2, ?, ?)
      `).run(sessionId, workspaceId, title, activeDocumentId, modelConfigJson, now, now)
      const payload: AssistantEventPayloadMap['session.created'] = {
        title,
        workspaceId,
        activeDocumentId,
        modelConfig
      }
      this.insertEvent(sessionId, 1, 'session.created', payload, now)
      return this.requireSession(sessionId)
    })
    return transaction()
  }

  getSession(sessionId: AssistantSessionId | string): AssistantSessionRecord | null {
    const id = normalizeId(sessionId, 'Assistant session id')
    const row = this.db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? mapSession(row) : null
  }

  listSessions(): AssistantSessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM assistant_sessions ORDER BY updated_at DESC, id ASC
    `).all() as SessionRow[]
    return rows.map(mapSession)
  }

  append<Type extends Exclude<AssistantEventType, 'session.created'>>(
    sessionId: AssistantSessionId | string,
    input: AppendAssistantEventInput<Type>,
    expectedLastSeq?: number
  ): AssistantEvent<Type> {
    const id = normalizeId(sessionId, 'Assistant session id')
    const type = normalizeAppendableEventType(input.type)
    const payload = normalizeEventJson(input.payload, `Assistant event ${type}`)
    validateEventPayload(type, payload)
    const now = this.now().toISOString()

    const transaction = this.db.transaction(() => {
      const session = this.requireSession(id)
      const lastSeq = session.lastSeq
      if (expectedLastSeq !== undefined && expectedLastSeq !== lastSeq) {
        throw new Error(
          `Assistant session sequence conflict: expected ${expectedLastSeq}, current ${lastSeq}.`
        )
      }
      this.validateTransition(session, type, payload)
      const seq = lastSeq + 1
      const event = this.insertEvent(id, seq, type, payload, now) as AssistantEvent<Type>
      this.applySessionProjection(session, type, payload, seq, now)
      return event
    })
    return transaction()
  }

  listEvents(
    sessionId: AssistantSessionId | string,
    afterSeq = 0,
    limit = 500
  ): AssistantEvent[] {
    const id = normalizeId(sessionId, 'Assistant session id')
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error('Assistant event cursor must be a non-negative integer.')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE) {
      throw new Error(`Assistant event page size must be from 1 to ${MAX_EVENT_PAGE_SIZE}.`)
    }
    this.requireSession(id)
    const rows = this.db.prepare(`
      SELECT id, session_id, seq, type, surface, payload_json, created_at
      FROM assistant_events
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(id, afterSeq, limit) as EventRow[]
    return rows.map(mapEvent)
  }

  /** Converts crash leftovers into explicit facts; never replays unfinished tools. */
  recoverInterruptedSessions(): AssistantEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM assistant_sessions
      WHERE status = 'active' AND active_turn_id IS NOT NULL
      ORDER BY updated_at ASC, id ASC
    `).all() as SessionRow[]
    const appended: AssistantEvent[] = []

    for (const row of rows) {
      const session = mapSession(row)
      const pendingApprovals = this.getPendingApprovals(session.id)
      for (const approvalId of pendingApprovals) {
        appended.push(this.append(session.id, {
          type: 'approval.resolved',
          payload: { approvalId, decision: 'unavailable' }
        }))
      }
      appended.push(this.append(session.id, {
        type: 'turn.ended',
        payload: {
          turnId: session.activeTurnId as AssistantTurnId,
          status: 'interrupted'
        }
      }))
    }
    return appended
  }

  private validateTransition(
    session: AssistantSessionRecord,
    type: Exclude<AssistantEventType, 'session.created'>,
    payload: PluginJsonValue
  ): void {
    if (session.status !== 'active') {
      throw new Error(`Assistant session "${session.id}" is ${session.status}.`)
    }
    const candidate = payload as Record<string, PluginJsonValue>
    const payloadTurnId = typeof candidate.turnId === 'string' ? candidate.turnId : null

    if (type === 'turn.started') {
      if (session.activeTurnId) {
        throw new Error(`Assistant session already has active turn "${session.activeTurnId}".`)
      }
      return
    }
    if (type === 'turn.ended') {
      if (!session.activeTurnId || payloadTurnId !== session.activeTurnId) {
        throw new Error('Assistant turn end does not match the active turn.')
      }
      return
    }
    if (payloadTurnId && payloadTurnId !== session.activeTurnId) {
      throw new Error('Assistant event turn does not match the active turn.')
    }
    if (requiresActiveTurn(type) && !session.activeTurnId) {
      throw new Error(`Assistant event "${type}" requires an active turn.`)
    }
  }

  private applySessionProjection(
    session: AssistantSessionRecord,
    type: Exclude<AssistantEventType, 'session.created'>,
    payload: PluginJsonValue,
    nextSeq: number,
    now: string
  ): void {
    const candidate = payload as Record<string, PluginJsonValue>
    let title = session.title
    let status = session.status
    let activeTurnId: string | null = session.activeTurnId
    if (type === 'session.title.updated') {
      title = candidate.title as string
    } else if (type === 'turn.started') {
      activeTurnId = candidate.turnId as string
    } else if (type === 'turn.ended') {
      activeTurnId = null
    } else if (type === 'session.cancelled') {
      status = 'cancelled'
      activeTurnId = null
    } else if (type === 'session.error') {
      status = 'error'
      activeTurnId = null
    }

    this.db.prepare(`
      UPDATE assistant_sessions
      SET title = ?, status = ?, active_turn_id = ?, next_seq = ?, updated_at = ?
      WHERE id = ?
    `).run(title, status, activeTurnId, nextSeq + 1, now, session.id)
  }

  private insertEvent<Type extends AssistantEventType>(
    sessionId: string,
    seq: number,
    type: Type,
    payload: AssistantEventPayloadMap[Type] | PluginJsonValue,
    createdAt: string
  ): AssistantEvent<Type> {
    const eventId = randomUUID()
    const surface = ASSISTANT_EVENT_SURFACES[type]
    const payloadJson = JSON.stringify(payload)
    const payloadRecord = payload as Record<string, unknown>
    const turnId = typeof payloadRecord.turnId === 'string' ? payloadRecord.turnId : null
    const stepId = typeof payloadRecord.stepId === 'string' ? payloadRecord.stepId : null
    this.db.prepare(`
      INSERT INTO assistant_events (
        id, session_id, seq, type, surface, turn_id, step_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, sessionId, seq, type, surface, turnId, stepId, payloadJson, createdAt)
    return {
      id: eventId,
      sessionId: assistantSessionId(sessionId),
      seq,
      type,
      surface,
      payload: payload as AssistantEventPayloadMap[Type],
      createdAt
    } as AssistantEvent<Type>
  }

  private getPendingApprovals(sessionId: AssistantSessionId): AssistantApprovalId[] {
    const pending = new Map<string, AssistantApprovalId>()
    let cursor = 0
    while (true) {
      const events = this.listEvents(sessionId, cursor, MAX_EVENT_PAGE_SIZE)
      for (const event of events) {
        if (event.type === 'approval.requested') {
          pending.set(event.payload.approvalId, event.payload.approvalId)
        } else if (event.type === 'approval.resolved') {
          pending.delete(event.payload.approvalId)
        }
      }
      if (events.length < MAX_EVENT_PAGE_SIZE) {
        break
      }
      cursor = events.at(-1)?.seq ?? cursor
    }
    return [...pending.values()]
  }

  private requireSession(sessionId: string): AssistantSessionRecord {
    const session = this.getSession(sessionId)
    if (!session) {
      throw new Error(`Assistant session "${sessionId}" does not exist.`)
    }
    return session
  }
}

function mapSession(row: SessionRow): AssistantSessionRecord {
  if (!Number.isSafeInteger(row.next_seq) || row.next_seq < 2) {
    throw new Error('Assistant session sequence is corrupt.')
  }
  return {
    id: assistantSessionId(row.id),
    workspaceId: row.workspace_id,
    title: row.title,
    activeDocumentId: row.active_document_id,
    modelConfig: parseJson(row.model_config_json, 'Assistant model config'),
    status: row.status,
    activeTurnId: row.active_turn_id ? assistantTurnId(row.active_turn_id) : null,
    lastSeq: row.next_seq - 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapEvent(row: EventRow): AssistantEvent {
  if (!(row.type in ASSISTANT_EVENT_SURFACES)) {
    throw new Error(`Stored assistant event type "${row.type}" is unknown.`)
  }
  if (row.surface !== ASSISTANT_EVENT_SURFACES[row.type]) {
    throw new Error(`Stored assistant event "${row.id}" has an invalid surface.`)
  }
  const payload = parseJson(row.payload_json, `Assistant event ${row.id}`)
  validateEventPayload(row.type, payload)
  return {
    id: row.id,
    sessionId: assistantSessionId(row.session_id),
    seq: row.seq,
    type: row.type,
    surface: row.surface,
    payload,
    createdAt: row.created_at
  } as AssistantEvent
}

function normalizeAppendableEventType(value: unknown): Exclude<AssistantEventType, 'session.created'> {
  if (
    typeof value !== 'string'
    || value === 'session.created'
    || !(value in ASSISTANT_EVENT_SURFACES)
  ) {
    throw new Error('Assistant event type is invalid or host-owned.')
  }
  return value as Exclude<AssistantEventType, 'session.created'>
}

function validateEventPayload(type: AssistantEventType, payload: PluginJsonValue): void {
  if (!isPlainObject(payload)) {
    throw new Error(`Assistant event "${type}" payload must be an object.`)
  }
  const requiredStrings = requiredStringFields(type)
  for (const field of requiredStrings) {
    if (typeof payload[field] !== 'string' || !(payload[field] as string).trim()) {
      throw new Error(`Assistant event "${type}" requires ${field}.`)
    }
  }
  switch (type) {
    case 'session.created':
      requireOwnField(payload, 'modelConfig', type)
      return
    case 'turn.ended':
      assertEnum(payload.status, ['completed', 'cancelled', 'failed', 'interrupted'], 'turn status')
      return
    case 'step.started':
      if (!Array.isArray(payload.visibleTools) || payload.visibleTools.some((tool) => typeof tool !== 'string')) {
        throw new Error('Assistant visibleTools must be a string array.')
      }
      return
    case 'step.ended':
      assertEnum(payload.status, ['completed', 'cancelled', 'failed', 'awaiting-approval'], 'step status')
      return
    case 'tool.call':
      if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 1) {
        throw new Error('Assistant tool call version must be a positive integer.')
      }
      requireOwnField(payload, 'arguments', type)
      return
    case 'tool.result':
      assertEnum(payload.status, ['succeeded', 'failed', 'cancelled', 'awaiting-approval'], 'tool result status')
      requireOwnField(payload, 'result', type)
      return
    case 'plugin.run.succeeded':
      if (!Number.isSafeInteger(payload.epoch) || (payload.epoch as number) < 1) {
        throw new Error('Assistant plugin run epoch must be a positive integer.')
      }
      return
    case 'approval.requested':
      if (!['low', 'medium', 'high'].includes(payload.risk as string)) {
        throw new Error('Assistant approval risk is invalid.')
      }
      if (!Number.isFinite(Date.parse(payload.expiresAt as string))) {
        throw new Error('Assistant approval expiration is invalid.')
      }
      requireOwnField(payload, 'permissions', type)
      requireOwnField(payload, 'scope', type)
      try {
        validatePluginPlatformScope(payload.scope as unknown as PluginPlatformScope)
      } catch (error) {
        throw new Error('Assistant approval scope is invalid.', { cause: error })
      }
      return
    case 'approval.resolved':
      if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(payload.decision as string)) {
        throw new Error('Assistant approval decision is invalid.')
      }
      return
    case 'plugin.validation.completed':
      assertEnum(payload.status, ['passed', 'warning', 'failed'], 'plugin validation status')
      requireOwnField(payload, 'diagnostics', type)
      return
    case 'plugin.run.failed':
      requireOwnField(payload, 'error', type)
      return
    case 'session.error':
      requireOwnField(payload, 'error', type)
      return
    default:
      return
  }
}

function requireOwnField(
  payload: Record<string, PluginJsonValue>,
  field: string,
  type: AssistantEventType
): void {
  if (!Object.hasOwn(payload, field)) {
    throw new Error(`Assistant event "${type}" requires ${field}.`)
  }
}

function assertEnum(value: PluginJsonValue | undefined, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Assistant ${label} is invalid.`)
  }
}

function requiredStringFields(type: AssistantEventType): string[] {
  switch (type) {
    case 'session.created': return ['title', 'workspaceId']
    case 'session.title.updated': return ['title']
    case 'turn.started': return ['turnId']
    case 'turn.ended': return ['turnId', 'status']
    case 'step.started': return ['turnId', 'stepId', 'provider', 'model']
    case 'step.ended': return ['turnId', 'stepId', 'status']
    case 'user.message': return ['turnId', 'text']
    case 'assistant.chunk': return ['turnId', 'stepId', 'text']
    case 'assistant.message': return ['turnId', 'stepId', 'text']
    case 'tool.call': return ['turnId', 'stepId', 'toolCallId', 'tool']
    case 'tool.result': return ['turnId', 'stepId', 'toolCallId', 'status']
    case 'approval.requested': return [
      'turnId', 'toolCallId', 'approvalId', 'pluginId', 'revisionId', 'summary', 'risk', 'expiresAt'
    ]
    case 'approval.resolved': return ['approvalId', 'decision']
    case 'plugin.revision.defined': return ['turnId', 'pluginId', 'revisionId']
    case 'plugin.validation.completed': return ['turnId', 'pluginId', 'revisionId', 'status']
    case 'plugin.run.requested': return ['turnId', 'toolCallId', 'pluginId', 'revisionId', 'runId']
    case 'plugin.run.started':
    case 'plugin.run.succeeded':
    case 'plugin.run.failed':
    case 'plugin.run.stopped': return ['pluginId', 'revisionId', 'runId']
    case 'plugin.rollback.completed': return ['pluginId', 'fromRevisionId', 'toRevisionId', 'runId']
    case 'session.cancelled': return ['reason']
    case 'session.error': return []
  }
}

function requiresActiveTurn(type: AssistantEventType): boolean {
  return type === 'step.started'
    || type === 'step.ended'
    || type === 'user.message'
    || type === 'assistant.chunk'
    || type === 'assistant.message'
    || type === 'tool.call'
    || type === 'tool.result'
    || type === 'approval.requested'
    || type === 'plugin.revision.defined'
    || type === 'plugin.validation.completed'
    || type === 'plugin.run.requested'
}

function normalizeEventJson(raw: unknown, label: string): PluginJsonValue {
  let items = 0
  const visit = (value: unknown, depth: number): PluginJsonValue => {
    items += 1
    if (items > MAX_EVENT_ITEMS || depth > MAX_EVENT_DEPTH) {
      throw new Error(`${label} exceeds JSON complexity limits.`)
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Object.is(value, -0) ? 0 : value
    }
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry, depth + 1))
    }
    if (!isPlainObject(value)) {
      throw new Error(`${label} must contain plain JSON only.`)
    }
    const result: Record<string, PluginJsonValue> = {}
    for (const key of Object.keys(value)) {
      if (isSecretField(key)) {
        throw new Error(`${label} cannot persist secret field "${key}".`)
      }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains a reserved field.`)
      }
      result[key] = visit(value[key], depth + 1)
    }
    return result
  }
  const value = visit(raw, 0)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_EVENT_BYTES} bytes.`)
  }
  return value
}

function isSecretField(key: string): boolean {
  return /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key)
}

function normalizeId(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 500 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is required and must not exceed ${maxLength} characters.`)
  }
  return normalized
}

function parseJson(value: string, label: string): PluginJsonValue {
  try {
    return JSON.parse(value) as PluginJsonValue
  } catch (error) {
    throw new Error(`${label} is corrupt.`, { cause: error })
  }
}

function isPlainObject(value: unknown): value is Record<string, PluginJsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
