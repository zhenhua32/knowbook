import type Database from 'better-sqlite3'
import type { SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { assertPersistedTemplateForest, isSyncedBlockId, parseSyncedBlockPayload, syncedPlainRecord,
  validatePersistedHostForest } from '../../shared/syncedBlockValidation'
import { serializeBlocksToMarkdown, type MarkdownRenderableBlock } from '../../shared/markdown'
import { getMarkdownHeadingTargets, type MarkdownHeadingTarget } from '../../shared/markdownLinkMaintenance'
import { collectMarkdownSourceLinks, parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { findWikiHeading, parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '../../shared/markdownWiki'
import { decodeMarkdownFormat } from '../../shared/markdownFormat'
import { parseInitialIncomingStored } from '../sync/synced-initial-incoming-model'
import { EditorRecoveryDraftStore } from '../editor-recovery/draft-store'
import { join } from 'node:path'
import { graph3Value, type Graph3Inputs } from '../database/restore-knowledge-graph3-data'
import { capsule2RawTableRows, type Capsule2RawContentStream } from '../database/restore-knowledge-capsule2-raw-model'
import type { Reference3Value } from '../database/restore-knowledge-reference3-read'
import { restoreExists } from '../database/restore-safety-files'

function stableTargets(groups: readonly SyncedGroupWire[]) {
  return {
    groups: new Set(groups.map(group => group.id)),
    blocks: new Set(groups.flatMap(group => [...group.blocks.map(block => block.id), group.origin.firstInstanceId]))
  }
}

type LinkOrigin = { documentId: string; path?: string }
type LinkDocument = { documentId: string; path: string; title: string }
type GraphOriginal = Graph3Inputs['inputs']['source']
type Original = { source: Pick<GraphOriginal['source'], 'physical'> & { sourceContent: Capsule2RawContentStream };
  knowledge: Pick<GraphOriginal['knowledge'], 'pins' | 'occupancy' | 'bindings' | 'hostJournals' | 'groupHistories' | 'archivedGroupHistories'> }

const sqliteNoCase = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase())

function append<T>(index: Map<string, T[]>, key: string, entries: readonly T[]) {
  const values = index.get(key)
  if (values) values.push(...entries)
  else index.set(key, [...entries])
}

function targets(groups: readonly SyncedGroupWire[], documents: readonly LinkDocument[]) {
  const byDocument = new Map<string, MarkdownHeadingTarget[]>()
  const byPath = new Map<string, MarkdownHeadingTarget[]>()
  const wikiByPath = new Map<string, MarkdownHeadingTarget[]>()
  const names = new Map<string, LinkDocument[]>()
  const paths = new Map<string, LinkDocument>()
  const wikiPaths = new Map<string, LinkDocument>()
  const documentsById = new Map(documents.map(document => [document.documentId, document]))
  for (const document of documents) {
    paths.set(document.path, document)
    wikiPaths.set(sqliteNoCase(document.path), document)
    append(names, sqliteNoCase(document.title), [document])
  }
  for (const group of groups) {
    const { documentId, pathAtCreation } = group.origin
    const current = documentsById.get(documentId)
    const headings = getMarkdownHeadingTargets(group.blocks, current?.title ?? '').filter(heading => heading.blockId !== null)
    if (!headings.length) continue
    append(byDocument, documentId, headings)
    for (const path of new Set([pathAtCreation, ...(current ? [current.path] : [])])) {
      append(byPath, path, headings)
      append(wikiByPath, sqliteNoCase(path), headings)
    }
  }
  return { ...stableTargets(groups), byDocument, byPath, wikiByPath, allHeadings: [...byDocument.values()].flat(),
    documentsById, wikiLookup: { byPath: (path: string) => paths.get(path) ?? wikiPaths.get(sqliteNoCase(path)),
      byTitle: (title: string) => names.get(sqliteNoCase(title)) ?? [] } }
}
type Targets = ReturnType<typeof targets>

function pointsToBlock(value: string | null, { blocks }: ReturnType<typeof stableTargets>) {
  if (!value) return false
  const matches = (id: string) => blocks.has(id) || id.startsWith('^') && blocks.has(id.slice(1))
  if (matches(value)) return true
  try { return matches(decodeURIComponent(value)) } catch { return false }
}

function pointsToHeading(fragment: string | null, headings: MarkdownHeadingTarget[] | undefined, wiki = false) {
  if (!fragment || !headings?.length || fragment.startsWith('^')) return false
  const missingSlugPrefix = 'knowbook-missing-heading-'
  // Projecting another block above a heading can change a generated duplicate slug.
  const withoutDuplicateSuffix = (slug: string) => slug.replace(/-[1-9][0-9]*$/, '')
  const unsuffixed = withoutDuplicateSuffix(fragment)
  return headings.some(heading => heading.slug === fragment || withoutDuplicateSuffix(heading.slug) === unsuffixed)
    || fragment.startsWith(missingSlugPrefix) && headings.some(heading => missingSlugPrefix
      + Array.from(heading.key, character => character.codePointAt(0)!.toString(16)).join('-') === fragment)
    || wiki && Boolean(findWikiHeading(fragment, headings))
}

function headingAtOrigin(fragment: string, retiring: Targets, origin: LinkOrigin | undefined, wiki: boolean) {
  return pointsToHeading(fragment, origin ? retiring.byDocument.get(origin.documentId) : retiring.allHeadings, wiki)
}

function referencesMarkdown(value: string, retiring: Targets, origin?: LinkOrigin) {
  const sourcePath = origin?.path ?? (origin && retiring.documentsById.get(origin.documentId)?.path)
  return collectMarkdownSourceLinks(value).some(link => {
    if (link.kind === 'image') return false
    if (link.kind === 'wiki') {
      const wiki = parseWikiReference(link.url)
      const lastHash = wiki.target.lastIndexOf('#')
      if (pointsToBlock(wiki.hasFragment ? wiki.fragment : wiki.target, retiring)
        // Historical Wiki paths can themselves contain # or |.
        || lastHash >= 0 && pointsToBlock(wiki.target.slice(lastHash + 1).trim(), retiring)
        || link.url.includes('#') && pointsToBlock(link.url.slice(link.url.lastIndexOf('#') + 1).trim(), retiring)) return true
      if (!wiki.hasFragment || !retiring.allHeadings.length) return false
      if (!wiki.path) return headingAtOrigin(wiki.fragment, retiring, origin, true)
      const resolved = resolveWikiDocument(link.url, sourcePath ?? '', retiring.wikiLookup)
      if (resolved && pointsToHeading(resolved.reference.fragment, retiring.byDocument.get(resolved.document.documentId), true)) return true
      if (sourcePath === undefined && /^\.\.?\//.test(wiki.path)) return pointsToHeading(wiki.fragment, retiring.allHeadings, true)
      if (wikiDocumentPaths(wiki.path, sourcePath ?? '').some(path =>
        pointsToHeading(wiki.fragment, retiring.wikiByPath.get(sqliteNoCase(path)), true))) return true
      for (const parsed of new Set([wiki.target, link.url.trim()])) {
        const hash = parsed.lastIndexOf('#'), path = parsed.slice(0, hash).trim()
        if (hash >= 0 && /[#|]/.test(path) && pointsToHeading(parsed.slice(hash + 1).trim(),
          retiring.wikiByPath.get(sqliteNoCase(path)), true)) return true
      }
      return false
    }
    const local = parseLocalMarkdownUrl(link.url)
    if (!local?.fragment) return false
    if (pointsToBlock(local.fragment, retiring)) return true
    if (!retiring.allHeadings.length) return false
    if (!local.path) return headingAtOrigin(local.fragment, retiring, origin, false)
    const path = resolveMarkdownDocumentPath(sourcePath ?? '', link.url)?.path
    return pointsToHeading(local.fragment, path === undefined ? undefined : retiring.byPath.get(path))
      || sourcePath === undefined && !local.path.startsWith('/') && /\.md$/i.test(local.path)
        && pointsToHeading(local.fragment, retiring.allHeadings)
  })
}

function referencesBindings(bindings: readonly SyncedLinkBinding[], retiring: Targets) {
  return bindings.some(({ target, syntax }) => {
    if (target.kind === 'block') return retiring.blocks.has(target.id)
    if (target.kind === 'heading') return pointsToHeading(target.slug, retiring.byDocument.get(target.documentId), syntax === 'wiki')
    if (target.kind !== 'unresolved-url') return false
    return pointsToBlock(target.fragment, retiring) || pointsToHeading(target.fragment,
      syntax === 'wiki' ? retiring.wikiByPath.get(sqliteNoCase(target.path)) : retiring.byPath.get(target.path), syntax === 'wiki')
  })
}

function referencesBody(blocks: readonly MarkdownRenderableBlock[], retiring: Targets, origin?: LinkOrigin, template = false) {
  for (const block of blocks) {
    if (block.id !== undefined && retiring.blocks.has(block.id)) return true
    if (block.type === 'synced-block') {
      if (retiring.groups.has(parseSyncedBlockPayload(block.content).groupId)) return true
    } else if (template && /\{\{(?:title|date)\}\}/.test(block.content)) {
      // The instantiated template may add actual Markdown or defer an ID.
      return true
    }
  }
  return referencesMarkdown(serializeBlocksToMarkdown([...blocks]), retiring, origin)
}

function referencesSavedContent(value: unknown, retiring: Targets, origin?: LinkOrigin) {
  if (!syncedPlainRecord(value) || typeof value.title !== 'string' || typeof value.summary !== 'string') return true
  return referencesMarkdown(value.title, retiring, origin) || referencesMarkdown(value.summary, retiring, origin)
    || referencesBody(validatePersistedHostForest(value.blocks), retiring, origin)
}

function referencesTemplate(blocks: unknown, title: unknown, summary: unknown, retiring: Targets) {
  assertPersistedTemplateForest(blocks)
  if (typeof title !== 'string' || typeof summary !== 'string') return true
  return /\{\{(?:title|date)\}\}/.test(title + '\n' + summary) || referencesMarkdown(title, retiring)
    || referencesMarkdown(summary, retiring) || referencesBody(blocks as MarkdownRenderableBlock[], retiring, undefined, true)
}

function referencesWire(wire: SyncedGroupWire, retiring: Targets) {
  return retiring.groups.has(wire.id) || referencesGroupContent(wire, retiring)
}

function referencesGroupContent(group: Pick<SyncedGroupWire, 'origin' | 'blocks' | 'bindings'>, retiring: Targets) {
  return referencesBindings(group.bindings, retiring) || referencesBody(group.blocks, retiring,
    { documentId: group.origin.documentId, path: group.origin.pathAtCreation })
}

export function hasNoV3RetirementReferenceDependencies(candidate: Reference3Value['candidate'], groups: readonly SyncedGroupWire[]) {
  try {
    if (candidate.pendingLocalBody || !candidate.finalForestValidated || !candidate.candidateConflictFree) return false
    const documentsTable = candidate.tables.find(table => table.name === 'documents')
    if (!documentsTable) return false
    const documentColumns = new Map(documentsTable.columns.map((name, index) => [name, index]))
    const documents: Array<LinkDocument & { summary: string }> = []
    for (const row of documentsTable.rows) {
      const get = (name: string) => graph3Value(row.cells[documentColumns.get(name)!], documentsTable.encoding)
      const documentId = get('id'), path = get('path'), title = get('title'), summary = get('summary')
      if (!isSyncedBlockId(documentId) || typeof path !== 'string' || typeof title !== 'string' || typeof summary !== 'string') return false
      documents.push({ documentId, path, title, summary })
    }
    const retiring = targets(groups, documents)
    if (candidate.activeGroupWires.some(wire => !retiring.groups.has(wire.id) && referencesGroupContent(wire, retiring))
      || documents.some(document => referencesMarkdown(document.title, retiring, document)
        || referencesMarkdown(document.summary, retiring, document))) return false
    const ordinary = new Map<string, Array<{ order: bigint; block: MarkdownRenderableBlock }>>()
    for (const table of candidate.tables) {
      if (!['blocks', 'document_templates', 'synced_instances'].includes(table.name)) continue
      const columns = new Map(table.columns.map((name, index) => [name, index]))
      for (const row of table.rows) {
        const get = (name: string) => graph3Value(row.cells[columns.get(name)!], table.encoding)
        if (table.name === 'synced_instances' && retiring.groups.has(String(get('group_id')))) return false
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
    return [...ordinary].every(([documentId, rows]) => !referencesBody(
      rows.sort((a, b) => a.order < b.order ? -1 : Number(a.order > b.order)).map(row => row.block), retiring, { documentId }))
  } catch { return false }
}

export function hasNoV3RetirementSqlDependencies(db: Database.Database, groups: readonly SyncedGroupWire[]) {
  const retiring = stableTargets(groups), groupIds = JSON.stringify([...retiring.groups])
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
  const { source, knowledge } = input
  const { documents, groups, instances, deletions } = source.physical
  try {
    const retiring = targets(wires, documents)
    const ownGroupHeader = (row: typeof knowledge.bindings[number]['source']) => row.table === 'synced_groups'
      && row.key.length === 1 && ownWires.has(String(graph3Value(row.key[0], source.sourceContent.encoding)))
    if (instances.some(instance => retiring.groups.has(instance.group_id)) || knowledge.pins.some(pin => retiring.groups.has(pin.groupId))
      || knowledge.occupancy.some(item => (item.kind === 'history' || item.kind === 'template' || item.kind === 'route')
        && !ownGroupHeader(item.source)
        && (item.namespace === 'instance' && item.source.table !== 'synced_groups' && retiring.blocks.has(item.id)
          || item.namespace === 'block' && retiring.blocks.has(item.id)
          || item.namespace === 'group' && retiring.groups.has(item.id)))
      || knowledge.bindings.some(item => !(item.provenance === 'current-stored' && ownGroupHeader(item.source))
        && referencesBindings([item.binding], retiring))
      || knowledge.hostJournals.some(({ decoded }) => {
        const journal = decoded.kind === 'finite' ? decoded.value : decoded
        return [...journal.before, ...journal.after].some(side => referencesSavedContent(side.content, retiring, side))
      })
      || [...knowledge.groupHistories, ...knowledge.archivedGroupHistories].some(({ before, after }) =>
        referencesWire(before, retiring) || referencesWire(after, retiring))
      || deletions.some(({ before }) => before.kind === 'document'
        ? referencesSavedContent(before.content, retiring, { documentId: before.id }) : referencesWire(before, retiring))) return false
    if (documents.some(document => referencesSavedContent(document, retiring, document))
      || groups.some(({ groupId, snapshot }) => snapshot && !ownWires.has(groupId)
        && referencesGroupContent(snapshot, retiring))) return false
    for (const table of source.sourceContent.tables) {
      if (!['document_history', 'document_trash', 'document_block_moves', 'document_templates'].includes(table.name)) continue
      const columns = new Map(table.columns.map((name, index) => [name, index]))
      for (const row of capsule2RawTableRows(table)) {
        const get = (name: string) => graph3Value(row.cells[columns.get(name)!], source.sourceContent.encoding)
        if (table.name === 'document_history' && referencesSavedContent(parseInitialIncomingStored(String(get('content_json'))), retiring,
          { documentId: String(get('document_id')), path: String(get('path')) })) return false
        if (table.name === 'document_trash') {
          const trash = parseInitialIncomingStored(String(get('snapshot_json')))
          if (!syncedPlainRecord(trash) || referencesSavedContent(trash.content, retiring, {
            documentId: String(get('id')), path: syncedPlainRecord(trash.document) && typeof trash.document.path === 'string' ? trash.document.path : undefined
          })) return false
        }
        if (table.name === 'document_block_moves') for (const column of ['before_json', 'after_json']) {
          const sides = parseInitialIncomingStored(String(get(column)))
          if (!Array.isArray(sides) || sides.some(side => !syncedPlainRecord(side) || typeof side.documentId !== 'string'
            || referencesSavedContent(side.content, retiring, { documentId: side.documentId, path: typeof side.path === 'string' ? side.path : undefined }))) return false
        }
        if (table.name === 'document_templates' && referencesTemplate(JSON.parse(String(get('blocks_json'))), get('title'), get('summary'), retiring)) return false
      }
    }
    return true
  } catch { return false }
}
