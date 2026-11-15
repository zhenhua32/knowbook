import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { applyPreparedJointRestore4, jointRestorePaths4, prepareJointRestoreIntent4, readJointRestoreCurrent4,
  recoverJointRestore4Owned } from '../../src/main/database/restore-joint-journal4.ts'
import { copyRestoreInventory, readRestoreJson } from '../../src/main/database/restore-safety-files.ts'

const [root, operationId, mode] = process.argv.slice(2)
const p = jointRestorePaths4(root, operationId), input = await readRestoreJson(join(p.recovery, 'physical-test-input.json'))
const fs = createRequire(import.meta.url)('node:fs/promises')
const realLink = fs.link, realRename = fs.rename, realUnlink = fs.unlink

const checks = {
  async assertPrepared(intent) {
    assert.equal(intent.installationProofHash, input.installationProofHash)
  },
  async assertInstalled(intent, phase) {
    assert.equal(intent.installationProofHash, input.installationProofHash)
    const probe = join(p.recovery, 'sqlite-install-oracle-' + Date.now() + '-' + process.pid + '-' + phase)
    await copyRestoreInventory(p.storage, probe, intent.candidateInventory, root)
    const db = new Database(join(probe, 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
      assert.equal(db.prepare('SELECT title FROM documents WHERE id=?').pluck().get(input.expectedDocumentId), input.expectedTitle)
    } finally { db.close() }
  }
}

if (mode === 'prepared') {
  fs.rename = (from, to) => to === p.journal ? process.exit(71) : realRename(from, to)
}
if (mode === 'old-moved' || mode === 'candidate-moved' || mode === 'rollback-mid') {
  fs.rename = async (from, to) => {
    await realRename(from, to)
    if (mode === 'old-moved' && from === p.database && to === join(p.original, 'knowbook.db')) process.exit(72)
    if (mode === 'candidate-moved' && from === p.stage && to === p.database) process.exit(74)
    if (mode === 'rollback-mid' && from === join(p.original, 'knowbook.db') && to === p.database) process.exit(76)
  }
}
if (mode === 'asset-linked') {
  fs.link = async (from, to) => { await realLink(from, to); process.exit(73) }
}
if (mode === 'committed' || mode === 'commit-error') {
  let injected = false
  fs.rename = async (from, to) => {
    const committing = to === p.journal && JSON.parse(await fs.readFile(from, 'utf8')).phase === 'installed'
    await realRename(from, to)
    if (committing && !injected) {
      injected = true
      if (mode === 'committed') process.exit(75)
      throw new Error('simulated error after atomic installed journal rename')
    }
  }
}
if (mode === 'terminal') {
  fs.unlink = path => path === p.journal ? process.exit(77) : realUnlink(path)
}
syncBuiltinESMExports()

const recover = ['recover', 'rollback-mid', 'terminal'].includes(mode)
const result = recover ? await recoverJointRestore4Owned(root, checks) : await applyPreparedJointRestore4(root,
  await prepareJointRestoreIntent4({ profileRoot: root, operationId, current: await readJointRestoreCurrent4(root),
    parentFenceHash: null, installationProofHash: input.installationProofHash, assetTransferId: input.assetTransferId,
    assetManifestHash: input.assetManifestHash }), checks)
process.stdout.write(JSON.stringify(result))
