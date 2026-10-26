import assert from 'node:assert/strict'
import { withContent3Fixture } from './content3-fixture'
import { applySyncedHostCommand, applySyncedHostFinal, applied, createRequest, created, freshBlock,
  randomUUID, request, snapshot, type V3Fixture } from './synced-backup-v3-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { editCreatedGroup } from './synced-host-command-create-fixture'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'

type ContentFixture = Parameters<Parameters<typeof withContent3Fixture>[0]>[0]
export interface Merge3Scenario {
  readonly sourceTitle: string
  readonly currentTitle: string
  readonly currentParentBlockId: string
  readonly currentChildBlockId: string
  readonly currentCanonicalBlockId: string
  readonly retainedDocumentId: string
  readonly retainedChildId: string
  readonly retainedDescendantId: string
  readonly retainedBodyId: string
  readonly retainedChildBodyId: string
  readonly retainedDescendantBodyId: string
  readonly externalInstanceId: string
  readonly orphanHostId: string
  readonly orphanGroupId: string
  readonly orphanCanonicalBlockId: string
  readonly sharedTemplateId: string
  readonly currentTemplateId: string
  readonly currentDatabaseId: string
  readonly currentColumnId: string
  readonly currentEntityId: string
  readonly currentViewId: string
  readonly currentSharedDatabaseViewId: string
  readonly sourceAnonymousRowIds: readonly string[]
  readonly currentAnonymousRowIds: readonly string[]
}
export type Merge3Fixture = ContentFixture & { readonly merge: Merge3Scenario }

function anonymousRows(f: V3Fixture): string[] {
  return (f.db.prepare('SELECT CAST(rowid AS TEXT) AS id FROM document_database_values WHERE document_id IS NULL AND entity_id IS NULL ORDER BY rowid')
    .all() as Array<{ id: string }>).map(row => row.id)
}
function addAnonymousRows(f: V3Fixture, stamp: string): void {
  const insert = f.db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(NULL,?,?,?,NULL)')
  // Genuine SQLite NULL-PK occurrences, not a Main identity/ACK fixture. Equal
  // values deliberately occur twice; no DTO is ever used to mint a Main owner.
  for (let index = 0; index < 2; index++)
    insert.run(f.catalogColumn.id, 'equal anonymous value\0kept twice', stamp)
}

/** Build and capture source/current only once. Every group, canonical change,
 * external instance and orphan is written by the actual Main command APIs.
 * Ordinary nullable value/template SQL edits remain real SQLite input rows. */
