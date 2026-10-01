import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'
import { createWorkspaceEventRecord } from '../src/main/event-bus'
import { parseWorkspaceEventDetails } from '../src/shared/workspaceEventDetails'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

function withDatabase(run: (path: string, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-activity-test-'))
  try { run(join(root, 'workspace.sqlite'), root) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

function recentEvents(store: KnowbookStore, path: string) {
  return store.getHomeData(join(dirname(path), 'backups')).recentEvents
}

test('workspace activity retains historical document details after rename, deletion and restart', () => {
  withDatabase((path) => {
    let store = new KnowbookStore(path)
    const documentId = store.createDocument(null)
    const event = createWorkspaceEventRecord({
      type: 'document.created', documentId, documentTitle: '名称 "引号" / notes',
      path: '历史/名称 "引号" / notes', parentId: null, createdAt: '2026-10-01T00:00:00Z'
    })
    try {
      store.recordWorkspaceEvent(event)
      store.updateDocument(documentId, { title: 'Renamed', summary: '', blocks: [] })
      store.deleteDocument(documentId)
      store.destroy()
      store = new KnowbookStore(path)
      const recorded = recentEvents(store, path).find(item => item.type === 'document.created')!
      assert.deepEqual(recorded.details, event.details)
      assert.equal(recorded.documentId, null, 'deleted documents do not leave a broken navigation target')
      assert.equal(recorded.description, event.description, 'the original record stays available without text parsing')
    } finally { store.destroy() }
  })
})

test('v20 activity migration preserves legacy records and adds details without repeated migration', () => {
  withDatabase((path, root) => {
    const initial = new KnowbookStore(path)
    try { initial.recordWorkspaceEvent({ type: 'document.deleted', title: 'Legacy event', description: 'Legacy description', createdAt: '2026-09-30T00:00:00Z' }) }
    finally { initial.destroy() }
    const legacy = new Database(path)
    try {
      legacy.exec('ALTER TABLE workspace_events DROP COLUMN details_json')
      legacy.pragma('user_version = 20')
    } finally { legacy.close() }
    const migrated = new KnowbookStore(path)
    try {
      const event = recentEvents(migrated, path)[0]
      assert.equal(event.title, 'Legacy event')
      assert.equal(event.description, 'Legacy description')
      assert.equal(event.details, undefined)
      migrated.recordWorkspaceEvent(createWorkspaceEventRecord({
        type: 'document.deleted', documentId: 'deleted', documentTitle: '删除前的名称',
        oldPath: '项目/删除前的名称', affectedDocumentIds: ['child'], createdAt: '2026-10-01T00:00:00Z'
      }))
    } finally { migrated.destroy() }
    const snapshots = () => readdirSync(root).filter(name => name.startsWith(`workspace.sqlite.pre-migration-v20-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`))
    assert.equal(snapshots().length, 1, 'the existing migration safety-copy policy covers this schema change')
    const reopened = new KnowbookStore(path)
    try {
      const event = recentEvents(reopened, path)[0]
      assert.equal(event.details?.documentTitle, '删除前的名称')
      assert.equal(event.details?.affectedDocumentCount, 1)
      assert.equal(recentEvents(reopened, path).length, 2)
    } finally { reopened.destroy() }
    assert.equal(snapshots().length, 1, 'reopening does not migrate again')
    const verified = new Database(path)
    try { assert.equal(verified.pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION) }
    finally { verified.close() }
  })
})

test('malformed or unsupported activity details fall back without breaking workspace loading', () => {
  withDatabase((path) => {
    const store = new KnowbookStore(path)
    try { store.recordWorkspaceEvent({ type: 'ai.config.updated', title: 'AI settings', description: 'Original text' }) }
    finally { store.destroy() }
    for (const details of ['{broken', '{"schemaVersion":2}', '{"schemaVersion":1,"affectedDocumentCount":-1}']) {
      const db = new Database(path)
      try { db.prepare('UPDATE workspace_events SET details_json = ?').run(details) }
      finally { db.close() }
      const reopened = new KnowbookStore(path)
      try {
        const event = recentEvents(reopened, path)[0]
        assert.equal(event.details, undefined)
        assert.equal(event.description, 'Original text')
      } finally { reopened.destroy() }
    }
  })
  assert.deepEqual(parseWorkspaceEventDetails({ schemaVersion: 1, documentTitle: '<script>literal</script>', unknown: 'ignored' }),
    { schemaVersion: 1, documentTitle: '<script>literal</script>' })
})
