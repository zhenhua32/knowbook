import type {
  PluginActiveOwner,
  PluginJsonValue,
  PluginPlatformScope
} from './plugin-platform'

export const PLUGIN_UI_SLOT_CATALOG = Object.freeze({
  'navigation.primary': slot('navigation', 8, 40),
  'workspace.dashboard': slot('surface', 16, 200),
  'documents.header.actions': slot('action', 8, 40),
  'documents.editor.toolbar': slot('action', 12, 40),
  'documents.block.context-menu': slot('action', 12, 40),
  'documents.aux-panel': slot('surface', 8, 180),
  'database.view.tabs': slot('navigation', 8, 80),
  'database.record.actions': slot('action', 8, 40),
  'settings.sections': slot('surface', 8, 160),
  'assistant.tools': slot('action', 12, 40),
  'assistant.message.cards': slot('surface', 12, 160)
})

export type PluginUiSlot = keyof typeof PLUGIN_UI_SLOT_CATALOG
export type PluginUiContributionKind = 'view' | 'iframe'

export interface PluginUiSlotDescriptor {
  version: 1
  role: 'navigation' | 'action' | 'surface'
  acceptedKinds: readonly PluginUiContributionKind[]
  scopes: readonly PluginPlatformScope['kind'][]
  maxContributions: number
  renderBudget: number
  accessibility: 'keyboard-and-labelled-controls'
  theme: 'knowbook-tokens'
}

export interface PluginViewAction {
  handler: string
  arguments?: PluginJsonValue
}

export interface PluginViewSpec {
  version: 1
  root: PluginViewNode
}

export type PluginViewNode =
  | { type: 'stack' | 'row'; gap?: number; children: PluginViewNode[] }
  | { type: 'grid'; columns?: number; gap?: number; children: PluginViewNode[] }
  | { type: 'divider' }
  | { type: 'scroll'; maxHeight?: number; child: PluginViewNode }
  | { type: 'text'; text: string; tone?: PluginViewTone; size?: 'small' | 'medium' | 'large' }
  | { type: 'markdown'; markdown: string }
  | { type: 'badge'; label: string; tone?: PluginViewTone }
  | { type: 'icon'; name: PluginViewIcon; label?: string }
  | { type: 'image'; asset: string; alt: string; width?: number; height?: number; src?: string }
  | { type: 'empty-state'; title: string; description?: string }
  | { type: 'button'; label: string; variant?: 'primary' | 'secondary' | 'danger'; action: PluginViewAction }
  | PluginViewTextInputNode
  | { type: 'checkbox'; id: string; label: string; checked?: boolean; action?: PluginViewAction }
  | { type: 'select'; id: string; label: string; value?: string; options: Array<{ value: string; label: string }>; action?: PluginViewAction }
  | { type: 'list'; items: PluginViewNode[] }
  | { type: 'table'; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, PluginJsonValue>> }
  | { type: 'stat'; label: string; value: string | number; trend?: string }
  | { type: 'progress'; label?: string; value: number }
  | { type: 'simple-chart'; label?: string; points: Array<{ label: string; value: number }> }
  | { type: 'loading'; label?: string }
  | { type: 'error'; title: string; message: string }
  | { type: 'confirmation'; title: string; message: string; confirmLabel?: string; cancelLabel?: string; confirmAction: PluginViewAction; cancelAction?: PluginViewAction }

export interface PluginViewTextInputNode {
  type: 'text-field' | 'textarea' | 'date'
  id: string
  label: string
  value?: string
  placeholder?: string
  action?: PluginViewAction
}

export type PluginViewTone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info'
export type PluginViewIcon = 'book' | 'calendar' | 'check' | 'database' | 'document' | 'info' | 'sparkles' | 'warning'

export interface PluginViewContributionValue {
  kind: 'view'
  view: PluginViewSpec
}

export interface PluginIframeContributionValue {
  kind: 'iframe'
  asset: string
  title: string
  height?: number
  handlers: string[]
}

export type PluginUiContributionValue = PluginViewContributionValue | PluginIframeContributionValue

