import { randomUUID } from 'node:crypto'
import type { DocumentBlockDraft, DocumentDatabaseFieldValue, BackupRestorePreview, BackupRestoreResult } from '@shared/contracts'
import { mapDatabaseViewReferences, parseDatabaseViewPayload, serializeDatabaseViewPayload } from '@shared/databaseViewBlock'
import { collectMarkdownSourceLinks, escapeMarkdownDestination, parseLocalMarkdownUrl } from '@shared/markdownLinks'
import { parseWikiReference, rewriteWikiReference } from '@shared/markdownWiki'
import type { KnowbookStore } from '../database/store'
import { backupJson, failBackup, isSystemField, mapDatabaseViewConfigFieldIds, mapLegacyScope, validateExportSnapshot, type ArchiveV2 } from './v2-format'

type Kind = 'document' | 'database' | 'column' | 'view' | 'entity' | 'block'
type Identity = { lineage: string; kind: Kind; source_database_id: string; source_id: string; state: 'live' | 'missing'; target_id: string }
type Row = Record<string, string | number | null>
const tableByKind: Record<Kind, string> = { document: 'documents', database: 'databases', column: 'document_database_columns', view: 'database_saved_views', entity: 'database_entities', block: 'blocks' }
const watchedTables = ['documents', 'blocks', 'databases', 'document_database_columns', 'database_saved_views', 'database_entities', 'database_entity_values', 'document_database_values', 'backup_restore_identities']
function fingerprint(store: KnowbookStore): string {
  const db = store.getUnsafeDatabaseHandle()
  return backupJson(watchedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
}
const identityKey = (kind: Kind, owner: string, id: string, state = 'live') => backupJson([kind, owner, id, state])
export type RestorePlanV2 = {
  archive: ArchiveV2; expected: string; identities: Identity[]; maps: Map<string, string>; catalogId: string
  deleteDocuments: string[]; deleteDatabases: string[]; prune: { column: string[]; view: string[]; entity: string[] }
  preview: Omit<BackupRestorePreview, 'root'>
}

/** Pure with respect to the workspace. The same planner drives preview and apply. */
export function planRestoreV2(store: KnowbookStore, archive: ArchiveV2): RestorePlanV2 {
  const db = store.getUnsafeDatabaseHandle(), expected = fingerprint(store), lineage = archive.catalog.id
  const defaultRow = db.prepare("SELECT value FROM app_settings WHERE key = 'database.defaultId'").get() as { value: string } | undefined
  if (!defaultRow || !db.prepare('SELECT id FROM databases WHERE id = ?').get(defaultRow.value)) return failBackup('target catalog identity is missing')
  const catalogId = defaultRow.value, maps = new Map<string, string>(), identities: Identity[] = []
  const previous = db.prepare('SELECT * FROM backup_restore_identities WHERE lineage = ?').all(lineage) as Identity[]
  const prior = new Map(previous.map(row => [identityKey(row.kind, row.source_database_id, row.source_id, row.state), row]))
  const occupied = new Map<Kind, Map<string, Row>>()
  const reserved = new Map<Kind, Set<string>>()
  for (const kind of Object.keys(tableByKind) as Kind[]) {
    occupied.set(kind, new Map((db.prepare(`SELECT * FROM ${tableByKind[kind]}`).all() as Row[]).map(row => [String(row.id), row])))
    reserved.set(kind, new Set((db.prepare('SELECT target_id FROM backup_restore_identities WHERE kind = ?').all(kind) as Array<{ target_id: string }>).map(row => row.target_id)))
  }
  const used = new Map<Kind, Set<string>>()
  const choose = (kind: Kind, owner: string, sourceId: string, compatible: (row: Row) => boolean, state: 'live' | 'missing' = 'live', forced?: string): string => {
    const key = identityKey(kind, owner, sourceId, state)
    if (maps.has(key)) return maps.get(key)!
    const old = prior.get(key), rows = occupied.get(kind)!, claimed = used.get(kind) ?? new Set<string>()
    const available = (id: string) => !claimed.has(id) && (state === 'missing' ? !rows.has(id) : !rows.has(id) || compatible(rows.get(id)!))
    let target = forced ?? (old && available(old.target_id) ? old.target_id : available(sourceId) && !reserved.get(kind)!.has(sourceId) ? sourceId : undefined)
    if (!target || !available(target)) do { target = randomUUID() } while (rows.has(target) || reserved.get(kind)!.has(target) || claimed.has(target))
    claimed.add(target); used.set(kind, claimed); maps.set(key, target)
    identities.push({ lineage, kind, source_database_id: owner, source_id: sourceId, state, target_id: target })
    return target
  }
  choose('database', '', archive.catalog.id, row => row.id === catalogId, 'live', catalogId)
  for (const source of archive.databases) choose('database', '', source.id, row => row.id !== catalogId)
  for (const source of [archive.catalog, ...archive.databases]) {
    const target = maps.get(identityKey('database', '', source.id))!
    for (const column of source.columns) choose('column', source.id, column.id, row => row.database_id === target && row.type === column.type)
    for (const view of source.savedViews) choose('view', source.id, view.id, row => row.database_id === target)
    for (const entity of source.entities) choose('entity', source.id, entity.id, row => row.database_id === target)
  }
  for (const source of archive.documents) choose('document', '', source.id, () => true)
  const restoredDocuments = new Set(archive.documents.map(source => maps.get(identityKey('document', '', source.id))!))
  const snapshots = store.getAllDocumentSnapshots()
  const documentPolicy = archive.manifest.deletion.documents
  const deleteDocuments = documentPolicy.mode === 'none' ? [] : snapshots.filter(row => !restoredDocuments.has(row.id)
    && documentPolicy.paths.some(scope => !scope || row.path === scope || row.path.startsWith(scope + '/'))).map(row => row.id)
  const deleted = new Set(deleteDocuments)
  for (const source of archive.documents) for (const block of source.blocks) {
    if (!block.id) return failBackup('persisted host block has no identity')
    const targetDocument = maps.get(identityKey('document', '', source.id))!
    choose('block', source.id, block.id, row => row.document_id === targetDocument || restoredDocuments.has(String(row.document_id)) || deleted.has(String(row.document_id)))
  }
  for (const id of archive.manifest.missing.databaseIds) choose('database', '', id, () => false, 'missing')
  for (const item of archive.manifest.missing.views) choose('view', item.databaseId, item.viewId, () => false, 'missing')
  for (const item of archive.manifest.missing.fields) choose('column', item.databaseId, item.fieldId, () => false, 'missing')
  const restoredDatabases = new Set([catalogId, ...archive.databases.map(source => maps.get(identityKey('database', '', source.id))!)])
  const deleteDatabases = [...occupied.get('database')!.keys()].filter(id => !restoredDatabases.has(id))
  const prune: RestorePlanV2['prune'] = { column: [], view: [], entity: [] }
  for (const kind of ['column', 'view', 'entity'] as const) {
    const current = new Set(identities.filter(row => row.kind === kind && row.state === 'live').map(row => row.target_id))
    const sourceOwned = new Set(previous.filter(row => row.kind === kind && row.state === 'live' && row.source_database_id === lineage).map(row => row.target_id))
    for (const [id, row] of occupied.get(kind)!) if (!current.has(id) && (row.database_id === catalogId
      ? lineage === catalogId || sourceOwned.has(id) : restoredDatabases.has(String(row.database_id)))) prune[kind].push(id)
  }
  const removedEntities = new Set(prune.entity)
  for (const id of prune.column) {
    const documentValues = db.prepare('SELECT document_id FROM document_database_values WHERE column_id = ?').all(id) as Array<{ document_id: string | null }>
    if (documentValues.some(row => row.document_id && !deleted.has(row.document_id) && !restoredDocuments.has(row.document_id))) return failBackup('catalog column prune would delete preserved document values')
    const entityValues = db.prepare('SELECT entity_id FROM database_entity_values WHERE column_id = ?').all(id) as Array<{ entity_id: string }>
    if (entityValues.some(row => !removedEntities.has(row.entity_id) && !identities.some(identity => identity.kind === 'entity' && identity.target_id === row.entity_id && identity.state === 'live'))) return failBackup('catalog column prune would delete unrelated entity values')
  }
  const targetPaths = new Map(archive.documents.map(source => [source.path, maps.get(identityKey('document', '', source.id))!]))
  for (const source of archive.documents) {
    const parent = source.path.split('/').slice(0, -1).join('/')
    if (parent && !targetPaths.has(parent)) return failBackup('complete archive is missing a document parent')
    const occupant = snapshots.find(row => row.path === source.path)
    if (occupant && !restoredDocuments.has(occupant.id) && !deleted.has(occupant.id)) return failBackup('restored document path is occupied outside the authorized deletion scope')
  }
  const entityBindings = new Map<string, string | null>(), bindingOwners = new Set<string>()
  for (const source of [archive.catalog, ...archive.databases]) for (const entity of source.entities) {
    const document = entity.documentId ? maps.get(identityKey('document', '', entity.documentId))! : null
    entityBindings.set(maps.get(identityKey('entity', source.id, entity.id))!, document)
    if (document) {
      const key = backupJson([maps.get(identityKey('database', '', source.id)), document])
      if (bindingOwners.has(key)) return failBackup('duplicate linked document entity')
      bindingOwners.add(key)
    }
  }
  for (const source of [archive.catalog, ...archive.databases]) for (const entity of source.entities) if (entity.documentId) {
    const database = maps.get(identityKey('database', '', source.id))!, document = maps.get(identityKey('document', '', entity.documentId))!, target = maps.get(identityKey('entity', source.id, entity.id))!
    const clash = [...occupied.get('entity')!.values()].find(row => row.database_id === database && row.document_id === document && row.id !== target)
    if (clash && !prune.entity.includes(String(clash.id)) && (!entityBindings.has(String(clash.id)) || entityBindings.get(String(clash.id)) === document)) return failBackup('linked entity identity conflicts with an existing record')
  }
  const created = archive.documents.filter(source => !occupied.get('document')!.has(maps.get(identityKey('document', '', source.id))!)).length
  const databaseCreated = archive.databases.filter(source => !occupied.get('database')!.has(maps.get(identityKey('database', '', source.id))!)).length
  return { archive, expected, identities, maps, catalogId, deleteDocuments, deleteDatabases, prune,
    preview: { restored: archive.documents.length, created, updated: archive.documents.length - created, deleted: deleteDocuments.length,
      conflictsResolved: 0, placeholdersCreated: 0, standaloneDatabases: archive.databases.length, standaloneDatabasesCreated: databaseCreated,
      standaloneDatabasesUpdated: archive.databases.length - databaseCreated, standaloneDatabasesDeleted: deleteDatabases.length } }
}

export function applyRestoreV2(store: KnowbookStore, plan: RestorePlanV2, root: string): BackupRestoreResult {
  if (fingerprint(store) !== plan.expected) return failBackup('workspace changed while preparing restore; preview again')
  const db = store.getUnsafeDatabaseHandle(), { archive, maps } = plan, now = new Date().toISOString()
  const mapped = (kind: Kind, owner: string, source: string): string => maps.get(identityKey(kind, owner, source))
    ?? maps.get(identityKey(kind, owner, source, 'missing')) ?? failBackup('unplanned reference')
  const field = (owner: string, id: string): string => isSystemField(id) ? id : mapped('column', owner, id)
  const payload = (content: string) => serializeDatabaseViewPayload(mapDatabaseViewReferences(parseDatabaseViewPayload(content), {
    databaseId: id => mapped('database', '', id), viewId: (owner, id) => mapped('view', owner, id), fieldId: field
  }))
  const values = (owner: string, input: Record<string, DocumentDatabaseFieldValue>) => Object.fromEntries(Object.entries(input).map(([id, value]) => [field(owner, id), value]))
  // Release restored descendants before deleting stale ancestors. The public
  // delete operation reparents children and may otherwise hit a sibling which
  // this same complete plan will replace or delete later.
  for (const source of archive.documents) {
    const id = mapped('document', '', source.id), old = store.getDocumentSnapshot(id)
    if (old) store.documentRecovery.checkpoint(id, 'restore')
    else db.prepare(`INSERT INTO documents(id,title,slug,parent_id,path,summary,sort_order,created_at,updated_at) VALUES(?,?,?,NULL,?,'',0,?,?)`)
      .run(id, source.title, `doc-${id}`, `__restore-${id}`, now, now)
    db.prepare('UPDATE documents SET title=?,path=?,parent_id=NULL WHERE id=?').run(`__restore-${id}`, `__restore-${id}`, id)
  }
  const deletedByDepth = [...plan.deleteDocuments].sort((left, right) => (store.getDocumentSnapshot(right)?.path.split('/').length ?? 0) - (store.getDocumentSnapshot(left)?.path.split('/').length ?? 0))
  for (const id of deletedByDepth) store.deleteDocument(id)
  for (const id of plan.prune.view) db.prepare('DELETE FROM database_saved_views WHERE id=?').run(id)
  for (const id of plan.prune.entity) db.prepare('DELETE FROM database_entities WHERE id=?').run(id)
  for (const identity of plan.identities) if (identity.kind === 'entity' && identity.state === 'live') db.prepare('UPDATE database_entities SET document_id=NULL WHERE id=?').run(identity.target_id)
  for (const source of [archive.catalog, ...archive.databases]) {
    const id = mapped('database', '', source.id)
    db.prepare(`INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,updated_at=excluded.updated_at`)
      .run(id, source.name, source.description, source.createdAt, now)
    for (const column of source.columns) {
      const columnId = mapped('column', source.id, column.id)
      db.prepare(`INSERT INTO document_database_columns(id,database_id,name,type,options_json,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,options_json=excluded.options_json,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
        .run(columnId, id, column.name, column.type, backupJson(column.options), column.sortOrder, now, now)
    }
  }
  const pathIds = new Map(archive.documents.map(source => [source.path, mapped('document', '', source.id)]))
  for (const source of archive.documents) for (const block of source.blocks) {
    db.prepare('UPDATE blocks SET document_id=? WHERE id=?').run(mapped('document', '', source.id), mapped('block', source.id, block.id))
  }
  const allBlockIds = new Map(archive.documents.flatMap(source => source.blocks.map(block => [block.id, mapped('block', source.id, block.id)] as const)))
  const rewriteBlockLinks = (content: string): string => {
    const edits = collectMarkdownSourceLinks(content).map(link => {
      const reference = link.kind === 'wiki' ? parseWikiReference(link.url) : null
      const local = reference ?? parseLocalMarkdownUrl(link.url)
      if (!local) return { ...link, replacement: link.url }
      const raw = local.fragment, id = raw.startsWith('^') ? raw.slice(1) : raw, next = allBlockIds.get(id)
      const replacement = !next || next === id ? link.url : reference ? rewriteWikiReference(reference, reference.path, (raw.startsWith('^') ? '^' : '') + next)
        : link.url.replace(/#.*$/, '#' + (raw.startsWith('^') ? '^' : '') + encodeURIComponent(next))
      return { ...link, replacement }
    })
    for (const edit of edits.reverse()) if (edit.replacement !== edit.url) content = content.slice(0, edit.start) + escapeMarkdownDestination(edit.replacement, edit.kind === 'wiki' ? 'wiki' : edit.syntax) + content.slice(edit.end)
    return content
  }
  for (const source of [...archive.documents].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const id = mapped('document', '', source.id), parent = source.path.split('/').slice(0, -1).join('/')
    db.prepare('UPDATE documents SET parent_id=? WHERE id=?').run(parent ? pathIds.get(parent)! : null, id)
    const blocks: DocumentBlockDraft[] = source.blocks.map(block => ({ ...block, id: mapped('block', source.id, block.id),
      parentBlockId: block.parentBlockId ? mapped('block', source.id, block.parentBlockId) : null,
      content: block.type === 'database-view' ? payload(block.content) : ['code', 'math', 'frontmatter'].includes(block.type) ? block.content : rewriteBlockLinks(block.content) }))
    store.updateDocument(id, { title: source.title, summary: source.summary, blocks }, { skipCheckpoint: true })
    db.prepare('DELETE FROM document_database_values WHERE document_id=?').run(id)
    for (const [columnId, value] of Object.entries(values(archive.catalog.id, source.documentDatabaseFieldValues))) store.updateDocumentDatabaseValue({ documentId: id, columnId, value })
  }
  for (const source of [archive.catalog, ...archive.databases]) {
    const databaseId = mapped('database', '', source.id)
    // Free only mapped names to allow legitimate saved-view name swaps.
    for (const view of source.savedViews) db.prepare('UPDATE database_saved_views SET name=? WHERE id=?').run(`__restore-${mapped('view', source.id, view.id)}`, mapped('view', source.id, view.id))
    for (const view of source.savedViews) {
      const id = mapped('view', source.id, view.id)
      let name = view.name, suffix = 0
      while (db.prepare('SELECT id FROM database_saved_views WHERE database_id=? AND name=? COLLATE NOCASE AND id!=?').get(databaseId, name, id)) name = `${view.name} (恢复${++suffix === 1 ? '' : ' ' + suffix})`
      db.prepare(`INSERT INTO database_saved_views(id,database_id,name,filter_query,filter_scope,sort_mode,view_mode,config_json,config_version,sort_order,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,filter_query=excluded.filter_query,filter_scope=excluded.filter_scope,
        sort_mode=excluded.sort_mode,view_mode=excluded.view_mode,config_json=excluded.config_json,config_version=1,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
        .run(id, databaseId, name, view.filterQuery, mapLegacyScope(view.filterScope, id => field(source.id, id)), view.sortMode, view.viewMode,
          backupJson(mapDatabaseViewConfigFieldIds(view.config, id => field(source.id, id))), view.sortOrder, view.createdAt, now)
    }
    for (const entity of source.entities) {
      const id = mapped('entity', source.id, entity.id)
      db.prepare(`INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,document_id=excluded.document_id,updated_at=excluded.updated_at`)
        .run(id, databaseId, entity.title, entity.documentId ? mapped('document', '', entity.documentId) : null, entity.createdAt, now)
      db.prepare('DELETE FROM database_entity_values WHERE entity_id=?').run(id)
      const next = values(source.id, entity.fieldValues)
      // Reuse typed value validation/serialization without creating a second identity.
      store.updateDatabaseEntity({ entityId: id, title: entity.title, documentId: entity.documentId ? mapped('document', '', entity.documentId) : null, fieldValues: next })
    }
  }
  for (const kind of ['view', 'entity', 'column'] as const) for (const id of plan.prune[kind]) db.prepare(`DELETE FROM ${tableByKind[kind]} WHERE id=?`).run(id)
  for (const id of plan.deleteDatabases) store.deleteDatabase(id)
  for (const identity of plan.identities) {
    const row = db.prepare(`SELECT * FROM ${tableByKind[identity.kind]} WHERE id=?`).get(identity.target_id) as Row | undefined
    if (identity.state === 'missing' ? !!row : !row) return failBackup('final restored identity state changed')
    if (row && ['column', 'view', 'entity'].includes(identity.kind)
      && row.database_id !== mapped('database', '', identity.source_database_id)) return failBackup('final restored owner changed')
  }
  for (const source of archive.documents) if (store.getDocumentSnapshot(mapped('document', '', source.id))?.path !== source.path) return failBackup('final document path changed')
  validateExportSnapshot(store.getExportWorkspaceSnapshot())
  const save = db.prepare(`INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)
    ON CONFLICT(lineage,kind,source_database_id,source_id,state) DO UPDATE SET target_id=excluded.target_id`)
  for (const row of plan.identities) save.run(row.lineage, row.kind, row.source_database_id, row.source_id, row.state, row.target_id)
  return { root, restored: plan.preview.restored, created: plan.preview.created, updated: plan.preview.updated, deleted: plan.preview.deleted,
    conflictsResolved: 0, placeholdersCreated: 0, at: now }
}
