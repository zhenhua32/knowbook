import type { PluginActiveOwner, PluginJsonValue } from '@shared/plugin-platform'
import type { AppearanceTheme, DocumentBlockDraft, DocumentDetail } from '@shared/contracts'
import type { KnowbookStore } from '../database/store'
import {
  PluginCapabilityBroker,
  type PluginCapabilityContext
} from './capability-broker'
import { clonePluginRuntimeJson } from './runtime-json'

const DATA_SCOPES = ['workspace', 'session'] as const
const MAX_QUERY_LIMIT = 100
const MAX_BLOCKS = 2_000
const MAX_BLOCK_CONTENT_CHARS = 500_000

export interface CorePluginCapabilityHooks {
  onDocumentCreated?: (document: DocumentDetail, owner: PluginActiveOwner) => void | Promise<void>
  onDocumentUpdated?: (document: DocumentDetail, owner: PluginActiveOwner) => void | Promise<void>
  runDocumentSummaryAutomation?: (
    documentId: string,
    owner: PluginActiveOwner
  ) => PluginJsonValue | Promise<PluginJsonValue>
  notify?: (
    notification: { title?: string; message: string; level: 'info' | 'success' | 'warning' | 'error' },
    owner: PluginActiveOwner
  ) => void | Promise<void>
  setAppearanceTheme?: (
    theme: AppearanceTheme,
    owner: PluginActiveOwner
  ) => void | Promise<void>
}

export function registerCorePluginCapabilities(
  broker: PluginCapabilityBroker,
  store: KnowbookStore,
  hooks: CorePluginCapabilityHooks = {}
): () => void {
  const disposers = [
    broker.register({
      id: 'documents.query',
      version: 1,
      scopes: DATA_SCOPES,
      parseInput: parseDocumentQuery,
      execute: (_context, input) => {
        const query = input.query.toLocaleLowerCase()
        const entries = store.getDocumentCatalog()
          .filter((entry) => !query || [entry.title, entry.path, entry.summary]
            .some((value) => value.toLocaleLowerCase().includes(query)))
          .slice(0, input.limit)
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            path: entry.path,
            summary: entry.summary,
            updatedAt: entry.updatedAt,
            blockCount: entry.blockCount
          }))
        return json(entries, 'documents.query result')
      }
    }),
    broker.register({
      id: 'documents.read',
      version: 1,
      scopes: DATA_SCOPES,
      parseInput: parseDocumentIdInput,
      authorize: authorizeDocumentConstraint,
      execute: (_context, input) => {
        const detail = store.getDocumentDetail(input.documentId)
        if (!detail) {
          throw new Error('Document not found.')
        }
        return json(detail, 'documents.read result')
      }
    }),
    broker.register({
      id: 'documents.create',
      version: 1,
      scopes: DATA_SCOPES,
      parseInput: parseCreateDocumentInput,
      execute: async (context, input) => {
        const documentId = store.createDocument(input.parentId)
        try {
          const initial = requireDocument(store, documentId)
          store.updateDocument(documentId, {
            title: input.title,
            summary: input.summary,
            blocks: input.blocks ?? initial.blocks
          })
          const created = requireDocument(store, documentId)
          await hooks.onDocumentCreated?.(created, context.owner)
          return json(created, 'documents.create result')
        } catch (error) {
          try {
            store.deleteDocument(documentId)
          } catch {
            // Preserve the primary create/update error.
          }
          throw error
        }
      }
    }),
    broker.register({
      id: 'documents.update',
      version: 1,
      scopes: DATA_SCOPES,
      parseInput: parseUpdateDocumentInput,
      authorize: authorizeDocumentConstraint,
      execute: async (context, input) => {
        const current = requireDocument(store, input.documentId)
        store.updateDocument(input.documentId, {
          title: input.title ?? current.title,
          summary: input.summary ?? current.summary,
          blocks: input.blocks ?? current.blocks
        })
        const updated = requireDocument(store, input.documentId)
        await hooks.onDocumentUpdated?.(updated, context.owner)
        return json(updated, 'documents.update result')
      }
    }),
    broker.register({
      id: 'ai.automation.summarize-document',
      version: 1,
      scopes: DATA_SCOPES,
      parseInput: parseDocumentIdInput,
      authorize: authorizeDocumentConstraint,
      execute: async (context, input) => json(
        await hooks.runDocumentSummaryAutomation?.(input.documentId, context.owner)
          ?? { summaryGenerated: false },
        'ai.automation.summarize-document result'
      )
    }),
    broker.register({
      id: 'plugin.storage.read',
      version: 1,
      scopes: ['app', 'workspace', 'session'],
      parseInput: parseStorageReadInput,
      execute: (context, input) => {
        const stored = store.pluginPlatform.readPluginState(
          context.owner.pluginId,
          context.owner.scope,
          input.key
        )
        return json(stored, 'plugin.storage.read result')
      }
    }),
    broker.register({
      id: 'plugin.storage.write',
      version: 1,
      scopes: ['app', 'workspace', 'session'],
      parseInput: parseStorageWriteInput,
      execute: (context, input) => {
        const revision = store.pluginPlatform.getRevision(context.owner.revisionId)
        if (!revision || revision.pluginId !== context.owner.pluginId) {
          throw new Error('Active plugin revision metadata is unavailable.')
        }
        const schemaVersion = revision.stateSchemaVersion ?? 1
        if (input.schemaVersion !== schemaVersion) {
          throw new Error(
            `plugin.storage.write schemaVersion must match active revision schema ${schemaVersion}.`
          )
        }
        return json(store.pluginPlatform.writePluginState(
          context.owner.pluginId,
          context.owner.scope,
          input.key,
          input.value,
          schemaVersion
        ), 'plugin.storage.write result')
      }
    }),
    broker.register({
      id: 'ui.theme.write',
      version: 1,
      scopes: ['workspace', 'session'],
      parseInput: parseAppearanceTheme,
      execute: async (context, input) => {
        if (!hooks.setAppearanceTheme) {
          throw new Error('Host appearance theme changes are unavailable.')
        }
        await hooks.setAppearanceTheme(input.theme, context.owner)
        return { theme: input.theme }
      }
    }),
    broker.register({
      id: 'ui.notify',
      version: 1,
      scopes: ['app', 'workspace', 'session'],
      parseInput: parseNotification,
      execute: async (context, input) => {
        await hooks.notify?.(input, context.owner)
        return null
      }
    })
  ]

  return () => {
    for (const dispose of disposers.reverse()) {
      dispose()
    }
  }
}