export interface PluginUiContribution {
  owner: PluginActiveOwner
  slot: PluginUiSlot
  id: string
  order: number
  value:
    | PluginViewContributionValue
    | {
        kind: 'iframe'
        title: string
        height: number
        srcdoc: string
      }
}

export interface RunPluginUiActionInput {
  owner: PluginActiveOwner
  slot: PluginUiSlot
  contributionId: string
  handler: string
  arguments?: PluginJsonValue
  control?: { id: string; value: PluginJsonValue }
  context?: { documentId?: string; databaseId?: string; recordId?: string; messageId?: string }
}

export interface RunPluginUiActionResult {
  result: PluginJsonValue
}

export interface ValidatedPluginUiContribution {
  value: PluginUiContributionValue
  actions: PluginViewAction[]
  nodeCount: number
}

const MAX_VIEW_NODES = 500
const MAX_VIEW_DEPTH = 24
const MAX_TEXT = 20_000
const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/i
const ASSET_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9][a-z0-9._/-]*$/i
const ICONS = new Set<PluginViewIcon>(['book', 'calendar', 'check', 'database', 'document', 'info', 'sparkles', 'warning'])
const TONES = new Set<PluginViewTone>(['default', 'muted', 'success', 'warning', 'danger', 'info'])

export function isPluginUiSlot(value: string): value is PluginUiSlot {
  return Object.hasOwn(PLUGIN_UI_SLOT_CATALOG, value)
}

export function validateRunPluginUiActionInput(raw: unknown): RunPluginUiActionInput {
  const value = object(raw, 'Plugin UI action request')
  onlyKeys(value, ['owner', 'slot', 'contributionId', 'handler', 'arguments', 'control', 'context'], 'Plugin UI action request')
  const owner = validateOwner(value.owner)
  const slotId = text(value.slot, 'Plugin UI action slot', 100)
  if (!isPluginUiSlot(slotId)) throw new Error(`Plugin UI slot "${slotId}" is not published.`)
  const control = value.control === undefined ? undefined : validateControl(value.control)
  const context = value.context === undefined ? undefined : validateContext(value.context)
  return {
    owner,
    slot: slotId,
    contributionId: id(value.contributionId, 'Plugin UI contribution id'),
    handler: id(value.handler, 'Plugin UI action handler'),
    ...(value.arguments === undefined ? {} : { arguments: cloneJson(value.arguments, 'Plugin UI action arguments') }),
    ...(control ? { control } : {}),
    ...(context ? { context } : {})
  }
}

export function validatePluginUiContribution(
  slotId: string,
  raw: PluginJsonValue
): ValidatedPluginUiContribution {
  if (!isPluginUiSlot(slotId)) {
    throw new Error(`Plugin UI slot "${slotId}" is not published.`)
  }
  const value = object(raw, `Plugin UI contribution ${slotId}`)
  const kind = value.kind
  if (kind === 'iframe') {
    onlyKeys(value, ['kind', 'asset', 'title', 'height', 'handlers'], 'Plugin iframe contribution')
    const asset = text(value.asset, 'Plugin iframe asset', 240)
    if (!ASSET_PATTERN.test(asset) || !asset.toLowerCase().endsWith('.html')) {
      throw new Error('Plugin iframe asset must be a relative .html asset path.')
    }
    if (!Array.isArray(value.handlers) || value.handlers.length > 64) {
      throw new Error('Plugin iframe handlers are invalid.')
    }
    const handlers = [...new Set(value.handlers.map((handler) => id(handler, 'Plugin iframe handler')))]
    const actions = handlers.map((handler) => ({ handler }))
    return {
      value: {
        kind,
        asset,
        title: text(value.title, 'Plugin iframe title', 500),
        ...(value.height === undefined ? {} : { height: integer(value.height, 'Plugin iframe height', 120, 1_200) }),
        handlers
      },
      actions,
      nodeCount: 1
    }
  }
  if (kind !== 'view') {
    throw new Error('Plugin UI contribution kind must be view or iframe.')
  }
  onlyKeys(value, ['kind', 'view'], 'Plugin ViewSpec contribution')
  const view = object(value.view, 'Plugin ViewSpec')
  onlyKeys(view, ['version', 'root'], 'Plugin ViewSpec')
  if (view.version !== 1) {
    throw new Error('Plugin ViewSpec version must be 1.')
  }
  const state = { nodes: 0, actions: [] as PluginViewAction[] }
  const root = validateNode(view.root, 0, state)
  return {
    value: { kind, view: { version: 1, root } },
    actions: state.actions,
    nodeCount: state.nodes
  }
}

