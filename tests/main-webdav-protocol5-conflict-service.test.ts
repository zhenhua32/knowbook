import assert from 'node:assert/strict'
import test from 'node:test'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { KnowbookStore } from '../src/main/database/store'
import { decodeProtocol5Route, protocol5RouteKey, runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { WebDavSyncService } from '../src/main/sync/service'
import { resolveSyncedExchangeConflicts } from '../src/main/sync/synced-exchange'
import { hostEdit, readStrictHostDocument } from './helpers/synced-exchange-fixture'
import { randomUUID, runtime, seedLocalDocument, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('WebDAV settings authenticate field choices and resume the exact keep-both job after a lost reply', () => withIncomingFixture(async fixture => {
  const { A, B, targetConfig, server } = fixture
  const mergeDocument = randomUUID(), forkDocument = randomUUID()
  const target = { ...targetConfig, enabled: false }
  seedLocalDocument(A.db, mergeDocument)
  seedLocalDocument(A.db, forkDocument)
  A.db.close()
  B.db.close()
  const sender = KnowbookStore.openCanonicalRuntime(A.file), receiver = KnowbookStore.openCanonicalRuntime(B.file)
  let workspaceChanges = 0
  const service = new WebDavSyncService(receiver, B.root, createEphemeralCredentialStorage(randomUUID), () => workspaceChanges++)
  const local = receiver.getUnsafeDatabaseHandle()
  try {
    await runProtocol5WebDav(sender, A.root, targetConfig, runtime)
    service.saveConfig({ ...target, password: runtime.password })
    await service.sync()
    hostEdit(local, mergeDocument, 'Local text for merge')
    hostEdit(local, forkDocument, 'Local text for copy')
    hostEdit(sender.getUnsafeDatabaseHandle(), mergeDocument, 'Remote text for merge')
    hostEdit(sender.getUnsafeDatabaseHandle(), forkDocument, 'Remote text for original')
    await runProtocol5WebDav(sender, A.root, targetConfig, runtime)
    const beforeExchange = (await service.previewProtocol5Conflicts()).protocol5Preview!
    assert.equal(beforeExchange.components.length, 2)
    assert.ok(beforeExchange.components.every(component => component.choices.includes('both')))
    await service.sync()

    const preview = (await service.previewProtocol5Conflicts()).protocol5Preview!
    const merge = preview.components.find(component => component.records.some(record => record.key === 'doc:' + mergeDocument))!
    assert.ok(merge.choices.includes('merge'))
    const records = merge.records.filter(record => record.unresolvedPartIds.length).map(record => ({ key: record.key,
      parts: [...record.unresolvedPartIds].sort().map(id => ({ id, value: { choice: 'custom' as const, text: 'Reviewed merged body' } })) }))
    assert.equal(records.length, 1)
    assert.equal(records[0].parts.length, 1)
    const selection = { previewId: preview.previewId, previewHash: preview.previewHash, componentId: merge.componentId,
      choice: 'merge' as const, records }
    await assert.rejects(resolveSyncedExchangeConflicts(local, { operationId: randomUUID(), userDataRoot: B.root, target,
      previewId: preview.previewId, expectedPreviewHash: '0'.repeat(64), decisions: [{ componentId: merge.componentId, choice: 'merge', records }] },
    runtime), /预览已变化/)
    assert.equal(readStrictHostDocument(local, mergeDocument).content.blocks[0].content, 'Local text for merge')
    const manifestPath = '/' + targetConfig.directory + '/manifest.json', selectedKey = 'doc:' + mergeDocument
    const oldRemote = JSON.parse(server.files.get(manifestPath)!.toString()).entries[selectedKey]
    hostEdit(local, mergeDocument, 'Newer local work after the preview')
    const independentId = receiver.createDocument(null)
    hostEdit(sender.getUnsafeDatabaseHandle(), fixture.other, 'Independent incoming change after preview')
    await runProtocol5WebDav(sender, A.root, targetConfig, runtime)
    const notifications = workspaceChanges
    await assert.rejects(service.resolveProtocol5Conflict(selection), /同步版本已变化/)
    assert.equal(readStrictHostDocument(local, mergeDocument).content.blocks[0].content, 'Newer local work after the preview')
    assert.equal(readStrictHostDocument(local, fixture.other).content.blocks[0].content, 'Independent incoming change after preview')
    assert.equal(workspaceChanges, notifications + 1)
    assert.ok(service.getStatus().uploaded > 0)
    assert.ok(service.getStatus().downloaded > 0)
    assert.equal(service.getStatus().protocol5Preview?.previewId, preview.previewId)
    const remote = JSON.parse(server.files.get(manifestPath)!.toString())
    assert.equal(remote.entries[selectedKey], oldRemote)
    assert.ok(remote.entries['doc:' + independentId], 'The unrelated local update still settles')
    const route = decodeProtocol5Route(receiver.getSettingPublic(protocol5RouteKey(target)), target)
    assert.equal(route?.pending, null)
    assert.equal(route?.lastSyncAt, service.getStatus().lastSyncAt)

    const refreshed = (await service.previewProtocol5Conflicts()).protocol5Preview!
    const refreshedMerge = refreshed.components.find(component => component.records.some(record => record.key === selectedKey))!
    assert.ok(refreshedMerge.records.flatMap(record => record.parts).some(part => part.localPreview === 'Newer local work after the preview'))
    await service.resolveProtocol5Conflict({ ...selection, previewId: refreshed.previewId, previewHash: refreshed.previewHash,
      componentId: refreshedMerge.componentId })
    assert.equal(readStrictHostDocument(local, mergeDocument).content.blocks[0].content, 'Reviewed merged body')

    const current = (await service.previewProtocol5Conflicts()).protocol5Preview!
    const fork = current.components.find(component => component.records.some(record => record.key === 'doc:' + forkDocument))!
    assert.ok(fork.choices.includes('both'))
    assert.equal(fork.copies?.documentPaths.length, 1)
    let lost = false
    server.setHook(request => {
      if (request.method === 'PUT' && request.path === manifestPath) {
        lost = true
        return { kind: 'persist-then-disconnect' }
      }
      if (lost && request.method === 'GET' && request.path === manifestPath) return { kind: 'status', status: 403 }
    })
    const keepBoth = { previewId: current.previewId, previewHash: current.previewHash, componentId: fork.componentId, choice: 'both' }
    await assert.rejects(service.resolveProtocol5Conflict(keepBoth))
    server.setHook(undefined)
    assert.equal(service.getStatus().protocol5Preview?.previewId, current.previewId)
    assert.ok(lost)
    const savedPath = fork.copies!.documentPaths[0]
    await service.sync()
    const copyId = local.prepare('SELECT id FROM documents WHERE path=?').pluck().get(savedPath) as string | undefined
    assert.ok(copyId)
    assert.notEqual(copyId, forkDocument)
    assert.equal(readStrictHostDocument(local, copyId).content.blocks[0].content, 'Local text for copy')
    assert.equal(readStrictHostDocument(local, forkDocument).content.blocks[0].content, 'Remote text for original')
  } finally {
    await service.stop()
    receiver.destroy()
    sender.destroy()
  }
}))
