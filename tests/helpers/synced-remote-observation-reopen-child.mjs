import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertSyncedLifecycleSchema } from '../../src/main/database/synced-lifecycle-schema.ts'
import { getSyncedCreateRestoreContext, restoreSyncedHostOperation } from '../../src/main/database/synced-host-final.ts'

const [file, inputFile] = process.argv.slice(2), input = JSON.parse(readFileSync(inputFile, 'utf8'))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const db = new Database(file); db.pragma('foreign_keys=ON')
function tables() {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]))
}
let report
try {
  const before = hash(tables()), changes = db.prepare('SELECT total_changes() AS n').get().n
  assertSyncedLifecycleSchema(db)
  const context = getSyncedCreateRestoreContext(db, { historyToken: input.historyToken, direction: input.direction })
  assert.deepEqual(context, { status: 'unavailable', reason: 'lifecycle' })
  const inverse = restoreSyncedHostOperation(db, { ...input, clientOperationId: randomUUID() })
  assert.deepEqual(inverse, { status: 'unsupported', reason: 'lifecycle' })
  const after = hash(tables()); assert.equal(after, before); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  report = { status: 'passed', beforeHash: before, afterHash: after, context, inverse }
} finally { db.close() }
process.stdout.write(JSON.stringify(report) + '\n')