export async function withMerge3Fixture(run: (fixture: Merge3Fixture) => Promise<void>) {
  const sourceTitle = '源'.repeat(501), currentTitle = 'Merge current parent'
  let scenario: Merge3Scenario | undefined
  let sourceAnonymousRowIds: string[] = [], sharedTemplateId = '', anonymousStamp = ''
  await withContent3Fixture(async f => {
    assert.ok(scenario)
    await run({ ...f, merge: scenario })
  }, f => {
    assert.equal(f.store.getDocumentDetail(f.targetId)!.title, sourceTitle)
    const currentParentBlockId = randomUUID(), currentChildBlockId = randomUUID()
    applied(applySyncedHostFinal(f.db, request(f.db, [f.hostId], after => {
      after[0].blocks.push({ ...freshBlock(currentParentBlockId, 'Current-only host parent'), type: 'toggle' },
        { ...freshBlock(currentChildBlockId, 'Current-only nested host child'), parentBlockId: currentParentBlockId, depth: 1 })
    })))

    // The host-final command deliberately refuses title changes. Exercise the
    // real ordinary document writer for the parent-title/layout scenario.
    f.store.updateDocument(f.targetId, { title: currentTitle, summary: 'Independent target summary',
      blocks: [{ ...freshBlock(f.targetBodyId, 'Different current business body'), type: 'heading-1' }] })
    const retainedDocumentId = f.store.createDocument(null), retainedChildId = f.store.createDocument(retainedDocumentId)
    const retainedDescendantId = f.store.createDocument(f.targetId)
    const retainedBodyId = randomUUID(), retainedChildBodyId = randomUUID(), retainedDescendantBodyId = randomUUID()
    f.store.updateDocument(retainedDocumentId, { title: 'Retained merge branch', summary: 'Current-only root',
      blocks: [freshBlock(retainedBodyId, 'Retained root body')] })
    f.store.updateDocument(retainedChildId, { title: 'Retained merge leaf', summary: 'Current-only child',
      blocks: [freshBlock(retainedChildBodyId, 'Retained leaf body')] })
    f.store.updateDocument(retainedDescendantId, { title: 'Retained descendant', summary: 'Child of the replaced source host',
      blocks: [freshBlock(retainedDescendantBodyId, 'Retained descendant body')] })
    const external = command(f.db, { documentId: retainedDocumentId, groupId: f.groupId })
    insertAck(applySyncedHostCommand(f.db, external))

    const currentCanonicalBlockId = randomUUID(), original = snapshot(f.db, f.groupId)
    editCreatedGroup(f.db, f.groupId, [
      ...original.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: block.content + ' current canonical change' })),
      freshBlock(currentCanonicalBlockId, 'Current-only canonical child')
    ])

    const orphanHostId = f.store.createDocument(null), orphanCanonicalBlockId = randomUUID()
    f.store.updateDocument(orphanHostId, { title: 'Retained orphan host', summary: '',
      blocks: [freshBlock(randomUUID(), 'Retained ordinary orphan host body'),
        freshBlock(orphanCanonicalBlockId, 'Actual retained orphan canonical body')] })
    const orphan = createRequest(f.db, { documentId: orphanHostId, selectedRootIds: [orphanCanonicalBlockId] })
    created(applySyncedHostCommand(f.db, orphan))
    const orphanInput = request(f.db, [orphanHostId], (after, before) => {
      before[0].workingBefore.blocks = before[0].workingBefore.blocks.filter(block => block.id !== orphan.action.instanceId)
      after[0].blocks = structuredClone(before[0].workingBefore.blocks)
    })
    const orphanResult = applySyncedHostFinal(f.db, orphanInput)
    assert.ok(orphanResult.status === 'applied' || orphanResult.status === 'noop', JSON.stringify(orphanResult))
    assert.equal(applied(orphanResult).historyToken, null)
    assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(orphan.action.instanceId), undefined)
    assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE group_id=?').get(orphan.action.groupId), undefined)
    assert.ok(f.db.prepare('SELECT 1 FROM synced_group_blocks WHERE group_id=?').get(orphan.action.groupId))

    // The actual Store creates the template identity/birth. Its current row is
    // edited without changing that birth; Store has no template-update API.
    f.db.prepare('UPDATE document_templates SET title=?,summary=? WHERE id=?')
      .run('Current shared template title', 'Current shared template summary', sharedTemplateId)
    const currentTemplate = f.store.saveDocumentTemplate({ name: 'Current-only merge template', title: 'Retained template',
      summary: 'Current template summary', blocks: [freshBlock(randomUUID(), 'Current template body')] })
    const database = f.store.createDatabase({ name: 'Current-only merge database', description: 'Retained definition' })
    const column = f.store.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Current-only field', type: 'text' })
    const view = f.store.createDatabaseSavedView({ databaseId: database.id, name: 'Current-only view',
      config: createDefaultDatabaseViewConfig('table', [column.id]) })
    const entity = f.store.createDatabaseEntity({ databaseId: database.id, title: 'Current-only entity',
      fieldValues: { [column.id]: 'Retained entity value' } })
    const sharedView = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'Current extra shared view',
      config: createDefaultDatabaseViewConfig('table', [f.customColumn.id]) })
    f.store.updateDocumentDatabaseValue({ documentId: retainedDocumentId, columnId: f.catalogColumn.id,
      value: 'Retained current document value' })
    f.db.prepare('DELETE FROM document_database_values WHERE document_id IS NULL AND entity_id IS NULL').run()
    addAnonymousRows(f, anonymousStamp)
    const currentAnonymousRowIds = anonymousRows(f)
    assert.equal(currentAnonymousRowIds.length, 2)
    scenario = { sourceTitle, currentTitle, currentParentBlockId, currentChildBlockId, currentCanonicalBlockId,
      retainedDocumentId, retainedChildId, retainedDescendantId, retainedBodyId, retainedChildBodyId, retainedDescendantBodyId,
      externalInstanceId: external.action.instanceId, orphanHostId, orphanGroupId: orphan.action.groupId, orphanCanonicalBlockId,
      sharedTemplateId, currentTemplateId: currentTemplate.id, currentDatabaseId: database.id, currentColumnId: column.id,
      currentEntityId: entity.id, currentViewId: view.id, currentSharedDatabaseViewId: sharedView.id,
      sourceAnonymousRowIds, currentAnonymousRowIds }
  }, f => {
    const template = f.db.prepare('SELECT id FROM document_templates WHERE name=?').get('Actual capsule2 ordinary template') as { id: string } | undefined
    assert.ok(template); sharedTemplateId = template.id
    anonymousStamp = (f.db.prepare('SELECT updated_at FROM documents WHERE id=?').get(f.hostId) as { updated_at: string }).updated_at
    addAnonymousRows(f, anonymousStamp); sourceAnonymousRowIds = anonymousRows(f)
    assert.equal(sourceAnonymousRowIds.length, 2)
  })
}
