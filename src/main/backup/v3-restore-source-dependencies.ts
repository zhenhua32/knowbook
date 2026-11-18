import type Database from 'better-sqlite3'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { isListBlockType, isNativeStructureBlockType } from '../../shared/blockTypes'
import { EditorRecoveryDraftStore } from '../editor-recovery/draft-store'
import { join } from 'node:path'
import { graph3Value } from '../database/restore-knowledge-graph3-data'
import type { Reference3Value } from '../database/restore-knowledge-reference3-read'
import { restoreExists } from '../database/restore-safety-files'

const historical = [
  'document_history', 'document_trash', 'document_templates', 'document_block_moves',
  'synced_group_history', 'synced_host_history'
] as const

function plain(value: unknown): boolean {
  return value === null || typeof value === 'string' && !/[\[<>&\\]|#\^|(?:knowbook|file|asset|block):/iu.test(value)
}

function hasNoReferenceSyntax(type: unknown, content: unknown) {
  // These formats use the same text content for navigation. Structured values
  // and any text that could contain a destination still need a full reference proof.
  return typeof type === 'string' && (type === 'paragraph' || /^heading-[1-6]$/.test(type) || type === 'quote'
    || isListBlockType(type) || isNativeStructureBlockType(type)) && plain(content)
}

export function plainV3RetirementGroup(group: SyncedGroupWire) {
  return group.bindings.length === 0 && group.blocks.length > 0 && group.blocks.every(block => block.type === 'paragraph' && plain(block.content))
}

export function hasNoV3RetirementReferenceDependencies(candidate: Reference3Value['candidate'], groups: readonly SyncedGroupWire[]) {
  const ids = new Set(groups.map(group => group.id))
  if (candidate.pendingLocalBody || !candidate.finalForestValidated || !candidate.candidateConflictFree
    || candidate.activeGroupWires.some(wire => ids.has(wire.id) ? !plainV3RetirementGroup(wire)
      : wire.bindings.length || wire.blocks.some(block => !hasNoReferenceSyntax(block.type, block.content)))) return false
  for (const table of candidate.tables) {
    if (table.name === 'document_templates' && table.rows.length) return false
    for (const row of table.rows) {
      const get = (column: string) => graph3Value(row.cells[table.columns.indexOf(column)], table.encoding)
      if (table.name === 'synced_instances' && ids.has(String(get('group_id')))) return false
      if (table.name === 'documents' && (!plain(get('title')) || !plain(get('summary')))) return false
      if (table.name === 'blocks' && get('type') !== 'synced-block' && !hasNoReferenceSyntax(get('type'), get('content'))) return false
    }
  }
  return true
}

export function hasNoV3RetirementSqlDependencies(db: Database.Database, groups: readonly SyncedGroupWire[]) {
  for (const table of historical) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      || db.prepare('SELECT 1 FROM ' + table + ' LIMIT 1').get()) return false
  }
  const groupIds = JSON.stringify(groups.map(group => group.id))
  if (db.prepare('SELECT 1 FROM synced_instances WHERE group_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(groupIds)
    || db.prepare('SELECT 1 FROM synced_group_pins WHERE group_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(groupIds)
    || db.prepare(`SELECT 1 FROM synced_group_exposure_members m JOIN synced_exposure_attempts a ON a.id=m.attempt_id
      WHERE m.group_id IN (SELECT value FROM json_each(?)) AND a.channel LIKE 'webdav-%' LIMIT 1`).get(groupIds)
    || db.prepare('SELECT 1 FROM document_block_routes WHERE block_id IN (SELECT value FROM json_each(?)) LIMIT 1')
      .get(JSON.stringify(groups.flatMap(group => group.blocks.map(block => block.id))))) return false
  for (const row of db.prepare('SELECT title,summary FROM documents').iterate() as Iterable<{title: string; summary: string}>)
    if (!plain(row.title) || !plain(row.summary)) return false
  for (const sql of ["SELECT type,content FROM blocks WHERE type<>'synced-block'", 'SELECT type,content FROM synced_group_blocks']) {
    for (const row of db.prepare(sql).iterate() as Iterable<{type: string; content: string}>)
      if (!hasNoReferenceSyntax(row.type, row.content)) return false
  }
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

export function hasNoV3RetirementHistoricalReferences(source: {
  sourceContent: { tables: readonly { name: string; rows: readonly unknown[] }[] }
  physical: {
    documents: readonly {title: string; summary: string; blocks: readonly {type: string; content: string}[] }[]
    groups: readonly {groupId: string; snapshot: {bindings: readonly unknown[]; blocks: readonly {type: string; content: string}[]} | null}[]
    instances: readonly {group_id: string}[]
  }
}, excludedGroupId: string) {
  const { documents, groups, instances } = source.physical
  return !source.sourceContent.tables.some(table => historical.some(name => name === table.name) && table.rows.length)
    && documents.every(doc => plain(doc.title) && plain(doc.summary)
      && doc.blocks.every(block => block.type === 'synced-block' || hasNoReferenceSyntax(block.type, block.content)))
    && groups.every(group => group.groupId === excludedGroupId || group.snapshot === null
      || !group.snapshot.bindings.length && group.snapshot.blocks.every(block => hasNoReferenceSyntax(block.type, block.content)))
    && !instances.some(instance => instance.group_id === excludedGroupId)
}
