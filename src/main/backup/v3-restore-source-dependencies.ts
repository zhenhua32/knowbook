import type Database from 'better-sqlite3'
import type { SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { assertPersistedTemplateForest, isSyncedBlockId, parseSyncedBlockPayload, syncedPlainRecord,
  validatePersistedHostForest } from '../../shared/syncedBlockValidation'
import { serializeBlocksToMarkdown, type MarkdownRenderableBlock } from '../../shared/markdown'
import { getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { collectMarkdownSourceLinks, parseLocalMarkdownUrl } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { decodeMarkdownFormat } from '../../shared/markdownFormat'
import { parseInitialIncomingStored } from '../sync/synced-initial-incoming-model'
import { EditorRecoveryDraftStore } from '../editor-recovery/draft-store'
import { join } from 'node:path'
import { graph3Value, type Graph3Inputs } from '../database/restore-knowledge-graph3-data'
import type { Reference3Value } from '../database/restore-knowledge-reference3-read'
import { restoreExists } from '../database/restore-safety-files'

function plain(value: unknown): boolean {
  return value === null || typeof value === 'string' && !/[\[<>&\\]|#\^|(?:knowbook|file|asset|block):/iu.test(value)
}

export function plainV3RetirementGroup(group: SyncedGroupWire) {
  return group.bindings.length === 0 && group.blocks.length > 0 && group.blocks.every(block => block.type === 'paragraph' && plain(block.content))
    && getMarkdownHeadingTargets(group.blocks, '').every(heading => heading.blockId === null)
}

function targets(groups: readonly SyncedGroupWire[]) {
  return {
    groups: new Set(groups.map(group => group.id)),
    blocks: new Set(groups.flatMap(group => [...group.blocks.map(block => block.id), group.origin.firstInstanceId]))
  }
}
type Targets = ReturnType<typeof targets>
type GraphOriginal = Graph3Inputs['inputs']['source']
type Original = { source: Pick<GraphOriginal['source'], 'sourceContent' | 'physical'>;
  knowledge: Pick<GraphOriginal['knowledge'], 'pins' | 'occupancy' | 'bindings' | 'hostJournals' | 'groupHistories' | 'archivedGroupHistories'> }

function pointsToBlock(value: string | null, { blocks }: Targets) {
  if (!value) return false
  const matches = (id: string) => blocks.has(id) || id.startsWith('^') && blocks.has(id.slice(1))
  if (matches(value)) return true
  try { return matches(decodeURIComponent(value)) } catch { return false }
}

function referencesMarkdown(value: string, retiring: Targets) {
  return collectMarkdownSourceLinks(value).some(link => {
    if (link.kind === 'image') return false
    if (link.kind === 'wiki') {
      const wiki = parseWikiReference(link.url)
      const lastHash = wiki.target.lastIndexOf('#')
      return pointsToBlock(wiki.hasFragment ? wiki.fragment : wiki.target, retiring)
        // Historical Wiki paths can themselves contain # or |.
        || lastHash >= 0 && pointsToBlock(wiki.target.slice(lastHash + 1).trim(), retiring)
        || link.url.includes('#') && pointsToBlock(link.url.slice(link.url.lastIndexOf('#') + 1).trim(), retiring)
    }
    return pointsToBlock(parseLocalMarkdownUrl(link.url)?.fragment ?? null, retiring)
  })
}

function referencesBindings(bindings: readonly SyncedLinkBinding[], retiring: Targets) {
  return bindings.some(({ target }) => target.kind === 'block' ? retiring.blocks.has(target.id)
    : target.kind === 'unresolved-url' && pointsToBlock(target.fragment, retiring))
}

function referencesBody(blocks: readonly MarkdownRenderableBlock[], retiring: Targets, template = false) {
  for (const block of blocks) {
    if (block.id !== undefined && retiring.blocks.has(block.id)) return true
    if (block.type === 'synced-block') {
      if (retiring.groups.has(parseSyncedBlockPayload(block.content).groupId)) return true
    } else if (template && /\{\{(?:title|date)\}\}/.test(block.content)) {
      // The instantiated template may add actual Markdown or defer an ID.
      return true
    }
  }
  return referencesMarkdown(serializeBlocksToMarkdown([...blocks]), retiring)
}

function referencesSavedContent(value: unknown, retiring: Targets) {
  if (!syncedPlainRecord(value) || typeof value.title !== 'string' || typeof value.summary !== 'string') return true
  return referencesMarkdown(value.title, retiring) || referencesMarkdown(value.summary, retiring)
    || referencesBody(validatePersistedHostForest(value.blocks), retiring)
}

function referencesTemplate(blocks: unknown, title: unknown, summary: unknown, retiring: Targets) {
  assertPersistedTemplateForest(blocks)
  if (typeof title !== 'string' || typeof summary !== 'string') return true
  return /\{\{(?:title|date)\}\}/.test(title + '\n' + summary) || referencesMarkdown(title, retiring)
    || referencesMarkdown(summary, retiring) || referencesBody(blocks as MarkdownRenderableBlock[], retiring, true)
}

function referencesWire(wire: SyncedGroupWire, retiring: Targets) {
  return retiring.groups.has(wire.id) || referencesBindings(wire.bindings, retiring) || referencesBody(wire.blocks, retiring)
}

export function hasNoV3RetirementReferenceDependencies(candidate: Reference3Value['candidate'], groups: readonly SyncedGroupWire[]) {
  const retiring = targets(groups)
  try {
    if (candidate.pendingLocalBody || !candidate.finalForestValidated || !candidate.candidateConflictFree
      || candidate.activeGroupWires.some(wire => retiring.groups.has(wire.id) ? !plainV3RetirementGroup(wire) : referencesWire(wire, retiring))) return false
    const ordinary = new Map<string, Array<{ order: bigint; block: MarkdownRenderableBlock }>>()
    for (const table of candidate.tables) {
      if (!['blocks', 'documents', 'document_templates', 'synced_instances'].includes(table.name)) continue
      const columns = new Map(table.columns.map((name, index) => [name, index]))
      for (const row of table.rows) {
        const get = (name: string) => graph3Value(row.cells[columns.get(name)!], table.encoding)
        if (table.name === 'synced_instances' && retiring.groups.has(String(get('group_id')))) return false
        if (table.name === 'documents' && [get('title'), get('summary')].some(value =>
          typeof value !== 'string' || referencesMarkdown(value, retiring))) return false
        if (table.name === 'document_templates' && referencesTemplate(JSON.parse(String(get('blocks_json'))), get('title'), get('summary'), retiring)) return false
        if (table.name !== 'blocks') continue
        const id = get('id'), documentId = get('document_id'), type = get('type'), content = get('content'), order = get('sort_order')
        if (!isSyncedBlockId(id) || !isSyncedBlockId(documentId) || typeof type !== 'string' || typeof content !== 'string' || typeof order !== 'bigint') return false
        const language = get('language'), listStart = get('list_start'), parent = get('parent_block_id'), format = get('markdown_format_json')
        const block = { id, type, content, checked: get('checked') === 1n, depth: Number(get('depth')),
          parentBlockId: typeof parent === 'string' ? parent : null, language: typeof language === 'string' ? language : undefined,
          listStart: typeof listStart === 'bigint' ? Number(listStart) : undefined,
          markdownFormat: decodeMarkdownFormat(type, typeof format === 'string' ? format : null) }
        const rows = ordinary.get(documentId) ?? []
        rows.push({ order, block })
        ordinary.set(documentId, rows)
      }
    }
    return [...ordinary.values()].every(rows => !referencesBody(rows.sort((a, b) => a.order < b.order ? -1 : Number(a.order > b.order)).map(row => row.block), retiring))
  } catch { return false }
}

export function hasNoV3RetirementSqlDependencies(db: Database.Database, groups: readonly SyncedGroupWire[]) {
  const retiring = targets(groups), groupIds = JSON.stringify([...retiring.groups])
  if (db.prepare('SELECT 1 FROM synced_instances WHERE group_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(groupIds)
    || db.prepare('SELECT 1 FROM synced_group_pins WHERE group_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(groupIds)
    || db.prepare(`SELECT 1 FROM synced_group_exposure_members m JOIN synced_exposure_attempts a ON a.id=m.attempt_id
      WHERE m.group_id IN (SELECT value FROM json_each(?)) AND a.channel LIKE 'webdav-%' LIMIT 1`).get(groupIds)
    || db.prepare('SELECT 1 FROM document_block_routes WHERE block_id IN (SELECT value FROM json_each(?)) LIMIT 1')
      .get(JSON.stringify([...retiring.blocks]))) return false
  return true
}

export async function hasNoV3RetirementDrafts(profileRoot: string) {
  const directory = join(profileRoot, 'storage', 'recovery')
  if (!(await restoreExists(join(directory, 'synced-drafts.sqlite')))
    && !(await restoreExists(join(directory, 'synced-drafts-v2.sqlite')))) return true
  try {
    const drafts = new EditorRecoveryDraftStore(directory, { readonly: true })
    try { return !drafts.legacy && drafts.list({ limit: 1 }).records.length === 0 }
    finally { drafts.close() }
  } catch { return false }
}

/** The verified source/current input has both the typed history and the actual
 * rows for ordinary Markdown stored in checkpoints, trash, moves and templates. */
export function hasNoV3RetirementHistoricalReferences(input: Original, wires: readonly SyncedGroupWire[], ownWires: ReadonlySet<string> = new Set()) {
  const retiring = targets(wires), { source, knowledge } = input
  const { documents, groups, instances, deletions } = source.physical
  try {
    if (instances.some(instance => retiring.groups.has(instance.group_id)) || knowledge.pins.some(pin => retiring.groups.has(pin.groupId))
      || knowledge.occupancy.some(item => (item.kind === 'history' || item.kind === 'template' || item.kind === 'route')
        && (item.namespace === 'instance' && item.source.table !== 'synced_groups' && retiring.blocks.has(item.id)
          || item.namespace === 'block' && retiring.blocks.has(item.id)
          || item.namespace === 'group' && retiring.groups.has(item.id)))
      || knowledge.bindings.some(item => referencesBindings([item.binding], retiring))
      || knowledge.hostJournals.some(({ decoded }) => {
        const journal = decoded.kind === 'finite' ? decoded.value : decoded
        return [...journal.before, ...journal.after].some(side => referencesSavedContent(side.content, retiring))
      })
      || [...knowledge.groupHistories, ...knowledge.archivedGroupHistories].some(({ before, after }) =>
        referencesWire(before, retiring) || referencesWire(after, retiring))
      || deletions.some(({ before }) => before.kind === 'document' ? referencesSavedContent(before.content, retiring) : referencesWire(before, retiring))) return false
    if (documents.some(document => referencesSavedContent(document, retiring))
      || groups.some(({ groupId, snapshot }) => snapshot && !ownWires.has(groupId)
        && (referencesBindings(snapshot.bindings, retiring) || referencesBody(snapshot.blocks, retiring)))) return false
    for (const table of source.sourceContent.tables) {
      if (!['document_history', 'document_trash', 'document_block_moves', 'document_templates'].includes(table.name)) continue
      const columns = new Map(table.columns.map((name, index) => [name, index]))
      for (const row of table.rows) {
        const get = (name: string) => graph3Value(row.cells[columns.get(name)!], source.sourceContent.encoding)
        if (table.name === 'document_history' && referencesSavedContent(parseInitialIncomingStored(String(get('content_json'))), retiring)) return false
        if (table.name === 'document_trash') {
          const trash = parseInitialIncomingStored(String(get('snapshot_json')))
          if (!syncedPlainRecord(trash) || referencesSavedContent(trash.content, retiring)) return false
        }
        if (table.name === 'document_block_moves') for (const column of ['before_json', 'after_json']) {
          const sides = parseInitialIncomingStored(String(get(column)))
          if (!Array.isArray(sides) || sides.some(side => !syncedPlainRecord(side) || referencesSavedContent(side.content, retiring))) return false
        }
        if (table.name === 'document_templates' && referencesTemplate(JSON.parse(String(get('blocks_json'))), get('title'), get('summary'), retiring)) return false
      }
    }
    return true
  } catch { return false }
}
