import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, assertOriginals } from './helpers/controlled-restore-fixture'
import { faultChild } from './helpers/controlled-restore-fault-fixture'

async function actualStageAbort(mode: string, marker: string) {
  await withControlledRestore(async f => {
    const before = f.sealCurrent(), outcome = await faultChild(f.profile, f.backup, mode, join(f.root, mode + '.json'))
    assert.equal(outcome.code, 0); assert.equal(outcome.evidence.injected, true); assert.equal(outcome.evidence.caught, true)
    const witness = outcome.evidence.witness as { stage: string; before: unknown; inTransaction: boolean }
    assert.equal(witness.inTransaction, true, 'The TEMP trigger is installed inside the actual owned stage transaction')
    assert.equal(JSON.stringify(outcome.evidence.error).includes(marker), true, 'The real SQLite failure comes from the exact native fixture trigger')
    assert.equal(JSON.stringify(outcome.evidence.error).includes('SQLITE_CONSTRAINT_TRIGGER'), true)
    assert.deepEqual(outcome.evidence.after, witness.before, 'The actual owned transaction rolled back its epoch document CAS and receipt writes together')
    assertOriginals(f.database, before)
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
    assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
    assert.equal(existsSync(join(f.profile, 'database-restore-fence.json')), false)
    assert.equal(existsSync(join(witness.stage, '..', 'intent.json')), false)
  })
}

test('controlled restore never moves originals when the real owned stage epoch UPDATE is aborted by a native connection local trigger', () => actualStageAbort('stage-epoch', 'controlled-stage-epoch-abort'))

test('controlled restore rolls back epoch and document boundary when its real receipt INSERT is aborted by a native connection local trigger', () => actualStageAbort('stage-receipt', 'controlled-stage-receipt-abort'))
