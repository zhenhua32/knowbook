import assert from 'node:assert/strict'
import { basename } from 'node:path'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../../src/shared/databaseViewBlock'
import { serializeSyncedBlockPayload } from '../../src/shared/syncedBlockValidation'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { tryReadCertifiedCapsule2SourceInputs } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { withContent3Fixture } from './content3-fixture'
import { captureMixedSource } from './mixed-required-source-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock, randomUUID, withV3Fixture,
  type V3Fixture } from './synced-backup-v3-fixture'

type Content3Fixture = Parameters<Parameters<typeof withContent3Fixture>[0]>[0]
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
const reference = (id: string, groupId: string): DocumentBlockDraft => ({ ...paragraph(id,
  serializeSyncedBlockPayload({ version: 1, groupId })), type: 'synced-block' })
const shadowedContent = 'shadowed {{title}} [ordinary](../Unchanged.md#shared-child)'
function preserveTemplateJsonSpelling(source: V3Fixture, templateId: string, contentIndex: number) {
  const row = source.db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(templateId) as { blocks_json: string }
  const blocks = JSON.parse(row.blocks_json) as DocumentBlockDraft[]
  const effective = '"content": ' + JSON.stringify(blocks[contentIndex].content)
  const pretty = JSON.stringify(blocks, null, 2).replace(effective,
    '"content": ' + JSON.stringify(shadowedContent) + ',\n    "\\u0063ontent": ' + JSON.stringify(blocks[contentIndex].content)) + '\n'
  assert.notEqual(pretty, row.blocks_json)
  assert.ok(pretty.includes('"\\u0063ontent"'))
  assert.deepEqual(JSON.parse(pretty), blocks, 'Raw JSON formatting and shadowed keys do not change the actual saved draft')
  source.db.prepare('UPDATE document_templates SET blocks_json=? WHERE id=?').run(pretty, templateId)
  return pretty
}

/** Templates come only from the real Store saver. Their IDs are draft-local;
 * no fixture inserts a block, ledger or instance for those saved names. */
function saveTemplateCases(source: V3Fixture) {
  const rootId = 'template local root', childId = 'shared-child', linksId = 'draft links', physicalSpelling = source.hostBodyId
  const missingGroupId = randomUUID(), opaqueGroupId = randomUUID()
  const title = ' {{title}} draft {{date}} '
  const summary = ' [summary-use][shared] [local](#shared-child) {{title}} {{date}} [future](../Future.md#future) '
  const links = '[[shared-child|alias]] [[#^shared-child]] [local](#shared-child) [caret](#^shared-child) '
    + '[[Elsewhere#shared-child]] [future](../Future.md#future) [remote](https://example.invalid/#shared-child) '
    + '![image](../image.png) [asset](file:///opaque) [[{{title}}]] [variable]({{path}}) '
    + '[physical spelling](#' + physicalSpelling + ') [use][shared]'
  const opaqueContents = ['{{title}} unresolved draft', JSON.stringify({ version: 2, groupId: opaqueGroupId }),
    '{"version":1,"groupId":"' + opaqueGroupId + '","certified":true}']
  const opaqueIds = ['opaque literal', 'opaque future', 'opaque extra authority']
  const first = source.store.saveDocumentTemplate({ name: 'Template3 independent local draft', title, summary, blocks: [
    { ...paragraph(rootId, 'Local parent {{title}}'), type: 'todo', checked: true },
    { ...paragraph(childId, 'Local child'), type: 'todo', depth: 1, parentBlockId: rootId },
    paragraph(physicalSpelling, 'Same spelling as a real physical block'), paragraph(linksId, links),
    paragraph('first definition', '[shared]: ../First.md#first "first definition"'),
    paragraph('inactive definition', '[shared]: ../Second.md#second "inactive duplicate"'),
    { ...paragraph('literal code', '[[shared-child]] {{date}} [use][shared]'), type: 'code', language: 'markdown' },
    reference('saved live reference', source.groupId), { ...reference('saved missing reference', missingGroupId),
      content: '{ "groupId" : "' + missingGroupId + '", "version" : 1 }' },
    ...opaqueContents.map((content, index) => ({ ...paragraph(opaqueIds[index], content), type: 'synced-block' }))
  ] })
  const second = source.store.saveDocumentTemplate({ name: 'Template3 same local spellings', title: '{{title}} second', summary: '[local](#shared-child)',
    blocks: [{ ...paragraph(rootId, 'An independent parent'), type: 'todo' },
      { ...paragraph(childId, 'An independent child'), type: 'todo', depth: 1, parentBlockId: rootId },
      paragraph(physicalSpelling, 'An independent physical spelling'), paragraph(linksId, '[[shared-child]] [local](#shared-child)') ] })
  for (const id of [rootId, childId, linksId, ...opaqueIds]) {
    assert.equal(source.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(id), undefined)
    assert.equal(source.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(id), undefined)
    assert.equal(source.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(id), undefined)
  }
  return { first, second, rootId, childId, linksId, physicalSpelling, title, summary, links,
    missingGroupId, opaqueGroupId, opaqueIds, opaqueContents, shadowedContent, originalBlocksJson: '' }
}
export type Template3Cases = ReturnType<typeof saveTemplateCases>
export async function withTemplate3Fixture(run: (fixture: Content3Fixture & { templates: Template3Cases }) => Promise<void>) {
  let templates: Template3Cases | undefined
  return withContent3Fixture(f => { assert.ok(templates); return run({ ...f, templates }) }, undefined, source => {
    assert.ok(templates)
    templates.originalBlocksJson = preserveTemplateJsonSpelling(source, templates.first.id,
      templates.first.blocks.findIndex(block => block.id === 'saved live reference'))
  },
    source => { templates = saveTemplateCases(source) })
}

