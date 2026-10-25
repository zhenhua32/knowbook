import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { KnowbookStore } from '../../src/main/database/store'
import { applySyncedHostCommand } from '../../src/main/database/synced-host-final'
import { certifyDurableSqlCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-read'
import { prepareCapsule2AssetArchive } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureActualFirstRequiredSqlDag, readActualFirstRequiredSqlDagMaterial } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle, capturePreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { createRequest, created, allTables } from './synced-host-command-create-fixture'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import type { SourceProfile } from './qualified-originals-fixture'

async function profile(root: string) {
  const userDataRoot = join(root, 'profile')
  await mkdir(join(userDataRoot, 'storage', 'assets'), { recursive: true })
  const store = new KnowbookStore(join(userDataRoot, 'storage', 'knowbook.db'))
  try {
    const documentId = store.createDocument(null), blockId = randomUUID()
    store.updateDocument(documentId, { title: 'Actual original domain', summary: '', blocks: [
      { id: blockId, type: 'paragraph', content: 'Original complete Main group', checked: false, depth: 0, parentBlockId: null }
    ] })
    const db = store.getUnsafeDatabaseHandle()
    const ack = created(applySyncedHostCommand(db, createRequest(db, { documentId, selectedRootIds: [blockId] })))
    assert.equal(ack.createdLifecycle.state, 'active')
    assert.equal((db.prepare('SELECT count(*) AS n FROM synced_groups').get() as { n: number }).n, 1)
    return { userDataRoot, store, db }
  } catch (error) { store.destroy(); throw error }
}
export async function captureQualifiedNoPriorSource(f: SourceProfile, reader: 1 | 2) {
  const original = await captureAssetOriginal(f)
  if (reader === 1) return { original, handle: await certifyDurableSqlCapsuleOriginal(original.original) }
  const archive = await prepareCapsule2AssetArchive(original.original), sealed = await captureSealedCapsule2SourceFromArchive(archive)
  const result = await certifyCapsule2Source(sealed.source)
  assert.equal(result.status, 'certified-without-prior-coverage')
  return { original, handle: result.source }
}
export async function withQualifiedNestedFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowbook-qualified-originals-')))
  let source: Awaited<ReturnType<typeof profile>> | undefined, receiver: Awaited<ReturnType<typeof profile>> | undefined
  try {
    source = await profile(join(root, 'source')); receiver = await profile(join(root, 'receiver'))
    await run(await setup(source, receiver))
  } finally {
    source?.store.destroy(); receiver?.store.destroy()
    assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('knowbook-qualified-originals-'))
    await rm(root, { recursive: true, force: true })
  }
}
async function setup(source: Awaited<ReturnType<typeof profile>>, receiver: Awaited<ReturnType<typeof profile>>) {
  const left = await captureQualifiedNoPriorSource(source, 1), right = await captureQualifiedNoPriorSource(source, 1)
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: left.original.info.profileRoot, operationId: basename(left.original.info.recoveryDirectory),
    dagId: randomUUID(), source: left.handle, current: right.handle })
  const captured = { handle: dag, material: await readActualFirstRequiredSqlDagMaterial(dag) }
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const saved = await capturePreparedMixedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
  return { source, receiver, captured, exported, handle: saved.bundle, value: saved.value,
    beforeSource: allTables(source.db), beforeReceiver: allTables(receiver.db) }
}