type DocumentQueryInput = { query: string; limit: number }
type DocumentIdInput = { documentId: string }
type CreateDocumentInput = {
  parentId: string | null
  title: string
  summary: string
  blocks?: DocumentBlockDraft[]
}
type UpdateDocumentCapabilityInput = DocumentIdInput & {
  title?: string
  summary?: string
  blocks?: DocumentBlockDraft[]
}

type AppearanceThemeInput = { theme: AppearanceTheme }

function parseAppearanceTheme(value: PluginJsonValue): AppearanceThemeInput {
  const input = objectInput(value, 'ui.theme.write input')
  onlyKeys(input, ['theme'], 'ui.theme.write input')
  if (input.theme !== 'light' && input.theme !== 'dark') {
    throw new Error('ui.theme.write theme must be light or dark.')
  }
  return { theme: input.theme }
}

function parseDocumentQuery(value: PluginJsonValue): DocumentQueryInput {
  const input = objectInput(value, 'documents.query input')
  onlyKeys(input, ['query', 'limit'], 'documents.query input')
  const query = optionalString(input.query, 'documents.query query', 2_000) ?? ''
  const limit = input.limit === undefined ? 25 : integer(input.limit, 'documents.query limit', 1, MAX_QUERY_LIMIT)
  return { query, limit }
}

function parseDocumentIdInput(value: PluginJsonValue): DocumentIdInput {
  const input = objectInput(value, 'document input')
  onlyKeys(input, ['documentId'], 'document input')
  return { documentId: requiredId(input.documentId, 'documentId') }
}

function parseCreateDocumentInput(value: PluginJsonValue): CreateDocumentInput {
  const input = objectInput(value, 'documents.create input')
  onlyKeys(input, ['parentId', 'title', 'summary', 'blocks'], 'documents.create input')
  const parentId = input.parentId === undefined || input.parentId === null
    ? null
    : requiredId(input.parentId, 'parentId')
  return {
    parentId,
    title: requiredString(input.title, 'documents.create title', 500),
    summary: optionalString(input.summary, 'documents.create summary', 20_000) ?? '',
    ...(input.blocks === undefined ? {} : { blocks: parseBlocks(input.blocks) })
  }
}

function parseUpdateDocumentInput(value: PluginJsonValue): UpdateDocumentCapabilityInput {
  const input = objectInput(value, 'documents.update input')
  onlyKeys(input, ['documentId', 'title', 'summary', 'blocks'], 'documents.update input')
  if (input.title === undefined && input.summary === undefined && input.blocks === undefined) {
    throw new Error('documents.update requires at least one changed field.')
  }
  return {
    documentId: requiredId(input.documentId, 'documentId'),
    ...(input.title === undefined ? {} : {
      title: requiredString(input.title, 'documents.update title', 500)
    }),
    ...(input.summary === undefined ? {} : {
      summary: requiredString(input.summary, 'documents.update summary', 20_000, true)
    }),
    ...(input.blocks === undefined ? {} : { blocks: parseBlocks(input.blocks) })
  }
}

function parseStorageReadInput(value: PluginJsonValue): { key: string } {
  const input = objectInput(value, 'plugin.storage.read input')
  onlyKeys(input, ['key'], 'plugin.storage.read input')
  return { key: stateKey(input.key) }
}

