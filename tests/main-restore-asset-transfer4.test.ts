import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { publishRestoreAssetTransfer4, prepareRestoreAssetTransfer4, reopenRestoreAssetTransfer4,
  rollbackRestoreAssetTransfer4 } from '../src/main/database/restore-asset-transfer4'
import { restoreExists } from '../src/main/database/restore-safety-files'

const run = promisify(execFile)
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

test('real asset transfer recovers a process interrupted after one exclusive link, then rolls back only its own aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowbook-restore-transfer-')), root = await realpath(directory)
  const operation = randomUUID(), sourceRoot = join(root, 'backups', 'database-restore', operation, 'verified-aliases')
  try {
    await mkdir(sourceRoot, { recursive: true })
    const old = Buffer.from('original file'), small = Buffer.from('new attachment')
    const zeros = Buffer.alloc(1024 * 1024), digest = createHash('sha256')
    for (let index = 0; index < 50; index++) digest.update(zeros)
    const entries = [{ logicalName: 'old.bin', hash: sha256(old), bytes: old.length },
      { logicalName: 'small.bin', hash: sha256(small), bytes: small.length },
      { logicalName: 'large.bin', hash: digest.digest('hex'), bytes: 50 * zeros.length }]
      .map(file => ({ ...file, sourceRoot, sourcePath: join(sourceRoot, file.logicalName) }))
    await writeFile(entries[0].sourcePath, old, { flag: 'wx' })
    await writeFile(entries[1].sourcePath, small, { flag: 'wx' })
    await writeFile(entries[2].sourcePath, '', { flag: 'wx' })
    await truncate(entries[2].sourcePath, entries[2].bytes)
    const targets = entries.map(file => join(root, 'storage', 'assets', 'attachments', file.hash.slice(0, 2), file.hash, file.logicalName))
    await mkdir(dirname(targets[0]), { recursive: true })
    await writeFile(targets[0], old, { flag: 'wx' })
    const original = await lstat(targets[0], { bigint: true })
    const prepared = await prepareRestoreAssetTransfer4(root, operation, entries)
    const reopened = () => reopenRestoreAssetTransfer4(root, operation, prepared.transferId, prepared.manifestHash)
    assert.deepEqual(await Promise.all(targets.map(restoreExists)), [true, false, false])
    const child = fileURLToPath(new URL('./helpers/restore-asset-transfer-crash.mjs', import.meta.url))
    await assert.rejects(run(process.execPath, ['--import', 'tsx', child, root, operation, prepared.transferId, prepared.manifestHash],
      { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }), { code: 77 })
    assert.equal((await Promise.all(targets.slice(1).map(restoreExists))).filter(Boolean).length, 1)
    await assert.rejects(reopenRestoreAssetTransfer4(root, operation, prepared.transferId, '0'.repeat(64)), /凭据/)
    await publishRestoreAssetTransfer4((await reopened()).transfer)
    assert.equal((await lstat(targets[2])).size, entries[2].bytes)
    assert.deepEqual(await readFile(targets[1]), small)
    assert.equal((await lstat(targets[0], { bigint: true })).ino, original.ino)

    await rollbackRestoreAssetTransfer4((await reopened()).transfer)
    await rollbackRestoreAssetTransfer4((await reopened()).transfer)
    assert.deepEqual(await Promise.all(targets.map(restoreExists)), [true, false, false])
    assert.deepEqual(await readFile(targets[0]), old)
    assert.equal((await lstat(targets[0], { bigint: true })).ino, original.ino)

    await writeFile(targets[1], small, { flag: 'wx' })
    await assert.rejects(reopened(), /链接数|占用/)
    assert.deepEqual(await readFile(targets[1]), small, 'identical bytes from a different inode cannot be removed as a restore alias')
    assert.equal(await restoreExists(targets[2]), false)
    for (const entry of entries) assert.equal((await lstat(entry.sourcePath, { bigint: true })).nlink, 1n)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('knowbook-restore-transfer-'))
    await rm(directory, { recursive: true, force: true })
  }
})