/** Two independent actual Main writers establish conflicting incarnations.
 * The current-only group deliberately occupies a source missing reference. */
export async function withTemplate3ForkFixture(run: (fixture: Awaited<ReturnType<typeof forkSetup>>) => Promise<void>) {
  return withV3Fixture(source => withV3Fixture(async current => run(await forkSetup(source, current))))
}
async function forkSetup(source: V3Fixture, current: V3Fixture) {
  const groupId = randomUUID(), missingGroupId = randomUUID(), rootId = randomUUID(), childId = randomUUID()
  const sourceInput = createRequest(source.db, { documentId: source.hostId, groupId, selectedRootIds: [rootId], dirty(working) {
    working.blocks.push({ ...freshBlock(rootId, 'Source template canonical root'), type: 'callout' },
      { ...freshBlock(childId, 'Source template canonical child'), depth: 1, parentBlockId: rootId })
  } })
  const sourceAck = created(applySyncedHostCommand(source.db, sourceInput))
  const currentInput = createRequest(current.db, { documentId: current.hostId, groupId, selectedRootIds: [current.hostBodyId] })
  const currentAck = created(applySyncedHostCommand(current.db, currentInput))
  const missingHostId = current.store.createDocument(null), missingBodyId = randomUUID()
  current.store.updateDocument(missingHostId, { title: 'Template missing group owner', summary: '', blocks: [paragraph(missingBodyId, 'Actual independent current group')] })
  const currentMissingInput = createRequest(current.db, { documentId: missingHostId, groupId: missingGroupId, selectedRootIds: [missingBodyId] })
  const currentMissingAck = created(applySyncedHostCommand(current.db, currentMissingInput))
  assert.notEqual(sourceAck.createdLifecycle.creationId, currentAck.createdLifecycle.creationId)
  const opaqueContent = JSON.stringify({ version: 2, groupId: missingGroupId })
  const template = source.store.saveDocumentTemplate({ name: 'Template3 source fork references', title: ' {{title}} ',
    summary: ' [local](#local parent) {{date}} ', blocks: [
      { ...paragraph('local parent', 'Unchanged draft parent'), type: 'callout' },
      { ...reference(rootId, groupId), depth: 1, parentBlockId: 'local parent' },
      reference('missing reservation', missingGroupId),
      { ...paragraph('opaque wrong group', opaqueContent), type: 'synced-block' },
      paragraph('saved links', '[local](#' + rootId + ') [[missing reservation]] {{title}}')
    ] })
  assert.equal(template.blocks.find(block => block.id === rootId)!.parentBlockId, 'local parent')
  const combinedTemplate = source.store.saveDocumentTemplate({ name: 'Template3 combined database and group references', title: '{{title}}', summary: '', blocks: [
    { ...paragraph('combined view', serializeDatabaseViewPayload({ version: 1, databaseId: source.catalogId, viewId: null,
      config: createDefaultDatabaseViewConfig('table', [source.catalogColumn.id]) })), type: 'database-view' },
    reference('combined group', groupId)
  ] })
  const originalBlocksJson = preserveTemplateJsonSpelling(source, template.id, 1)
  const left = await captureMixedSource(source, 2)
  const sourcePacket = (await tryReadCertifiedCapsule2SourceInputs(left.handle))!.value
  const right = await captureMixedSource({ ...current, userDataRoot: source.userDataRoot }, 2)
  const currentPacket = (await tryReadCertifiedCapsule2SourceInputs(right.handle))!.value
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: current.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  return { source, current, sourcePacket, currentPacket, saved, template, combinedTemplate, groupId, missingGroupId, rootId, childId,
    sourceAck, currentAck, currentMissingAck, opaqueContent, originalBlocksJson, shadowedContent,
    beforeSource: allTables(source.db), beforeCurrent: allTables(current.db) }
}