function validateNode(
  raw: unknown,
  depth: number,
  state: { nodes: number; actions: PluginViewAction[] }
): PluginViewNode {
  if (depth > MAX_VIEW_DEPTH || ++state.nodes > MAX_VIEW_NODES) {
    throw new Error('Plugin ViewSpec exceeds its render budget.')
  }
  const node = object(raw, 'Plugin ViewSpec node')
  const type = text(node.type, 'Plugin ViewSpec node type', 50)
  switch (type) {
    case 'stack':
    case 'row':
      onlyKeys(node, ['type', 'gap', 'children'], `Plugin ${type} node`)
      return {
        type,
        ...(node.gap === undefined ? {} : { gap: integer(node.gap, `Plugin ${type} gap`, 0, 64) }),
        children: children(node.children, depth, state)
      }
    case 'grid':
      onlyKeys(node, ['type', 'columns', 'gap', 'children'], 'Plugin grid node')
      return {
        type,
        ...(node.columns === undefined ? {} : { columns: integer(node.columns, 'Plugin grid columns', 1, 6) }),
        ...(node.gap === undefined ? {} : { gap: integer(node.gap, 'Plugin grid gap', 0, 64) }),
        children: children(node.children, depth, state)
      }
    case 'divider':
      onlyKeys(node, ['type'], 'Plugin divider node')
      return { type }
    case 'scroll':
      onlyKeys(node, ['type', 'maxHeight', 'child'], 'Plugin scroll node')
      return {
        type,
        ...(node.maxHeight === undefined ? {} : { maxHeight: integer(node.maxHeight, 'Plugin scroll maxHeight', 80, 1_200) }),
        child: validateNode(node.child, depth + 1, state)
      }
    case 'text': {
      onlyKeys(node, ['type', 'text', 'tone', 'size'], 'Plugin text node')
      const tone = optionalTone(node.tone)
      const size = optionalEnum(node.size, ['small', 'medium', 'large'], 'Plugin text size')
      return { type, text: text(node.text, 'Plugin text', MAX_TEXT, true), ...(tone ? { tone } : {}), ...(size ? { size } : {}) }
    }
    case 'markdown':
      onlyKeys(node, ['type', 'markdown'], 'Plugin markdown node')
      return { type, markdown: text(node.markdown, 'Plugin markdown', MAX_TEXT, true) }
    case 'badge': {
      onlyKeys(node, ['type', 'label', 'tone'], 'Plugin badge node')
      const tone = optionalTone(node.tone)
      return { type, label: text(node.label, 'Plugin badge label', 500), ...(tone ? { tone } : {}) }
    }
    case 'icon': {
      onlyKeys(node, ['type', 'name', 'label'], 'Plugin icon node')
      const name = text(node.name, 'Plugin icon name', 50) as PluginViewIcon
      if (!ICONS.has(name)) throw new Error('Plugin icon name is not in the published catalog.')
      return { type, name, ...(node.label === undefined ? {} : { label: text(node.label, 'Plugin icon label', 500) }) }
    }
    case 'image':
      onlyKeys(node, ['type', 'asset', 'alt', 'width', 'height'], 'Plugin image node')
      return {
        type,
        asset: assetPath(node.asset, 'Plugin image asset'),
        alt: text(node.alt, 'Plugin image alt text', 1_000, true),
        ...(node.width === undefined ? {} : { width: integer(node.width, 'Plugin image width', 1, 4_096) }),
        ...(node.height === undefined ? {} : { height: integer(node.height, 'Plugin image height', 1, 4_096) })
      }
    case 'empty-state':
      onlyKeys(node, ['type', 'title', 'description'], 'Plugin empty-state node')
      return { type, title: text(node.title, 'Plugin empty-state title', 500), ...(node.description === undefined ? {} : { description: text(node.description, 'Plugin empty-state description', 2_000, true) }) }
    case 'button': {
      onlyKeys(node, ['type', 'label', 'variant', 'action'], 'Plugin button node')
      const action = validateAction(node.action, state)
      const variant = optionalEnum(node.variant, ['primary', 'secondary', 'danger'], 'Plugin button variant')
      return { type, label: text(node.label, 'Plugin button label', 500), ...(variant ? { variant } : {}), action }
    }
    case 'text-field':
    case 'textarea':
    case 'date': {
      onlyKeys(node, ['type', 'id', 'label', 'value', 'placeholder', 'action'], `Plugin ${type} node`)
      const action = node.action === undefined ? undefined : validateAction(node.action, state)
      return {
        type,
        id: id(node.id, `Plugin ${type} id`),
        label: text(node.label, `Plugin ${type} label`, 500),
        ...(node.value === undefined ? {} : { value: text(node.value, `Plugin ${type} value`, 10_000, true) }),
        ...(node.placeholder === undefined ? {} : { placeholder: text(node.placeholder, `Plugin ${type} placeholder`, 1_000, true) }),
        ...(action ? { action } : {})
      }
    }
    case 'checkbox': {
      onlyKeys(node, ['type', 'id', 'label', 'checked', 'action'], 'Plugin checkbox node')
      const action = node.action === undefined ? undefined : validateAction(node.action, state)
      if (node.checked !== undefined && typeof node.checked !== 'boolean') throw new Error('Plugin checkbox checked must be boolean.')
      return { type, id: id(node.id, 'Plugin checkbox id'), label: text(node.label, 'Plugin checkbox label', 500), ...(node.checked === undefined ? {} : { checked: node.checked }), ...(action ? { action } : {}) }
    }
    case 'select': {
      onlyKeys(node, ['type', 'id', 'label', 'value', 'options', 'action'], 'Plugin select node')
      if (!Array.isArray(node.options) || node.options.length > 100) throw new Error('Plugin select options are invalid.')
      const options = node.options.map((entry, index) => {
        const option = object(entry, `Plugin select option ${index}`)
        onlyKeys(option, ['value', 'label'], `Plugin select option ${index}`)
        return { value: text(option.value, 'Plugin select option value', 500), label: text(option.label, 'Plugin select option label', 500) }
      })
      const action = node.action === undefined ? undefined : validateAction(node.action, state)
      return { type, id: id(node.id, 'Plugin select id'), label: text(node.label, 'Plugin select label', 500), ...(node.value === undefined ? {} : { value: text(node.value, 'Plugin select value', 500, true) }), options, ...(action ? { action } : {}) }
    }
    case 'list':
      onlyKeys(node, ['type', 'items'], 'Plugin list node')
      return { type, items: children(node.items, depth, state) }
    case 'table': {
      onlyKeys(node, ['type', 'columns', 'rows'], 'Plugin table node')
      if (!Array.isArray(node.columns) || node.columns.length === 0 || node.columns.length > 32) throw new Error('Plugin table columns are invalid.')
      const columns = node.columns.map((entry, index) => {
        const column = object(entry, `Plugin table column ${index}`)
        onlyKeys(column, ['key', 'label'], `Plugin table column ${index}`)
        return { key: id(column.key, 'Plugin table column key'), label: text(column.label, 'Plugin table column label', 500) }
      })
      if (!Array.isArray(node.rows) || node.rows.length > 500) throw new Error('Plugin table rows are invalid.')
      const allowed = new Set(columns.map((column) => column.key))
      const rows = node.rows.map((entry, index) => {
        const row = object(entry, `Plugin table row ${index}`)
        const unknown = Object.keys(row).find((key) => !allowed.has(key))
        if (unknown) throw new Error(`Plugin table row contains unknown column "${unknown}".`)
        return cloneJson(row, `Plugin table row ${index}`) as Record<string, PluginJsonValue>
      })
      return { type, columns, rows }
    }
    case 'stat': {
      onlyKeys(node, ['type', 'label', 'value', 'trend'], 'Plugin stat node')
      if (typeof node.value !== 'string' && (typeof node.value !== 'number' || !Number.isFinite(node.value))) throw new Error('Plugin stat value is invalid.')
      return { type, label: text(node.label, 'Plugin stat label', 500), value: node.value, ...(node.trend === undefined ? {} : { trend: text(node.trend, 'Plugin stat trend', 500, true) }) }
    }
    case 'progress':
      onlyKeys(node, ['type', 'label', 'value'], 'Plugin progress node')
      return { type, ...(node.label === undefined ? {} : { label: text(node.label, 'Plugin progress label', 500) }), value: number(node.value, 'Plugin progress value', 0, 100) }
    case 'simple-chart': {
      onlyKeys(node, ['type', 'label', 'points'], 'Plugin simple-chart node')
      if (!Array.isArray(node.points) || node.points.length > 100) throw new Error('Plugin simple-chart points are invalid.')
      const points = node.points.map((entry, index) => {
        const point = object(entry, `Plugin chart point ${index}`)
        onlyKeys(point, ['label', 'value'], `Plugin chart point ${index}`)
        return { label: text(point.label, 'Plugin chart point label', 500), value: number(point.value, 'Plugin chart point value', -1e12, 1e12) }
      })
      return { type, ...(node.label === undefined ? {} : { label: text(node.label, 'Plugin chart label', 500) }), points }
    }
    case 'loading':
      onlyKeys(node, ['type', 'label'], 'Plugin loading node')
      return { type, ...(node.label === undefined ? {} : { label: text(node.label, 'Plugin loading label', 500) }) }
    case 'error':
      onlyKeys(node, ['type', 'title', 'message'], 'Plugin error node')
      return { type, title: text(node.title, 'Plugin error title', 500), message: text(node.message, 'Plugin error message', 2_000, true) }
    case 'confirmation': {
      onlyKeys(node, ['type', 'title', 'message', 'confirmLabel', 'cancelLabel', 'confirmAction', 'cancelAction'], 'Plugin confirmation node')
      const confirmAction = validateAction(node.confirmAction, state)
      const cancelAction = node.cancelAction === undefined ? undefined : validateAction(node.cancelAction, state)
      return { type, title: text(node.title, 'Plugin confirmation title', 500), message: text(node.message, 'Plugin confirmation message', 2_000, true), ...(node.confirmLabel === undefined ? {} : { confirmLabel: text(node.confirmLabel, 'Plugin confirm label', 500) }), ...(node.cancelLabel === undefined ? {} : { cancelLabel: text(node.cancelLabel, 'Plugin cancel label', 500) }), confirmAction, ...(cancelAction ? { cancelAction } : {}) }
    }
    default:
      throw new Error(`Unknown Plugin ViewSpec node type "${type}".`)
  }
}

