import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3, readRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { assertSyncedStoredBindings } from '../src/main/database/synced-stored-binding-read'
import { collectSyncedBindingOccurrences } from '../src/main/sync/synced-binding-occurrences'
import { validateSyncedGroupWire } from '../src/shared/syncedBlockValidation'
import { withCanonical3Fixture } from './helpers/canonical3-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { tamperContent3VerificationOriginals } from './helpers/content3-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreReferencePlan3>>['value']
const traceFile = process.env.KNOWBOOK_CANONICAL3_TEST_TRACE, traceStarted = Date.now()
const mark = (phase: string) => { if (traceFile) appendFileSync(traceFile, JSON.stringify({ phase, elapsedMs: Date.now() - traceStarted }) + '\n') }
function rows(value: Value, name: string) {
  const table = value.candidate.tables.find(table => table.name === name)!
  return table.rows.map(row => ({ row, value: Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  })) as Record<string, unknown> }))
}

test('actual Main reference kernel produces canonical SQL cells reserved target rows and complete original parser keys without installing', t =>
  withCanonical3Fixture(async f => {
    mark('fixture-returned')
    const n = f.cases, base = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    mark('base-prepared')
    const baseBytes = await readFile(join(base.directory, 'manifest.json'))
    const choice: { originPolicy: 'isolate-incoming' | 'preserve-exact-current-tuple'; anonymousValues: 'source' | 'current' | 'unresolved' } = {
      originPolicy: 'isolate-incoming', anonymousValues: 'source' }
    const prepared = await prepareRootRestoreReferencePlan3(base.plan, choice), value = prepared.value
    mark('reference-prepared')
    choice.originPolicy = 'preserve-exact-current-tuple'; choice.anonymousValues = 'current'
    const { allocation, candidate } = value
    const slot = (kind: string, id: string) => allocation.assignments.find(item => item.physical && item.kind === kind && item.sourceId === id)!
    await t.test('incoming group creation canonical children and every source instance have new identities while current external references survive', () => {
      mark('case-fork')
      assert.equal(allocation.baseIdentityAllocationHash, base.value.allocationHash)
      assert.notEqual(allocation.derivedReferenceAllocationHash, base.value.allocationHash)
      assert.ok(allocation.forcedGroupForks.length >= 4)
      for (const group of f.sourcePacket.source.physical.groups) {
        const mapped = slot('group', group.groupId)
        assert.notEqual(mapped.targetId, group.groupId)
        assert.notEqual(mapped.targetCreationId, group.snapshot!.creationId)
        for (const block of group.snapshot!.blocks) assert.notEqual(slot('block', block.id).targetId, block.id)
      }
      for (const instance of f.sourcePacket.source.physical.instances) assert.notEqual(slot('block', instance.instance_id).targetId, instance.instance_id)
      assert.equal(rows(value, 'synced_instances').find(entry => entry.value.instance_id === n.externalInstanceId)!.value.group_id, n.groupId)
      assert.ok(candidate.activeGroupWires.some(wire => wire.id === n.groupId), 'The current group remains for its retained external instance')
      assert.ok(candidate.activeGroupWires.some(wire => wire.id === slot('group', n.orphanGroupId).targetId), 'An active source orphan is fully scanned')
      assert.equal(allocation.execution.finalCurrentRetainedCutComplete, false)
    })
    await t.test('Origin changes only declared identity literals and never borrows the current document birth for a historical field', () => {
      mark('case-origin')
      const sourceOrigin = allocation.origins.find(item => item.side === 'source' && item.sourceGroupId === n.groupId)!
      assert.equal(sourceOrigin.documentProof, 'qualified-missing')
      assert.notEqual(sourceOrigin.origin.documentId, n.hostId)
      assert.equal(rows(value, 'documents').some(row => row.value.id === sourceOrigin.origin.documentId), false)
      assert.equal(sourceOrigin.firstInstanceProof, 'proved-historical-birth')
      assert.equal(sourceOrigin.origin.firstInstanceId, slot('block', n.instanceIds[0]).targetId)
      const header = rows(value, 'synced_groups').find(row => row.value.id === sourceOrigin.targetGroupId)!
      const expected = n.originalOriginJson.replace(JSON.stringify(sourceOrigin.originalOrigin.documentId), JSON.stringify(sourceOrigin.origin.documentId))
        .replace(JSON.stringify(sourceOrigin.originalOrigin.firstInstanceId), JSON.stringify(sourceOrigin.origin.firstInstanceId))
      assert.equal(header.value.origin_json, expected)
      assert.ok(String(header.value.origin_json).includes('Canonical \\"Reference\\" Source'))
      const currentHeader = rows(value, 'synced_groups').find(row => row.value.id === n.groupId)!
      assert.equal(currentHeader.value.origin_json, n.originalOriginJson)
    })
    await t.test('every CRLF duplicate and HTML destination uses its original Key and an independently reserved missing block target', () => {
      mark('case-ranges')
      const wire = candidate.activeGroupWires.find(wire => wire.id === slot('group', n.groupId).targetId)!
      const body = wire.blocks.find(block => block.id === slot('block', n.linkedId).targetId)!
      const original = allocation.bindingTargets.filter(item => item.side === 'source' && item.sourceGroupId === n.groupId && item.originalTarget.kind === 'block')
      assert.equal(original.length, 3)
      const ids = original.map(item => { assert.equal(item.target.kind, 'block'); return item.target.kind === 'block' ? item.target.id : '' })
      assert.equal(new Set(ids).size, 3, 'Equal URL/old IDs in independently captured Keys are not historical-birth proof')
      for (const item of original) {
        assert.equal(item.target.kind, 'block')
        if (item.target.kind !== 'block') continue
        assert.equal(item.target.state, 'missing'); assert.equal(item.target.documentId, null)
        const targetId = item.target.id
        assert.ok(allocation.materialization.reservationRows.some(row => row.id === targetId && row.created_at === null && row.state === 'retained'))
        assert.ok(body.content.includes('#^' + item.target.id))
        assert.equal(n.linked.slice(item.key.from, item.key.to), item.key.raw)
      }
      assert.ok(body.content.includes('\r\n<a href=')); assert.ok(body.content.endsWith('[empty]()'))
      const parsed = collectSyncedBindingOccurrences(wire.origin, wire.blocks).map(({ url: _url, ...key }) => key)
      assert.deepEqual(parsed, wire.bindings.map(({ target: _target, ...key }) => key))
      for (const active of candidate.activeGroupWires) assert.deepEqual(validateSyncedGroupWire(active), active)
    })
    await t.test('the real SQLite stored reader requires the missing reservations and rejects a fabricated physical occupant', () => {
      mark('case-sqlite')
      // Native validation instrument only, never a current stage or install.
      const db = new Database(':memory:')
      try {
        db.pragma('foreign_keys=ON')
        db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY); CREATE TABLE synced_groups(id TEXT PRIMARY KEY);'
          + 'CREATE TABLE blocks(id TEXT PRIMARY KEY,document_id TEXT REFERENCES documents(id),created_at TEXT);'
          + 'CREATE TABLE synced_group_blocks(id TEXT PRIMARY KEY,group_id TEXT REFERENCES synced_groups(id),created_at TEXT);'
          + 'CREATE TABLE block_identities(id TEXT PRIMARY KEY,last_owner_kind TEXT,last_owner_id TEXT,state TEXT,created_at TEXT);')
        db.transaction(() => {
          for (const row of rows(value, 'documents')) db.prepare('INSERT INTO documents VALUES(?)').run(row.value.id)
          for (const row of rows(value, 'synced_groups')) db.prepare('INSERT INTO synced_groups VALUES(?)').run(row.value.id)
          for (const name of ['blocks', 'synced_group_blocks']) for (const row of rows(value, name))
            db.prepare('INSERT INTO ' + name + ' VALUES(?,?,?)').run(row.value.id, row.value[name === 'blocks' ? 'document_id' : 'group_id'], row.value.created_at)
          for (const row of candidate.materialization.ledgerOverlay)
            db.prepare('INSERT INTO block_identities VALUES(?,?,?,?,?)').run(row.id, row.last_owner_kind, row.last_owner_id, row.state, row.created_at)
        })()
        for (const wire of candidate.activeGroupWires) assertSyncedStoredBindings(db, wire.origin, wire.blocks, wire.bindings)
        const wire = candidate.activeGroupWires.find(wire => wire.id === slot('group', n.groupId).targetId)!
        const target = wire.bindings.find(binding => binding.target.kind === 'block')!.target
        assert.equal(target.kind, 'block'); if (target.kind !== 'block') return
        db.exec('SAVEPOINT missing')
        db.prepare('DELETE FROM block_identities WHERE id=?').run(target.id)
        assert.throws(() => assertSyncedStoredBindings(db, wire.origin, wire.blocks, wire.bindings), /保留身份/)
        db.exec('ROLLBACK TO missing; RELEASE missing; SAVEPOINT wrong')
        db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(target.id, n.hostId, '2026-01-01T00:00:00.000Z')
        assert.throws(() => assertSyncedStoredBindings(db, wire.origin, wire.blocks, wire.bindings), /身份与实际归属/)
        db.exec('ROLLBACK TO wrong; RELEASE wrong')
      } finally { db.close() }
    })
    await t.test('an unresolved canonical definition cannot activate a source ordinary consumer through a new current path occupant', () => {
      mark('case-consumer')
      const use = rows(value, 'blocks').find(row => row.value.id === slot('block', n.useId).targetId)!
      assert.equal(use.value.content, n.use)
      assert.ok(candidate.conflicts.some(item => item.code === 'canonical3-unproved-definition-target-became-live' && item.rowKeys.includes(use.row.key)))
      const note = rows(value, 'blocks').find(row => row.value.id === slot('block', n.noteUseId).targetId)!
      assert.equal(note.value.content, n.noteUse)
      assert.ok(candidate.conflicts.some(item => item.code === 'canonical3-unproved-definition-target-became-live' && item.rowKeys.includes(note.row.key)))
      const missing = rows(value, 'blocks').find(row => row.value.id === slot('block', n.missingUseId).targetId)!
      assert.equal(missing.value.content, n.missingUse)
      assert.equal(candidate.conflicts.some(item => item.rowKeys.includes(missing.row.key)), false,
        'A still-unresolved canonical definition is not a conflict merely because it is consumed outside the group')
      assert.equal(candidate.rendererBindingPropagationImplemented, false)
      assert.equal(candidate.materialization.actualStageLedgerWritten, false)
      assert.equal(candidate.materialization.actualLifecycleRowsReady, false)
      assert.equal(candidate.referenceRewriteComplete, false); assert.equal(candidate.permit, false)
      assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })
    await t.test('the separate reference owner preserves the old identity manifest and freezes its closed choices', async () => {
      mark('case-owner')
      assert.deepEqual(await readRootRestoreReferencePlan3(prepared.plan), value)
      assert.deepEqual(await readRootRestoreIdentityPlan3(base.plan), base.value)
      assert.deepEqual(await readFile(join(base.directory, 'manifest.json')), baseBytes)
      assert.equal(allocation.choices.originPolicy, 'isolate-incoming')
      assert.equal(allocation.choices.anonymousValues, 'source')
      await assert.rejects(prepareRootRestoreReferencePlan3({ ...base.plan }))
      await assert.rejects(readRootRestoreReferencePlan3({ ...prepared.plan }))
      let reads = 0
      await assert.rejects(prepareRootRestoreReferencePlan3(base.plan, { get originPolicy() { reads++; return 'isolate-incoming' }, anonymousValues: 'source' } as never))
      assert.equal(reads, 0)
      await assert.rejects(prepareRootRestoreReferencePlan3(base.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source', rows: [] } as never))
    })
    await t.test('either kernel or freshly re-read verification SQL can invalidate an already prepared reference owner', async () => {
      mark('case-hot-originals')
      for (const directory of [base.directory, prepared.directory]) {
        const path = join(directory, 'manifest.json'), original = await readFile(path)
        try { await writeFile(path, Buffer.concat([original, Buffer.from(' ')])); await assert.rejects(readRootRestoreReferencePlan3(prepared.plan)) }
        finally { await writeFile(path, original) }
      }
      assert.deepEqual(await readRootRestoreReferencePlan3(prepared.plan), value)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreReferencePlan3(prepared.plan))
      assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })
    mark('cases-complete')
  }, phase => mark('fixture:' + phase)))
