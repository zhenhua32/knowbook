import assert from 'node:assert/strict'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import { withContent3Fixture } from './content3-fixture'
import { applySyncedHostCommand, createRequest, created, randomUUID, snapshot } from './synced-backup-v3-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { updateSyncedBlockGroup } from '../../src/main/database/synced-blocks-content'

type ContentFixture = Parameters<Parameters<typeof withContent3Fixture>[0]>[0]
type Source = ContentFixture['source']
const block = (id: string, content: string, type = 'paragraph'): DocumentBlockDraft => ({ id, type, content,
  checked: false, depth: 0, parentBlockId: null })
const pathUrl = (path: string) => '/' + path.split('/').map(encodeURIComponent).join('/') + '.md'

function document(source: Source, title: string, blocks: DocumentBlockDraft[], summary = '', parent: string | null = null) {
  const id = source.store.createDocument(parent)
  source.store.updateDocument(id, { title, summary, blocks })
  return id
}

function seedSource(source: Source) {
  const legacyPath = 'Rewrite Legacy Target', finalPath = 'Rewrite Final Target', currentPath = 'Rewrite Current Target'
  const oldUrl = pathUrl(legacyPath), finalUrl = pathUrl(finalPath), currentUrl = pathUrl(currentPath)
  const firstEchoId = randomUUID(), secondEchoId = randomUUID(), targetBodyId = randomUUID()
  const targetBlocks = [block(firstEchoId, 'Echo', 'heading-1'), block(secondEchoId, 'Echo', 'heading-2'),
    block(targetBodyId, 'A stable ordinary target block')]
  const targetId = document(source, finalPath, targetBlocks)
  const directId = randomUUID(), useId = randomUUID(), definitionId = randomUUID(), duplicateDefinitionId = randomUUID()
  const contextualId = randomUUID(), opaqueId = randomUUID(), missingId = randomUUID()
  const direct = '😀 Prefix [direct](' + oldUrl + '#echo "kept title")\r\n'
    + '<a href="' + oldUrl + '#echo">HTML kept</a> [same](' + oldUrl + '#echo)'
  const use = '[first][shared] and [second][shared]'
  const definition = '[shared]: ' + oldUrl + '#echo "source title"'
  const duplicateDefinition = '[shared]: https://example.invalid/inactive "inactive duplicate"'
  const contextual = '[[Rewrite Legacy Target#Echo|source alias]] [block](' + oldUrl + '#^' + targetBodyId
    + ') [document](' + oldUrl + ') ![opaque image](' + oldUrl + '#echo)'
  const opaque = '[opaque code](' + oldUrl + '#echo)'
  const missing = '[source missing](/Future%20Occupied.md)'
  const summary = '[summary-only][shared] and [summary-direct](' + oldUrl + '#echo "summary title")'
  const sourceHostId = document(source, 'Rewrite Source Caller', [block(directId, direct), block(useId, use),
    block(definitionId, definition), block(duplicateDefinitionId, duplicateDefinition), block(contextualId, contextual),
    { ...block(opaqueId, opaque, 'code'), language: 'text' }, block(missingId, missing)], summary)
  const canonicalDefinitionId = randomUUID(), canonicalDefinition = '[shared]: ' + oldUrl + '#echo "source canonical definition"'
  const definitionGroupHostId = document(source, 'Rewrite Definition Source', [block(canonicalDefinitionId, canonicalDefinition)])
  const create = createRequest(source.db, { documentId: definitionGroupHostId, selectedRootIds: [canonicalDefinitionId] })
  created(applySyncedHostCommand(source.db, create))
  return { legacyPath, finalPath, currentPath, oldUrl, finalUrl, currentUrl, targetId, targetBlocks,
    firstEchoId, secondEchoId, targetBodyId, sourceHostId, directId, useId, definitionId, duplicateDefinitionId,
    contextualId, opaqueId, missingId, direct, use, definition, duplicateDefinition, contextual, opaque, missing, summary,
    canonicalDefinitionId, canonicalDefinition, definitionGroupHostId, definitionGroupId: create.action.groupId }
}

