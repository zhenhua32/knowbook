import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import Database from 'better-sqlite3'
import type { V3Fixture } from './synced-backup-v3-fixture'
import type { Capsule2RawContent } from '../../src/main/database/restore-knowledge-capsule2-raw-model'

/** Real ordinary Store writer remains alive from before the first Main group.
 * These inputs are not publication wire and do not mint an exposure. */
export function writeMixedOrdinary501(f: V3Fixture) {
  const title = '源'.repeat(501), detail = f.store.getDocumentDetail(f.targetId)
  assert.ok(detail)
  f.store.updateDocument(f.targetId, { title, summary: detail.summary, blocks: detail.blocks })
  const template = f.store.saveDocumentTemplate({ name: 'Actual capsule2 ordinary template', title: 'Template source', summary: 'Original template',
    blocks: [{ type: 'paragraph', content: 'Template has no physical ledger reservation', checked: false, depth: 0, parentBlockId: null }] })
  assert.equal(f.store.getDocumentDetail(f.targetId)?.title, title)
  assert.ok(f.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(f.groupId), 'The nonempty group/ACK is produced by the actual Main create writer')
  for (const block of template.blocks) { assert.ok(block.id); assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(block.id), undefined) }
  return { title, template }
}
/** A real SQLite online backup makes an independent scratch for raw SQL tests.
 * This helper does not certify or seal a capsule2, a DAG or accepted coverage. */
export async function withCapsule2RawCopy<T>(f: V3Fixture, run: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const file = join(f.root, 'capsule2-raw-only-' + randomUUID() + '.db')
  await f.db.backup(file)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { db.pragma('foreign_keys=ON'); db.pragma('query_only=ON'); return await run(db) }
  finally { db.close() }
}
export function decodedCapsule2Table(value: Capsule2RawContent, name: string): Array<Record<string, unknown>> {
  const table = value.tables.find(table => table.name === name)
  assert.ok(table)
  const decoder = new TextDecoder(value.encoding.toLowerCase(), { fatal: true, ignoreBOM: true })
  return table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    const decoded = cell[0] === 'null' ? null : cell[0] === 'text' ? decoder.decode(Buffer.from(cell[1], 'base64'))
      : cell[0] === 'blob' ? Buffer.from(cell[1], 'base64') : cell[0] === 'integer' ? BigInt(cell[1]) : Buffer.from(cell[1], 'hex').readDoubleLE()
    return [column, decoded]
  })))
}