function parseStorageWriteInput(value: PluginJsonValue): {
  key: string
  value: PluginJsonValue
  schemaVersion: number
} {
  const input = objectInput(value, 'plugin.storage.write input')
  onlyKeys(input, ['key', 'value', 'schemaVersion'], 'plugin.storage.write input')
  if (!Object.hasOwn(input, 'value')) {
    throw new Error('plugin.storage.write value is required.')
  }
  return {
    key: stateKey(input.key),
    value: clonePluginRuntimeJson(input.value, 'plugin.storage.write value'),
    schemaVersion: input.schemaVersion === undefined
      ? 1
      : integer(input.schemaVersion, 'plugin.storage.write schemaVersion', 1, 1_000_000)
  }
}

function parseNotification(value: PluginJsonValue): {
  title?: string
  message: string
  level: 'info' | 'success' | 'warning' | 'error'
} {
  const input = objectInput(value, 'ui.notify input')
  onlyKeys(input, ['title', 'message', 'level'], 'ui.notify input')
  const level = input.level ?? 'info'
  if (level !== 'info' && level !== 'success' && level !== 'warning' && level !== 'error') {
    throw new Error('ui.notify level is invalid.')
  }
  const title = optionalString(input.title, 'ui.notify title', 200)
  return {
    ...(title === undefined ? {} : { title }),
    message: requiredString(input.message, 'ui.notify message', 2_000),
    level
  }
}

function parseBlocks(value: PluginJsonValue): DocumentBlockDraft[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) {
    throw new Error(`Document blocks must be an array with at most ${MAX_BLOCKS} items.`)
  }
  return value.map((raw, index) => {
    const block = objectInput(raw, `Document block ${index}`)
    onlyKeys(block, [
      'id', 'type', 'content', 'checked', 'depth', 'parentBlockId', 'tags', 'language', 'highlight'
    ], `Document block ${index}`)
    const tags = block.tags === undefined ? undefined : stringArray(block.tags, `Document block ${index} tags`, 100, 200)
    return {
      ...(block.id === undefined ? {} : { id: requiredId(block.id, `Document block ${index} id`) }),
      type: requiredString(block.type, `Document block ${index} type`, 100),
      content: requiredString(block.content, `Document block ${index} content`, MAX_BLOCK_CONTENT_CHARS, true),
      checked: booleanValue(block.checked, `Document block ${index} checked`),
      depth: integer(block.depth, `Document block ${index} depth`, 0, 100),
      ...(block.parentBlockId === undefined ? {} : {
        parentBlockId: block.parentBlockId === null
          ? null
          : requiredId(block.parentBlockId, `Document block ${index} parentBlockId`)
      }),
      ...(tags === undefined ? {} : { tags }),
      ...(block.language === undefined ? {} : {
        language: requiredString(block.language, `Document block ${index} language`, 100)
      }),
      ...(block.highlight === undefined ? {} : {
        highlight: requiredString(block.highlight, `Document block ${index} highlight`, 100)
      })
    }
  })
}

function authorizeDocumentConstraint(
  context: PluginCapabilityContext,
  input: DocumentIdInput
): void {
  const constraints = context.grant.constraints
  if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) {
    return
  }
  const ids = constraints.documentIds
  if (ids === undefined) {
    return
  }
  if (!Array.isArray(ids) || !ids.includes(input.documentId)) {
    throw new Error('Document is outside this grant constraint.')
  }
}

function requireDocument(store: KnowbookStore, documentId: string): DocumentDetail {
  const document = store.getDocumentDetail(documentId)
  if (!document) {
    throw new Error('Document not found.')
  }
  return document
}

function objectInput(value: PluginJsonValue, label: string): Record<string, PluginJsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

function onlyKeys(value: Record<string, PluginJsonValue>, keys: string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) {
    throw new Error(`${label} contains unknown field "${unknown}".`)
  }
}

function requiredId(value: PluginJsonValue | undefined, label: string): string {
  const id = requiredString(value, label, 500)
  if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(id)) {
    throw new Error(`${label} is invalid.`)
  }
  return id
}

function stateKey(value: PluginJsonValue | undefined): string {
  const key = requiredString(value, 'Plugin storage key', 200)
  if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(key)) {
    throw new Error('Plugin storage key is invalid.')
  }
  return key
}

function requiredString(
  value: PluginJsonValue | undefined,
  label: string,
  maxLength: number,
  allowEmpty = false
): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function optionalString(
  value: PluginJsonValue | undefined,
  label: string,
  maxLength: number
): string | undefined {
  return value === undefined ? undefined : requiredString(value, label, maxLength, true)
}

function integer(value: PluginJsonValue | undefined, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} is invalid.`)
  }
  return value as number
}

function booleanValue(value: PluginJsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`)
  }
  return value
}

function stringArray(
  value: PluginJsonValue,
  label: string,
  maxItems: number,
  maxItemLength: number
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} is invalid.`)
  }
  return value.map((entry, index) => requiredString(entry, `${label} ${index}`, maxItemLength))
}

function json(value: unknown, label: string): PluginJsonValue {
  return clonePluginRuntimeJson(value, label)
}
