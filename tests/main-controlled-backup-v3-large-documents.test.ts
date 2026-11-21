import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { canonicalRestoreRoot } from '../src/main/database/restore-safety-files'
import { KnowbookStore } from '../src/main/database/store'
import { freshBlock, randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'

function blockDigest(blocks: Iterable<{ id?: string; content: string }>) {
  const digest = createHash('sha256')
  for (const block of blocks) digest.update(JSON.stringify([block.id, block.content]))
  return digest.digest('hex')
}

test('V3 installs multiple large documents and reads their content and cross-document links after a cold reopen', () => withV3Fixture(async f => {
  const docs = Array.from({ length: 6 }, (_, index) => ({
    id: f.store.createDocument(null), title: 'V3 Large Body ' + (index + 1)
  }))
  const expected = docs.map(({ id, title }, index) => {
    const next = docs[(index + 1) % docs.length]
    const blocks = [freshBlock(randomUUID(), '[[' + next.title + ']]'),
      ...Array.from({ length: 16 }, (_, blockIndex) => ({
        ...freshBlock(randomUUID(), `${title} / ${blockIndex}\n` + '源 🙂 abcdef '.repeat(3_072)), type: 'code'
      }))]
    f.store.updateDocument(id, { title, summary: '', blocks })
    return { id, title, linkedDocumentId: next.id, hash: blockDigest(blocks) }
  })
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const receiver = join(f.root, 'large-document-receiver')
  await mkdir(receiver)
  const userDataRoot = await canonicalRestoreRoot(receiver), file = join(userDataRoot, 'storage', 'knowbook.db')
  KnowbookStore.createEmptySyncedReceiver(file).destroy()
  const legacy = { readCurrentIdentities: async () => [],
    recoverLegacy: async () => { throw new Error('V3 recovery must use its own installation receipt') } }
  const result = await restoreControlledBackupV3({
    userDataRoot, backupDirectory: f.destination, stopProcesses: async () => []
  }, legacy)
  assert.equal(result.status, 'installed')
  await rename(f.destination, f.destination + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(userDataRoot, legacy.recoverLegacy), true)

  const restored = KnowbookStore.openCanonicalRuntime(file)
  try {
    const linked = restored.getUnsafeDatabaseHandle().prepare('SELECT target_document_id FROM links WHERE source_document_id=?')
    for (const item of expected) {
      const document = restored.getDocumentDetail(item.id)
      assert.equal(document?.title, item.title)
      assert.equal(blockDigest(document!.blocks), item.hash)
      assert.deepEqual(linked.all(item.id), [{ target_document_id: item.linkedDocumentId }])
    }
  } finally { restored.destroy() }
}))
