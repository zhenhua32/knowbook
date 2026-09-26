import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

for (const withLegacySlug of [false, true]) {
  test(withLegacySlug
    ? 'document creation preserves legacy short slugs when new UUIDs share their prefix'
    : 'bulk document creation accepts distinct UUIDs with the same first eight characters', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'knowbook-document-identity-'))
    const databasePath = join(root, 'workspace.sqlite')
    const store = new KnowbookStore(databasePath)
    const database = new Database(databasePath)
    try {
      const legacyId = withLegacySlug ? store.createDocument(null) : null
      if (legacyId) database.prepare('UPDATE documents SET slug = ? WHERE id = ?').run('doc-12345678', legacyId)
      const originalSlugs = database.prepare('SELECT id, slug FROM documents ORDER BY id').all()
      const initialCount = store.getDocumentIndex().length

      // Reproduce the random prefix collision deterministically, including the
      // bulk mutation boundary used by Markdown import and the CI benchmark.
      let sequence = 0
      const uuid = context.mock.method(crypto, 'randomUUID', (): ReturnType<typeof crypto.randomUUID> =>
        `12345678-1234-4234-8234-${String(++sequence).padStart(12, '0')}`)
      syncBuiltinESMExports()
      try {
        const ids = store.runInBulkDocumentMutation(() => {
          const first = store.createDocument(null)
          return [first, store.createDocument(first), store.createDocument(null)]
        })

        assert.equal(new Set(ids).size, 3)
        assert.ok(ids.every((id) => id.startsWith('12345678-')))
        assert.equal(store.getDocumentIndex().length, initialCount + 3)
        assert.equal(store.getDocumentIndex().find((document) => document.id === ids[1])?.parentId, ids[0])
        for (const id of ids) assert.equal(store.getDocumentDetail(id)?.blocks.length, 2)
        const slugs = database.prepare('SELECT slug FROM documents').all() as Array<{ slug: string }>
        assert.equal(new Set(slugs.map((row) => row.slug)).size, slugs.length)
        assert.deepEqual(database.prepare('SELECT id, slug FROM documents WHERE id NOT IN (?, ?, ?) ORDER BY id').all(...ids), originalSlugs)
      } finally {
        uuid.mock.restore()
        syncBuiltinESMExports()
      }
    } finally {
      database.close()
      store.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