function seedCurrent(source: Source, n: ReturnType<typeof seedSource>) {
  const deletedHeadingId = randomUUID(), deletedBlockId = randomUUID()
  // A real ordinary writer corrects the source's historical path drift and
  // changes its current title. Reusing the surviving IDs preserves their real
  // births; new current children have real identities and disappear only by
  // the candidate's explicit whole-host source selection.
  source.store.updateDocument(n.targetId, { title: n.currentPath, summary: 'Current target summary', blocks: [
    block(deletedHeadingId, 'Echo', 'heading-1'), ...n.targetBlocks,
    block(deletedBlockId, 'Current-only block, absent from the source forest')
  ] })
  const occupantBodyId = randomUUID(), occupantId = document(source, n.legacyPath,
    [block(occupantBodyId, 'Current-only exact old-path occupant')])
  const futureOccupantId = document(source, 'Future Occupied', [block(randomUUID(), 'A missing source path is now occupied')])
  const leafHeadingId = randomUUID(), leafBodyId = randomUUID(), leafTitle = 'Retained Leaf'
  const leafOldPath = n.currentPath + '/' + leafTitle, leafFinalPath = n.finalPath + '/' + leafTitle
  const leafText = '[parent](../Rewrite%20Current%20Target.md#echo-1) [bare self](#leaf)'
  const leafId = document(source, leafTitle, [block(leafHeadingId, 'Leaf', 'heading-1'), block(leafBodyId, leafText)], '', n.targetId)
  const retainedDirectId = randomUUID(), retainedUseId = randomUUID(), retainedDefinitionId = randomUUID()
  const retainedMissingId = randomUUID(), retainedOpaqueId = randomUUID()
  const retainedDirect = '[current occupant](' + n.oldUrl + ') [stable section](' + n.currentUrl + '#echo-1)'
    + ' [leaf](' + pathUrl(leafOldPath) + '#leaf)'
  const retainedUse = '[current use][shared]'
  const retainedDefinition = '[shared]: ' + n.currentUrl + '#echo-1 "current title"'
  const retainedMissing = '[removed section](' + n.currentUrl + '#echo) [removed block](' + n.currentUrl + '#^' + deletedBlockId + ')'
  const retainedOpaque = '`' + n.currentUrl + '#echo-1` and https://example.invalid/kept'
  const retainedSummary = '[summary-only][shared] and [current-summary](' + n.currentUrl + '#echo-1)'
  const retainedHostId = document(source, 'Rewrite Retained Caller', [block(retainedDirectId, retainedDirect),
    block(retainedUseId, retainedUse), block(retainedDefinitionId, retainedDefinition), block(retainedMissingId, retainedMissing),
    block(retainedOpaqueId, retainedOpaque)], retainedSummary)
  const beforeDefinition = snapshot(source.db, n.definitionGroupId), firstInstance = beforeDefinition.instances[0]
  assert.ok(firstInstance)
  const previousDefinition = beforeDefinition.blocks.find(item => item.id === n.canonicalDefinitionId)!.content
  assert.ok(previousDefinition.includes('"source canonical definition"'))
  // Keep the actual persisted destination/binding key intact. The content
  // writer supports changing the definition's title; a bare URL edit needs a
  // separate binding command. The resolved consumer's title still proves that
  // replacing this first definition changes its complete semantic environment.
  const currentCanonicalDefinition = previousDefinition.replace('"source canonical definition"', '"current canonical definition"')
  const changedDefinition = updateSyncedBlockGroup(source.db, { groupId: n.definitionGroupId,
    expectedRevision: beforeDefinition.revision, expectedTopologyRevision: beforeDefinition.topologyRevision,
    expectedInstanceBinding: { instanceId: firstInstance.instanceId, hostDocumentId: firstInstance.hostDocumentId,
      bindingVersion: firstInstance.bindingVersion }, clientOperationId: randomUUID(),
    blocks: beforeDefinition.blocks.map(({ createdAt: _birth, ...item }) => ({ ...item,
      content: item.id === n.canonicalDefinitionId ? currentCanonicalDefinition : item.content })) })
  assert.equal(changedDefinition.status, 'saved', 'Actual Main definition-title edit result: ' + JSON.stringify(changedDefinition))
  const environmentUseId = randomUUID(), environmentFallbackId = randomUUID()
  const environmentUse = '[canonical consumer][shared]', environmentFallback = '[shared]: https://example.invalid/fallback "fallback definition"'
  const environmentHostId = document(source, 'Rewrite Retained Definition Environment', [block(environmentUseId, environmentUse),
    block(environmentFallbackId, environmentFallback)])
  const insertion = command(source.db, { documentId: environmentHostId, groupId: n.definitionGroupId,
    target: { beforeBlockId: environmentUseId } })
  insertAck(applySyncedHostCommand(source.db, insertion))
  assert.equal(source.store.getDocumentDetail(occupantId)!.path, n.legacyPath)
  assert.equal(source.store.getDocumentDetail(leafId)!.path, leafOldPath)
  return { deletedHeadingId, deletedBlockId, occupantBodyId, occupantId, futureOccupantId, leafHeadingId, leafBodyId,
    leafId, leafTitle, leafOldPath, leafFinalPath, leafText, retainedHostId, retainedDirectId, retainedUseId,
    retainedDefinitionId, retainedMissingId, retainedOpaqueId, retainedDirect, retainedUse, retainedDefinition,
    retainedMissing, retainedOpaque, retainedSummary, currentCanonicalDefinition, environmentHostId, environmentUseId,
    environmentFallbackId, environmentUse, environmentFallback, environmentInstanceId: insertion.action.instanceId }
}

export type Navigation3RewriteCases = ReturnType<typeof seedSource> & ReturnType<typeof seedCurrent>
export type Navigation3RewriteFixture = ContentFixture & { navigationRewrite: Navigation3RewriteCases }

/** The actual Main capture, immutable capsule, mixed DAG and Root3 owner come
 * from withContent3Fixture. Only one raw ordinary SQL edit saves a valid
 * historical documents.path drift; it proves no writer history/ACK. All
 * document/block births and both sides' business edits use the real Store. */
export async function withNavigation3RewriteFixture(run: (fixture: Navigation3RewriteFixture) => Promise<void>) {
  let sourceCases: ReturnType<typeof seedSource> | undefined
  let currentCases: ReturnType<typeof seedCurrent> | undefined
  const sourceReady = () => { assert.ok(sourceCases); return sourceCases }
  await withContent3Fixture(async f => {
    assert.ok(currentCases)
    const n = { ...sourceReady(), ...currentCases }
    assert.equal(f.sourcePacket.source.physical.documents.find(row => row.documentId === n.targetId)!.path, n.legacyPath)
    assert.equal(f.currentPacket.source.physical.documents.find(row => row.documentId === n.occupantId)!.path, n.legacyPath)
    await run({ ...f, navigationRewrite: n })
  }, source => { currentCases = seedCurrent(source, sourceReady()) }, source => {
    const n = sourceReady()
    source.db.prepare('UPDATE documents SET path=? WHERE id=?').run(n.legacyPath, n.targetId)
    assert.equal(source.store.getDocumentDetail(n.targetId)!.title, n.finalPath)
    assert.equal(source.store.getDocumentDetail(n.sourceHostId)!.blocks.find(row => row.id === n.directId)!.content, n.direct)
  }, source => { sourceCases = seedSource(source) })
}