function validateAction(raw: unknown, state: { actions: PluginViewAction[] }): PluginViewAction {
  const action = object(raw, 'Plugin ViewSpec action')
  onlyKeys(action, ['handler', 'arguments'], 'Plugin ViewSpec action')
  const result: PluginViewAction = {
    handler: id(action.handler, 'Plugin ViewSpec action handler'),
    ...(action.arguments === undefined ? {} : { arguments: cloneJson(action.arguments, 'Plugin ViewSpec action arguments') })
  }
  state.actions.push(result)
  return result
}

function children(raw: unknown, depth: number, state: { nodes: number; actions: PluginViewAction[] }): PluginViewNode[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('Plugin ViewSpec children are invalid.')
  return raw.map((child) => validateNode(child, depth + 1, state))
}

function slot(role: PluginUiSlotDescriptor['role'], maxContributions: number, renderBudget: number): PluginUiSlotDescriptor {
  return Object.freeze({ version: 1, role, acceptedKinds: Object.freeze(['view', 'iframe'] as const), scopes: Object.freeze(['workspace', 'session'] as const), maxContributions, renderBudget, accessibility: 'keyboard-and-labelled-controls', theme: 'knowbook-tokens' })
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}".`)
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${label} is invalid.`)
  return value
}

function id(value: unknown, label: string): string {
  const value_ = text(value, label, 200)
  if (!ID_PATTERN.test(value_)) throw new Error(`${label} is invalid.`)
  return value_
}

function assetPath(value: unknown, label: string): string {
  const value_ = text(value, label, 240)
  if (!ASSET_PATTERN.test(value_)) throw new Error(`${label} is invalid.`)
  return value_
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} is invalid.`)
  return value as number
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is invalid.`)
  return value
}

function optionalTone(value: unknown): PluginViewTone | undefined {
  if (value === undefined) return undefined
  if (!TONES.has(value as PluginViewTone)) throw new Error('Plugin ViewSpec tone is invalid.')
  return value as PluginViewTone
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined
  if (!values.includes(value as T)) throw new Error(`${label} is invalid.`)
  return value as T
}

function cloneJson(value: unknown, label: string): PluginJsonValue {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('undefined')
    if (json.length > 256 * 1024) throw new Error('too large')
    return JSON.parse(json) as PluginJsonValue
  } catch (error) {
    throw new Error(`${label} must be JSON.`, { cause: error })
  }
}

function validateOwner(raw: unknown): PluginActiveOwner {
  const owner = object(raw, 'Plugin UI action owner')
  onlyKeys(owner, ['pluginId', 'revisionId', 'runId', 'grantSetId', 'scope', 'epoch'], 'Plugin UI action owner')
  if (!Number.isSafeInteger(owner.epoch) || (owner.epoch as number) < 1) {
    throw new Error('Plugin UI action epoch is invalid.')
  }
  return {
    pluginId: id(owner.pluginId, 'Plugin UI owner pluginId'),
    revisionId: id(owner.revisionId, 'Plugin UI owner revisionId'),
    runId: id(owner.runId, 'Plugin UI owner runId'),
    grantSetId: id(owner.grantSetId, 'Plugin UI owner grantSetId'),
    scope: validateScope(owner.scope),
    epoch: owner.epoch as number
  }
}

function validateScope(raw: unknown): PluginPlatformScope {
  const scope = object(raw, 'Plugin UI owner scope')
  const kind = scope.kind
  if (kind === 'app') {
    onlyKeys(scope, ['kind'], 'Plugin UI app scope')
    return { kind }
  }
  if (kind === 'workspace') {
    onlyKeys(scope, ['kind', 'workspaceId'], 'Plugin UI workspace scope')
    return { kind, workspaceId: id(scope.workspaceId, 'Plugin UI workspaceId') }
  }
  if (kind === 'session') {
    onlyKeys(scope, ['kind', 'workspaceId', 'sessionId'], 'Plugin UI session scope')
    return {
      kind,
      workspaceId: id(scope.workspaceId, 'Plugin UI workspaceId'),
      sessionId: id(scope.sessionId, 'Plugin UI sessionId')
    }
  }
  throw new Error('Plugin UI owner scope is invalid.')
}

function validateControl(raw: unknown): NonNullable<RunPluginUiActionInput['control']> {
  const control = object(raw, 'Plugin UI action control')
  onlyKeys(control, ['id', 'value'], 'Plugin UI action control')
  return {
    id: id(control.id, 'Plugin UI action control id'),
    value: cloneJson(control.value, 'Plugin UI action control value')
  }
}

function validateContext(raw: unknown): NonNullable<RunPluginUiActionInput['context']> {
  const context = object(raw, 'Plugin UI action context')
  onlyKeys(context, ['documentId', 'databaseId', 'recordId', 'messageId'], 'Plugin UI action context')
  const result: NonNullable<RunPluginUiActionInput['context']> = {}
  for (const key of ['documentId', 'databaseId', 'recordId', 'messageId'] as const) {
    if (context[key] !== undefined) result[key] = id(context[key], `Plugin UI context ${key}`)
  }
  return result
}
