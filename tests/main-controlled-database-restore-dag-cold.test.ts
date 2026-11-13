import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { readCertifiedDurableSqlDag, reopenCertifiedDurableSqlDag } from '../src/main/database/restore-knowledge-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { capture, child, immutableBytes, input, setupPair } from './helpers/controlled-restore-dag-fixture'

test('a new process reopens the full DAG after all old SQLite scratch and sealed-input copies are removed', () => withV3Fixture(async f => {
  const pair = await setupPair(f), diagnostic = await readCertifiedDurableSqlDag(await capture(pair))
  const initialReopen = await readCertifiedDurableSqlDag(await reopenCertifiedDurableSqlDag(input(pair, diagnostic.root)))
  assert.deepEqual(initialReopen, diagnostic)
  assert.equal((await readdir(join(pair.recoveryDirectory, 'knowledge-capsule-reads'))).length, 2,
    'A genuine parent-process reopen first creates the old disposable SQL scratch directories')
  for (const saved of [pair.source, pair.current]) {
    assert.equal(saved.info.scratchDirectory, join(saved.info.capsuleDirectory, 'scratch'))
    assert.equal(await realpath(saved.info.scratchDirectory), saved.info.scratchDirectory)
    await rm(saved.info.scratchDirectory, { recursive: true })
    assert.equal(dirname(saved.info.sealedDirectory), pair.recoveryDirectory)
    await rm(saved.info.sealedDirectory, { recursive: true })
  }
  const reads = join(pair.recoveryDirectory, 'knowledge-capsule-reads')
  assert.equal(await realpath(reads), reads)
  assert.equal(dirname(resolve(reads)), resolve(pair.recoveryDirectory))
  await rm(reads, { recursive: true })
  const before = await immutableBytes(pair), reopened = await child(pair, diagnostic.root)
  assert.notEqual(reopened.pid, process.pid)
  assert.deepEqual(reopened.diagnostic, diagnostic)
  assert.equal((await readdir(reads)).length, 2, 'The child created one fresh SQL scratch per genuine unique original')
  assert.deepEqual(await immutableBytes(pair), before, 'Only new disposable work directories were created; immutable originals/roots/index remain exact')
}))
