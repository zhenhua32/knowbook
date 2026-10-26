import assert from 'node:assert/strict'
import { basename } from 'node:path'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { tryReadCertifiedCapsule2SourceInputs } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureMixedSource } from './mixed-required-source-fixture'
import { withV3Fixture, allTables, randomUUID, createRequest, created, applySyncedHostCommand,
  applySyncedHostFinal, request, applied, snapshot, type V3Fixture } from './synced-backup-v3-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
function document(f: V3Fixture, title: string, blocks: DocumentBlockDraft[]) {
  const id = f.store.createDocument(null)
  f.store.updateDocument(id, { title, summary: '', blocks })
  return id
}
function sourceCases(f: V3Fixture) {
  const linkedId = randomUUID(), survivingId = randomUUID()
  const blockUrl = '/V3%20Target.md#^' + f.targetBodyId
  const linked = '😀 [one](' + blockUrl + ')\r\n<a href="' + blockUrl + '">HTML</a> [two](' + blockUrl + ') [empty]()'
  const hostId = document(f, 'Canonical "Reference" Source', [paragraph(survivingId, 'Ordinary survivor'), paragraph(linkedId, linked)])
  const create = createRequest(f.db, { documentId: hostId, selectedRootIds: [linkedId] })
  created(applySyncedHostCommand(f.db, create))
  const insertion = command(f.db, { documentId: hostId, groupId: create.action.groupId })
  insertAck(applySyncedHostCommand(f.db, insertion))
  assert.equal(snapshot(f.db, create.action.groupId).blocks.find(block => block.id === linkedId)!.content, linked)

  const definitionId = randomUUID(), useId = randomUUID(), missingDefinitionId = randomUUID(), missingUseId = randomUUID()
  const definition = '[future]: /Canonical%20Future.md "original unresolved target"', use = '[ordinary consumer][future]'
  const missingDefinition = '[still]: /Canonical%20Still%20Missing.md', missingUse = '[unresolved consumer][still]'
  const definitionOwnerId = document(f, 'Canonical Definition Source', [paragraph(definitionId, definition), paragraph(missingDefinitionId, missingDefinition)])
  const definitionCreate = createRequest(f.db, { documentId: definitionOwnerId, selectedRootIds: [definitionId, missingDefinitionId] })
  created(applySyncedHostCommand(f.db, definitionCreate))
  const fallbackId = randomUUID(), definitionHostId = document(f, 'Canonical Definition Consumer', [paragraph(useId, use), paragraph(missingUseId, missingUse),
    paragraph(fallbackId, '[future]: https://example.invalid/fallback "inactive fallback"')])
  const definitionInsert = command(f.db, { documentId: definitionHostId, groupId: definitionCreate.action.groupId,
    target: { beforeBlockId: useId } })
  insertAck(applySyncedHostCommand(f.db, definitionInsert))
  assert.equal(f.store.getDocumentDetail(definitionHostId)!.blocks[0].id, definitionInsert.action.instanceId)
  const noteUseId = randomUUID(), noteDefinitionId = randomUUID(), noteFallbackId = randomUUID()
  const noteUse = 'Read note[^via]', noteDefinition = '[^via]: [indirect canonical consumer][future]'
  const noteHostId = document(f, 'Canonical Footnote Consumer', [paragraph(noteUseId, noteUse), paragraph(noteDefinitionId, noteDefinition),
    paragraph(noteFallbackId, '[future]: https://example.invalid/note-fallback')])
  const noteInsert = command(f.db, { documentId: noteHostId, groupId: definitionCreate.action.groupId, target: { beforeBlockId: noteUseId } })
  insertAck(applySyncedHostCommand(f.db, noteInsert))
  assert.equal(f.store.getDocumentDetail(noteHostId)!.blocks[0].id, noteInsert.action.instanceId)

  const orphanBodyId = randomUUID(), orphanSurvivorId = randomUUID()
  const orphanHostId = document(f, 'Canonical Orphan Source', [paragraph(orphanSurvivorId, 'Orphan survivor'), paragraph(orphanBodyId, '[target](/V3%20Target.md)')])
  const orphanCreate = createRequest(f.db, { documentId: orphanHostId, selectedRootIds: [orphanBodyId] })
  created(applySyncedHostCommand(f.db, orphanCreate))
  const remove = request(f.db, [orphanHostId], (after, before) => {
    before[0].workingBefore.blocks = before[0].workingBefore.blocks.filter(block => block.id !== orphanCreate.action.instanceId)
    after[0].blocks = structuredClone(before[0].workingBefore.blocks)
  })
  applied(applySyncedHostFinal(f.db, remove))
  assert.equal(snapshot(f.db, orphanCreate.action.groupId).instances.length, 0)

  // The immutable Origin's escaped path spelling is produced by Main itself.
  const stored = f.db.prepare('SELECT origin_json FROM synced_groups WHERE id=?').get(create.action.groupId) as { origin_json: string }
  const originalOriginJson = stored.origin_json
  assert.equal(JSON.parse(originalOriginJson).pathAtCreation, 'Canonical "Reference" Source')
  return { hostId, linkedId, linked, survivingId, blockUrl, groupId: create.action.groupId,
    instanceIds: [create.action.instanceId, insertion.action.instanceId], originalOriginJson,
    definitionId, definition, definitionOwnerId, definitionHostId, definitionGroupId: definitionCreate.action.groupId, useId, use, fallbackId,
    missingDefinitionId, missingDefinition, missingUseId, missingUse, noteUseId, noteDefinitionId, noteUse, noteDefinition, noteHostId,
    orphanHostId, orphanBodyId, orphanGroupId: orphanCreate.action.groupId, orphanInstanceId: orphanCreate.action.instanceId }
}
function currentCases(f: V3Fixture, source: ReturnType<typeof sourceCases>) {
  const futureId = document(f, 'Canonical Future', [paragraph(randomUUID(), 'Current-only path occupant')])
  const externalBodyId = randomUUID(), externalHostId = document(f, 'Canonical Current Only Host', [paragraph(externalBodyId, 'Current host survives')])
  const insert = command(f.db, { documentId: externalHostId, groupId: source.groupId })
  insertAck(applySyncedHostCommand(f.db, insert))
  return { futureId, externalHostId, externalBodyId, externalInstanceId: insert.action.instanceId }
}

/** Real Main source/current snapshots of one user's evolving database. No
 * source typed target, journal, lifecycle, birth or K row is fabricated. */
export async function withCanonical3Fixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, phase: (name: string) => void = () => {}) {
  await withV3Fixture(source => withV3Fixture(async receiver => run(await setup(source, receiver, phase))))
}
async function setup(source: V3Fixture, receiver: V3Fixture, phase: (name: string) => void) {
  phase('stores-ready')
  const before = sourceCases(source); phase('source-cases-ready')
  const left = await captureMixedSource(source, 2); phase('source-captured')
  const sourcePacket = (await tryReadCertifiedCapsule2SourceInputs(left.handle))!.value
  phase('source-packet-read')
  const after = currentCases(source, before); phase('current-cases-ready')
  const right = await captureMixedSource(source, 2); phase('current-captured')
  const currentPacket = (await tryReadCertifiedCapsule2SourceInputs(right.handle))!.value
  phase('current-packet-read')
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  phase('dag-captured')
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  phase('bundle-exported')
  const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  phase('knowledge-captured')
  return { source, receiver, sourcePacket, currentPacket, saved, cases: { ...before, ...after },
    beforeSource: allTables(source.db), beforeReceiver: allTables(receiver.db) }
}
