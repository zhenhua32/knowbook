import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AttachmentStore } from '../../src/main/attachments'
import { KnowbookStore } from '../../src/main/database/store'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { prepareRootRestoreIdentityPlan3 } from '../../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../../src/main/database/restore-knowledge-reference3-read'
import { captureRootKnowledgeConservationPlanFromCertifiedSources3 } from '../../src/main/database/restore-knowledge-root3-read'
import { buildSyncedPortableAssetUri } from '../../src/shared/syncedBlockPortable'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock } from './synced-backup-v3-fixture'

async function certify(store: KnowbookStore, profileRoot: string) {
  const original = await captureAssetOriginal({ db: store.getUnsafeDatabaseHandle(), userDataRoot: profileRoot })
  const sealed = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
  const certificate = await certifyCapsule2Source(sealed.source)
  assert.equal(certificate.status, 'certified-without-prior-coverage')
  return { operationId: basename(original.info.recoveryDirectory), source: certificate.source }
}

function createHost(store: KnowbookStore, title: string, canonical: string, summary: string) {
  const id = store.createDocument(null), block = freshBlock(randomUUID(), canonical)
  store.updateDocument(id, { title, summary, blocks: [block] })
  const db = store.getUnsafeDatabaseHandle()
  created(applySyncedHostCommand(db, createRequest(db, { documentId: id, selectedRootIds: [block.id] })))
  return id
}

async function prepare(profileRoot: string, current: KnowbookStore, incoming: KnowbookStore, emptyHistory: boolean) {
  const assets = new AttachmentStore(join(profileRoot, 'storage', 'assets'))
  const name = 'coverage.png', bytes = Buffer.from('actual Root3 coverage attachment')
  const [local] = await assets.import([{ name, bytes }])
  const portable = buildSyncedPortableAssetUri({ hash: createHash('sha256').update(bytes).digest('hex'), name })
  const incomingHost = createHost(incoming, 'Incoming coverage host', '![canonical](<' + portable + '>)', '![summary](<' + local.url + '>)')
  if (emptyHistory) {
    const id = current.createDocument(null)
    current.updateDocument(id, { title: 'Ordinary current document', summary: 'Original ordinary summary',
      blocks: [freshBlock(randomUUID(), 'Original ordinary text')] })
  } else {
    createHost(current, 'Current retained host', 'Original current canonical text', 'Original current summary')
  }
  const [left, right] = await Promise.all([certify(incoming, profileRoot), certify(current, profileRoot)])
  const root = await captureRootKnowledgeConservationPlanFromCertifiedSources3({ profileRoot, operationId: left.operationId, dagId: randomUUID(),
    source: left.source, current: right.source })
  const identity = await prepareRootRestoreIdentityPlan3(root.knowledgePlan)
  const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
  assert.equal(reference.value.candidate.candidateConflictFree, true)
  return { root, identity, reference, incomingHost }
}

export async function withNativeCoverageFixture(emptyHistory: boolean, run: (value: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'knowbook-native-c-'))
  let current: KnowbookStore | undefined, incoming: KnowbookStore | undefined
  try {
    await mkdir(join(temporary, 'incoming'))
    current = KnowbookStore.createEmptySyncedReceiver(join(temporary, 'storage', 'knowbook.db'))
    incoming = KnowbookStore.createEmptySyncedReceiver(join(temporary, 'incoming', 'storage', 'knowbook.db'))
    const fixture = await prepare(temporary, current, incoming, emptyHistory)
    const originalCurrent = allTables(current.getUnsafeDatabaseHandle()), originalIncoming = allTables(incoming.getUnsafeDatabaseHandle())
    await run(fixture)
    assert.deepEqual(allTables(current.getUnsafeDatabaseHandle()), originalCurrent)
    assert.deepEqual(allTables(incoming.getUnsafeDatabaseHandle()), originalIncoming)
  } finally {
    incoming?.destroy()
    current?.destroy()
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    assert.ok(basename(temporary).startsWith('knowbook-native-c-'))
    await rm(temporary, { recursive: true, force: true })
  }
}
