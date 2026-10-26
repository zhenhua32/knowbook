import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { parseSyncedBlockPayload, serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreTemplateReferencePlan3, readRootRestoreTemplateReferencePlan3 } from '../src/main/database/restore-knowledge-template3-read'
import { graph3Rows, graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withTemplate3Fixture, withTemplate3ForkFixture } from './helpers/template3-fixture'
import { tamperContent3VerificationOriginals } from './helpers/content3-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreTemplateReferencePlan3>>['value']
function templateFor(value: Value, id: string) {
  const found = value.templates.filter(item => item.templateId === id)
  assert.equal(found.length, 1)
  return found[0]
}
function preserveOtherTemplateCells(original: Parameters<typeof graph3Rows>[0], value: Value) {
  const before = original.tables.find(table => table.name === 'document_templates')!
  const after = value.tables.find(table => table.name === 'document_templates')!
  assert.deepEqual(after.columns, before.columns)
  assert.deepEqual(after.primaryKey, before.primaryKey)
  assert.equal(after.rows.length, before.rows.length)
  const blocksPosition = before.columns.indexOf('blocks_json')
  after.rows.forEach((row, index) => {
    assert.equal(row.sourceRowId, before.rows[index].sourceRowId)
    row.cells.forEach((cell, column) => { if (column !== blocksPosition) assert.deepEqual(cell, before.rows[index].cells[column]) })
  })
}
function expectedPayloadOnlyJson(entry: Value['templates'][number]) {
  const blocks = JSON.parse(entry.originalBlocksJson) as DocumentBlockDraft[]
  let result = entry.originalBlocksJson
  for (const reference of entry.groupReferences) {
    if (reference.sourceGroupId !== null && reference.targetGroupId !== null && reference.sourceGroupId !== reference.targetGroupId)
      result = result.replace(JSON.stringify(blocks[reference.blockIndex].content),
        JSON.stringify(serializeSyncedBlockPayload({ version: 1, groupId: reference.targetGroupId })))
  }
  return result
}

