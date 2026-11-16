import assert from 'node:assert/strict'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { readJointRestoreFence4 } from '../src/main/database/restore-joint-journal4'
import { assertRestoreInventory, readRestoreJson, restoreExists } from '../src/main/database/restore-safety-files'
import { assertOriginals, withControlledRestore } from './helpers/controlled-restore-fixture'
import { child, observed, prepare } from './helpers/restore-joint-physical4-fixture'

for (const [mode, expectedJournal, repairedStatus] of [
  ['tail-before-commit', 'moving', 'rolled-back'],
  ['tail-before-finish', 'installed', 'installed']
] as const) {
  test(`joint ${mode} rejects a late mutation of the verified live SQLite file`, () => withControlledRestore(async f => {
    const { root, operationId, p, candidate, old, oldAsset, incoming, bytes } = await prepare(f, true, false)
    const originalCandidate = await readFile(p.stage)
    const candidateInode = (await lstat(p.stage, { bigint: true })).ino
    if (expectedJournal === 'installed') await assert.rejects(child(root, operationId, 'committed'), { code: 75 })

    const outcome = await observed(child(root, operationId, mode)).then(
      value => ({ value }), error => ({ error: String(error) })
    )
    const changedCandidate = Buffer.from(originalCandidate)
    changedCandidate[0] ^= 1
    assert.deepEqual(await readFile(p.database), changedCandidate)
    assert.equal((await lstat(p.database, { bigint: true })).ino, candidateInode)
    if ('value' in outcome) assert.fail(`Late SQLite mutation was accepted as ${outcome.value.status}`)
    assert.match(outcome.error, /已移动 SQL 原件在最终提交前变化/)
    assert.equal((await readRestoreJson(p.journal) as { phase: string }).phase, expectedJournal)
    assert.equal((await readJointRestoreFence4(p.fence)).fence.phase, 'prepared')
    assert.equal(await restoreExists(p.result), false)
    assert.equal(await restoreExists(p.safeMarker), false)
    assert.deepEqual(await readFile(oldAsset), bytes)
    assert.deepEqual(await readFile(incoming), bytes)

    await writeFile(p.database, originalCandidate)
    assert.equal((await observed(child(root, operationId, 'recover'))).status, repairedStatus)
    assert.equal(await restoreExists(p.journal), false)
    if (repairedStatus === 'installed') {
      await assertRestoreInventory(p.storage, candidate)
      assert.deepEqual(await readFile(incoming), bytes)
      assert.equal(await restoreExists(p.safeMarker), true)
    } else {
      assertOriginals(p.database, old!)
      assert.equal(await restoreExists(incoming), false)
      assert.equal(await restoreExists(p.safeMarker), false)
    }
    assert.deepEqual(await readFile(oldAsset), bytes)
  }))
}
