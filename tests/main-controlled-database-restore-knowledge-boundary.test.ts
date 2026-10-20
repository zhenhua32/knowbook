import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { initialIncomingReservationKey } from '../src/main/sync/synced-initial-incoming-model'
import { withControlledRestore, restoreKnowbookDatabase, noProcesses, assertOriginals, Database, randomUUID } from './helpers/controlled-restore-fixture'

const initialReservation = () => initialIncomingReservationKey('a'.repeat(64), randomUUID())
const exchangeReservation = () => 'sync.webdav.protocol5.exchange-reservation.v1.' + randomUUID()

for (const [kind, owner] of [['initial', initialReservation], ['exchange', exchangeReservation]] as const) {
  for (const side of ['current', 'candidate'] as const) {
    test(`controlled restore refuses ${side} ${kind} missing-target reservation without app metadata or a live group`, () => withControlledRestore(async f => {
      const db = side === 'current' ? f.db : new Database(f.backup)
      try {
        db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)")
          .run(randomUUID(), owner())
        assert.equal((db.prepare('SELECT count(*) AS n FROM synced_groups').get() as { n: number }).n, 0)
        assert.equal(db.prepare("SELECT 1 FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.%'").get(), undefined)
      } finally { if (side === 'candidate') db.close() }
      const source = Buffer.from(readFileSync(f.backup)), before = f.sealCurrent()
      let replaced = false
      await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
        beforeReplace: async () => { replaced = true } }), /同步/)
      assert.equal(replaced, false)
      assertOriginals(f.database, before)
      assert.deepEqual(readFileSync(f.backup), source)
      assert.equal(existsSync(join(f.profile, 'database-restore-fence.json')), false)
      assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
    }))
  }
}

for (const side of ['current', 'candidate'] as const) {
  test(`controlled restore refuses ${side} template-only synced reference before any replacement`, () => withControlledRestore(async f => {
    const db = side === 'current' ? f.db : new Database(f.backup)
    try {
      // A negative SQL fixture, not a real group or a forged authority receipt.
      const blocks = [{ id: randomUUID(), type: 'synced-block', content: JSON.stringify({ version: 1, groupId: randomUUID() }),
        checked: false, depth: 0, parentBlockId: null }]
      db.prepare('INSERT INTO document_templates(id,name,description,title,summary,blocks_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), 'Retained ref', '', 'Template title', '', JSON.stringify(blocks), new Date().toISOString())
      assert.equal(db.prepare("SELECT 1 FROM blocks WHERE type='synced-block'").get(), undefined)
    } finally { if (side === 'candidate') db.close() }
    const source = Buffer.from(readFileSync(f.backup)), before = f.sealCurrent()
    let replaced = false
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
      beforeReplace: async () => { replaced = true } }), /同步/)
    assert.equal(replaced, false)
    assertOriginals(f.database, before)
    assert.deepEqual(readFileSync(f.backup), source)
    assert.equal(existsSync(join(f.profile, 'database-restore-fence.json')), false)
    assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
  }))
}

for (const side of ['current', 'candidate'] as const) {
  test(`controlled restore refuses ${side} unknown synced view namespace without treating it as an empty table`, () => withControlledRestore(async f => {
    const db = side === 'current' ? f.db : new Database(f.backup)
    try { db.exec("CREATE VIEW synced_future_knowledge AS SELECT 'future format' AS fact") }
    finally { if (side === 'candidate') db.close() }
    const source = Buffer.from(readFileSync(f.backup)), before = f.sealCurrent()
    let replaced = false
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
      beforeReplace: async () => { replaced = true } }), /同步/)
    assert.equal(replaced, false)
    assertOriginals(f.database, before)
    assert.deepEqual(readFileSync(f.backup), source)
    assert.equal(existsSync(join(f.profile, 'database-restore-fence.json')), false)
    assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
  }))
}

test('controlled ordinary restore preserves legacy reserved identities and literal sync-looking template text', () => withControlledRestore(async f => {
  const candidate = new Database(f.backup), id = randomUUID(), templateId = randomUUID()
  const blocks = [{ type: 'paragraph', content: 'literal synced-block sync5:initial-missing-block:v1: and sync.webdav.protocol5.',
    checked: false, depth: 0, parentBlockId: null }]
  try {
    // The schema26 migration uses this owner for an ordinary template-only ID.
    candidate.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)")
      .run(id, 'template:' + templateId)
    candidate.prepare('INSERT INTO document_templates(id,name,description,title,summary,blocks_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(templateId, 'Ordinary template', '', 'Template title', '', JSON.stringify(blocks), new Date().toISOString())
  } finally { candidate.close() }
  const source = Buffer.from(readFileSync(f.backup))
  f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  const installed = new Database(f.database, { readonly: true, fileMustExist: true })
  try {
    assert.equal((installed.prepare('SELECT last_owner_id FROM block_identities WHERE id=?').get(id) as { last_owner_id: string }).last_owner_id, 'template:' + templateId)
    assert.equal((installed.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(templateId) as { blocks_json: string }).blocks_json, JSON.stringify(blocks))
  } finally { installed.close() }
  assert.deepEqual(readFileSync(f.backup), source)
}))