test('actual saved ordinary and opaque templates keep draft-local identities and every navigation byte without manufacturing instances', t =>
  withTemplate3Fixture(async f => {
    const cases = f.templates, identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const prepared = await prepareRootRestoreTemplateReferencePlan3(identity.plan), value = prepared.value
    const first = templateFor(value, cases.first.id), second = templateFor(value, cases.second.id)
    const original = f.sourcePacket.source.sourceContent
    await t.test('complete source template rows retain original SQL metadata and local IDs shared with another template and a physical block', () => {
      const rows = graph3Rows(original, 'document_templates')
      assert.equal(value.templates.length, rows.length)
      for (const entry of value.templates) {
        const row = rows.find(row => row.value.id === entry.templateId)!
        assert.ok(row)
        assert.equal(entry.createdAt, row.value.created_at)
        assert.equal(entry.sourceRowId, row.original.sourceRowId)
        assert.equal(entry.originalBlocksJson, row.value.blocks_json)
        assert.equal(entry.upstreamBlocksJson, row.value.blocks_json)
        assert.equal(entry.localReferencePolicy, 'preserve-local-ids-and-all-navigation-bytes-until-instantiation')
        assert.equal(entry.summaryLocalRemapping, false)
        const blocks = JSON.parse(entry.originalBlocksJson) as Array<DocumentBlockDraft & { id: string }>
        assert.equal(entry.localAssignments.length, blocks.length)
        for (const [index, local] of entry.localAssignments.entries()) {
          assert.equal(local.templateId, entry.templateId)
          assert.equal(local.localId, blocks[index].id)
          assert.equal(local.targetLocalId, blocks[index].id)
          assert.equal(local.parentLocalId, blocks[index].parentBlockId ?? null)
        }
      }
      for (const localId of [cases.rootId, cases.childId, cases.physicalSpelling, cases.linksId]) {
        const a = first.localAssignments.find(item => item.localId === localId)!
        const b = second.localAssignments.find(item => item.localId === localId)!
        assert.ok(a && b)
        assert.notEqual(a.key, b.key, 'The same spelling in two template rows has two local owners')
        assert.equal(a.targetLocalId, localId)
        assert.equal(b.targetLocalId, localId)
      }
      assert.equal(first.localAssignments.find(item => item.localId === cases.childId)!.parentLocalId, cases.rootId)
      const physical = identity.value.assignments.find(item => item.kind === 'block' && item.physical && item.sourceId === cases.physicalSpelling)!
      assert.ok(physical)
      assert.notEqual(first.localAssignments.find(item => item.localId === cases.physicalSpelling)!.key, physical.key)
      preserveOtherTemplateCells(original, value)
    })
    await t.test('title summary variables relative paths definitions code and shadowed JSON literals remain unchanged while only strict group payloads may map', () => {
      assert.equal(first.originalBlocksJson, cases.originalBlocksJson)
      assert.ok(first.originalBlocksJson.includes(JSON.stringify(cases.shadowedContent)))
      assert.equal(first.candidateBlocksJson, expectedPayloadOnlyJson(first))
      assert.ok(first.candidateBlocksJson.includes(JSON.stringify(cases.shadowedContent)))
      const before = JSON.parse(first.originalBlocksJson) as DocumentBlockDraft[]
      const after = JSON.parse(first.candidateBlocksJson) as DocumentBlockDraft[]
      assert.deepEqual(after.map(block => block.id), before.map(block => block.id))
      assert.deepEqual(after.map(block => block.parentBlockId), before.map(block => block.parentBlockId))
      for (const [index, block] of before.entries()) if (block.type !== 'synced-block') assert.deepEqual(after[index], block)
      assert.equal(after.find(block => block.id === cases.linksId)!.content, cases.links)
      assert.equal(after.find(block => block.id === 'literal code')!.content, '[[shared-child]] {{date}} [use][shared]')
      const candidateRows = graph3Rows({ encoding: original.encoding, tables: value.tables }, 'document_templates')
      const row = candidateRows.find(row => row.value.id === cases.first.id)!
      assert.equal(row.value.title, cases.title)
      assert.equal(row.value.summary, cases.summary)
      assert.equal(row.value.blocks_json, first.candidateBlocksJson)
      assert.equal(second.candidateBlocksJson, second.originalBlocksJson)
    })
    await t.test('opaque synced drafts preserve full original text and create neither group nor instance knowledge', () => {
      const blocks = JSON.parse(first.candidateBlocksJson) as DocumentBlockDraft[]
      for (const [index, localId] of cases.opaqueIds.entries()) {
        const reference = first.groupReferences.find(item => item.localId === localId)!
        assert.equal(reference.status, 'opaque-draft')
        assert.equal(reference.sourceGroupId, null)
        assert.equal(reference.targetGroupId, null)
        assert.equal(reference.assignmentKey, null)
        assert.equal(reference.groupSource, null)
        assert.equal(reference.tuple, null)
        assert.equal(blocks.find(block => block.id === localId)!.content, cases.opaqueContents[index])
        assert.equal(f.sourcePacket.knowledge.occupancy.some(item => item.namespace === 'instance' && item.id === localId), false)
      }
      assert.equal(f.sourcePacket.knowledge.occupancy.some(item => item.namespace === 'group' && item.id === cases.opaqueGroupId), false)
      const live = first.groupReferences.find(item => item.localId === 'saved live reference')!
      assert.equal(live.status, 'physical')
      assert.equal(live.sourceGroupId, f.source.groupId)
      const group = f.sourcePacket.knowledge.groups.find(item => item.tuple.groupId === f.source.groupId)!
      assert.deepEqual(live.tuple, group.tuple)
      assert.deepEqual(live.groupSource, group.source)
      const missing = first.groupReferences.find(item => item.localId === 'saved missing reference')!
      assert.equal(missing.status, 'missing-reservation')
      assert.equal(missing.resolvedHistoricalBirth, false)
      assert.equal(value.templateStructureReferencesRewritten, true)
      assert.equal(value.templateGroupReferencesRewritten, true)
      for (const flag of ['referenceRewriteComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const)
        assert.equal(value[flag], false)
    })
    await t.test('private owners reject DTO copies and accessors and a hot read reproduces the complete candidate', async () => {
      let calls = 0
      const fake = Object.defineProperty({}, 'kind', { get() { calls++; throw new Error('caller getter') } })
      await assert.rejects(prepareRootRestoreTemplateReferencePlan3(fake as never))
      await assert.rejects(readRootRestoreTemplateReferencePlan3(fake as never))
      await assert.rejects(prepareRootRestoreTemplateReferencePlan3({ ...identity.plan }))
      await assert.rejects(readRootRestoreTemplateReferencePlan3({ ...prepared.plan }))
      assert.equal(calls, 0)
      assert.equal(Object.isFrozen(first.localAssignments), true)
      assert.equal(Object.isFrozen(value.tables[0].rows), true)
      assert.deepEqual(await readRootRestoreTemplateReferencePlan3(prepared.plan), value)
      const manifestPath = join(identity.directory, 'manifest.json'), manifest = await readFile(manifestPath)
      await writeFile(manifestPath, '{}\n')
      await assert.rejects(readRootRestoreTemplateReferencePlan3(prepared.plan))
      await writeFile(manifestPath, manifest)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreTemplateReferencePlan3(prepared.plan))
    })
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))

test('independent actual Main group incarnations fork strict template payloads and isolate a missing source group from its current physical occupant', () =>
  withTemplate3ForkFixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const { value } = await prepareRootRestoreTemplateReferencePlan3(identity.plan)
    const entry = templateFor(value, f.template.id), original = f.sourcePacket.source.sourceContent
    const physical = identity.value.assignments.filter(item => item.kind === 'group' && item.sourceId === f.groupId && item.physical)
    assert.equal(physical.length, 1)
    const fork = physical[0]
    assert.equal(fork.requiresExplicitForkDecision, true)
    assert.notEqual(fork.targetId, f.groupId)
    assert.notEqual(fork.targetCreationId, f.sourceAck.createdLifecycle.creationId)
    const sourceGroup = f.sourcePacket.knowledge.groups.find(group => group.tuple.groupId === f.groupId)!
    const live = entry.groupReferences.find(reference => reference.localId === f.rootId)!
    assert.equal(live.status, 'physical')
    assert.equal(live.sourceGroupId, f.groupId)
    assert.equal(live.targetGroupId, fork.targetId)
    assert.equal(live.assignmentKey, fork.key)
    assert.deepEqual(live.tuple, sourceGroup.tuple)
    assert.deepEqual(live.groupSource, sourceGroup.source)
    const facts = f.sourcePacket.knowledge.occupancy.flatMap((item, index) => item.namespace === 'group' && item.id === f.missingGroupId
      && item.source.table === 'document_templates' && graph3Text(item.source.key[0], original.encoding) === f.template.id ? [index] : [])
    assert.equal(facts.length, 1, 'Only the real strict missing payload contributes a reservation; the opaque same-spelling draft contributes none')
    const missingSlots = identity.value.assignments.filter(item => item.kind === 'group' && item.sourceId === f.missingGroupId
      && !item.physical && item.state === 'missing-reservation' && item.facts.includes(facts[0]))
    assert.equal(missingSlots.length, 1)
    const missing = entry.groupReferences.find(reference => reference.localId === 'missing reservation')!
    assert.equal(missing.status, 'missing-reservation')
    assert.equal(missing.resolvedHistoricalBirth, false)
    assert.equal(missing.assignmentKey, missingSlots[0].key)
    assert.equal(missing.targetGroupId, missingSlots[0].targetId)
    assert.notEqual(missing.targetGroupId, f.missingGroupId)
    assert.notEqual(missing.targetGroupId, fork.targetId)
    assert.equal(f.sourcePacket.knowledge.groups.some(group => group.tuple.groupId === f.missingGroupId), false)
    assert.equal(f.currentPacket.knowledge.groups.find(group => group.tuple.groupId === f.missingGroupId)!.tuple.creationId,
      f.currentMissingAck.createdLifecycle.creationId)
    for (const id of [live.targetGroupId, missing.targetGroupId])
      assert.equal(f.currentPacket.knowledge.groups.some(group => group.tuple.groupId === id), false)
    const blocks = JSON.parse(entry.candidateBlocksJson) as DocumentBlockDraft[]
    assert.equal(parseSyncedBlockPayload(blocks.find(block => block.id === f.rootId)!.content).groupId, fork.targetId)
    assert.equal(parseSyncedBlockPayload(blocks.find(block => block.id === 'missing reservation')!.content).groupId, missing.targetGroupId)
    assert.equal(blocks.find(block => block.id === 'opaque wrong group')!.content, f.opaqueContent)
    assert.equal(entry.groupReferences.find(reference => reference.localId === 'opaque wrong group')!.status, 'opaque-draft')
    assert.equal(f.sourcePacket.knowledge.occupancy.some(item => item.namespace === 'instance' && item.id === 'opaque wrong group'), false)
    const canonical = identity.value.assignments.find(item => item.kind === 'block' && item.sourceId === f.rootId && item.physical)!
    assert.notEqual(canonical.targetId, f.rootId)
    const local = entry.localAssignments.find(item => item.localId === f.rootId)!
    assert.equal(local.targetLocalId, f.rootId, 'A template local spelling does not follow the unrelated physical canonical slot')
    assert.equal(local.parentLocalId, 'local parent')
    assert.notEqual(local.key, canonical.key)
    assert.equal(entry.originalBlocksJson, f.originalBlocksJson)
    assert.equal(entry.candidateBlocksJson, expectedPayloadOnlyJson(entry))
    assert.ok(entry.candidateBlocksJson.includes(JSON.stringify(f.shadowedContent)))
    const combined = templateFor(value, f.combinedTemplate.id)
    assert.notEqual(combined.upstreamBlocksJson, combined.originalBlocksJson, 'The actual default catalog identity differs across the two Main Stores')
    const combinedBlocks = JSON.parse(combined.candidateBlocksJson) as DocumentBlockDraft[]
    const view = parseDatabaseViewPayload(combinedBlocks.find(block => block.id === 'combined view')!.content)
    assert.equal(view.databaseId, f.current.catalogId, 'The template transform keeps the preceding real database3 mapping')
    assert.equal(parseSyncedBlockPayload(combinedBlocks.find(block => block.id === 'combined group')!.content).groupId, fork.targetId)
    const upstream = JSON.parse(combined.upstreamBlocksJson) as DocumentBlockDraft[]
    assert.deepEqual(combinedBlocks.find(block => block.id === 'combined view'), upstream.find(block => block.id === 'combined view'))
    preserveOtherTemplateCells(original, value)
    assert.equal(value.referenceRewriteComplete, false)
    assert.equal(value.permit, false)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.current.db), f.beforeCurrent)
  }))
