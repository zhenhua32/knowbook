import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { prepareRestoreAssetTransfer4, publishRestoreAssetTransfer4, tryReadInstalledRestoreAsset4 } from '../src/main/database/restore-asset-transfer4'
import { assertInstalledV3ManyFiles, installedV3TransferFiles, validateInstalledV3Many,
  writeInstalledV3ManyFiles } from '../src/main/database/restore-knowledge-installed-v3-many'
import type { CoverageRootReference } from '../src/main/database/restore-knowledge-coverage-model'

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

test('mixed V3 continuity seals two real published large transfer facts and cold rereads only their exact copies', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'knowbook-restore-v3-many-'))
  const profile = await realpath(temporary), output = join(profile, 'archive')
  try {
    const operations = [randomUUID(), randomUUID()]
    const items = []
    for (const [index, operationId] of operations.entries()) {
      const sourceRoot = join(profile, 'backups', 'database-restore', operationId, 'verified-aliases')
      await mkdir(sourceRoot, { recursive: true })
      const name = `large-${index}.bin`, bytes = 50 * 1024 * 1024
      const sourcePath = join(sourceRoot, name), first = Buffer.from([index + 1]), zeros = Buffer.alloc(1024 * 1024)
      await writeFile(sourcePath, first, { flag: 'wx' })
      await truncate(sourcePath, bytes)
      const digest = createHash('sha256').update(first).update(zeros.subarray(1))
      for (let chunk = 1; chunk < 50; chunk++) digest.update(zeros)
      const hash = digest.digest('hex'), file = { hash, logicalName: name, bytes }
      const prepared = await prepareRestoreAssetTransfer4(profile, operationId, [{ ...file, sourcePath, sourceRoot }])
      await publishRestoreAssetTransfer4(prepared.transfer)
      const transfer = { operationId, transferId: prepared.transferId, manifestHash: prepared.manifestHash }
      const identity = await tryReadInstalledRestoreAsset4(profile, operationId, transfer.transferId, transfer.manifestHash, file)
      assert.ok(identity)
      const alias = { relativePath: `attachments/${hash.slice(0, 2)}/${hash}/${name}`, hash, name, bytes }
      items.push({ alias, backupV3: { snapshotId: randomUUID(), inventoryHash: hash, archiveHash: hash },
        role: index === 0 ? 'current' as const : 'source' as const, transfer, identity })
    }
    items.sort((left, right) => order(left.alias.relativePath, right.alias.relativePath))
    const tree = { rootPresent: true, directories: [], aliases: items.map(item => item.alias),
      files: items.map(({ alias: { hash, bytes } }) => ({ hash, bytes })) }
    const root: CoverageRootReference = { kind: 'restore-knowledge-origin-root-ref', version: 1, namespace: { kind: 'native' },
      operationId: operations[1], dagId: randomUUID(), rootHash: '1'.repeat(64), readerVersion: 'knowbook-required-sql-knowledge-dag-v2' }
    await mkdir(output)
    const proof = await writeInstalledV3ManyFiles(profile, output,
      { root, qualifiedDescriptorHash: '2'.repeat(64), installationProofHash: '3'.repeat(64) }, items, tree)
    assert.throws(() => validateInstalledV3Many({ ...proof,
      aliases: proof.aliases.map(entry => ({ ...entry, backupV3: proof.aliases[0].backupV3 })) }, tree), /两份 V3/)
    assert.throws(() => validateInstalledV3Many({ ...proof,
      aliases: proof.aliases.map(entry => ({ ...entry, role: 'source' })) }, tree), /本次安装 transfer/)
    const copies = installedV3TransferFiles(proof, output)
    assert.equal(copies.length, 2)
    for (const file of copies) assert.equal(sha256(await readFile(file.path)), file.sha256)
    await assertInstalledV3ManyFiles(validateInstalledV3Many(JSON.parse(JSON.stringify(proof)), tree), output, profile)
    const replacedIdentity = validateInstalledV3Many({ ...proof,
      aliases: proof.aliases.map(entry => ({ ...entry, identity: { ...entry.identity, ino: entry.identity.ino === '1' ? '2' : '1' } })) }, tree)
    await assert.rejects(assertInstalledV3ManyFiles(replacedIdentity, output, profile), /fd 事实/)
    await writeFile(copies[0].path, Buffer.alloc(copies[0].bytes))
    await assert.rejects(assertInstalledV3ManyFiles(proof, output, profile), /hash/)
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    assert.ok(basename(temporary).startsWith('knowbook-restore-v3-many-'))
    await rm(temporary, { recursive: true, force: true })
  }
})
