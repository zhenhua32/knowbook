import assert from 'node:assert/strict'
import { KnowbookStore } from '../../src/main/database/store'
import { withIncomingFixture, accepted, receiveInitialSyncedSnapshot } from './synced-initial-incoming-fixture'
import { bindBoth, completed, createRequest, created, applySyncedHostCommand, exchangeSyncedSnapshot, randomUUID, runtime,
  type Fixture, type Profile } from './synced-exchange-both-fixture'

export async function withBothCatalog(run: (f: Fixture & { sourceStore: KnowbookStore; localStore: KnowbookStore;
  alpha: string; originalBodyId: string; sourceGroupId: string; defaultColumn: string; nullableColumn: string; missingColumn: string; customColumns: string[]; customDatabases: string[]; standalone: string }) => Promise<void>) {
  return withIncomingFixture(async original => {
    const A = original.newPristine('both-catalog-source'), B = original.newPristine('both-catalog-receiver')
    // Both genuine Store instances open before their respective profile has any group.
    // No constructor gate or production Store admission rule is weakened.
    const sourceStore = new KnowbookStore(A.file), localStore = new KnowbookStore(B.file)
    try {
      const alpha = sourceStore.createDocument(null), groupHost = sourceStore.createDocument(null), originalBodyId = randomUUID(), sourceBlock = randomUUID()
      sourceStore.updateDocument(alpha, { title: 'Original catalog document', summary: 'authored catalog summary', blocks: [{ id: originalBodyId, type: 'paragraph', content: 'common catalog document body', checked: false, depth: 0, parentBlockId: null }] })
      sourceStore.updateDocument(groupHost, { title: 'Independent catalog group host', summary: '', blocks: [{ id: sourceBlock, type: 'paragraph', content: 'independent canonical body', checked: false, depth: 0, parentBlockId: null }] })
      const defaultColumn = sourceStore.createDocumentDatabaseColumn({ databaseId: A.defaultId, name: 'Direct default field', type: 'text' })
      sourceStore.updateDocumentDatabaseValue({ documentId: alpha, columnId: defaultColumn.id, value: 'direct original ' + alpha })
      sourceStore.createDatabaseEntity({ databaseId: A.defaultId, documentId: alpha, title: 'Original catalog document', fieldValues: { [defaultColumn.id]: 'explicit default entity value ' + alpha } })
      const customDatabases = [sourceStore.createDatabase({ name: 'First custom membership' }), sourceStore.createDatabase({ name: 'Second custom membership' })]
      const customColumns = customDatabases.map((database, index) => sourceStore.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Custom choice ' + index, type: 'select', options: ['first', 'second'] }))
      for (let i = 0; i < customDatabases.length; i++) sourceStore.createDatabaseEntity({ databaseId: customDatabases[i].id, documentId: alpha,
        title: i ? 'Independent authored title ' + alpha : 'Original catalog document', fieldValues: { [customColumns[i].id]: i ? 'second' : 'first' } })
      const standalone = sourceStore.createDatabaseEntity({ databaseId: customDatabases[0].id, title: 'Standalone is not a copied document membership' })
      const emptyColumn = sourceStore.createDocumentDatabaseColumn({ databaseId: A.defaultId, name: 'Main null is a missing row', type: 'text' })
      sourceStore.updateDocumentDatabaseValue({ documentId: alpha, columnId: emptyColumn.id, value: null })
      const nullableColumn = sourceStore.createDocumentDatabaseColumn({ databaseId: A.defaultId, name: 'Legal historical SQL null', type: 'text' })
      sourceStore.updateDocumentDatabaseValue({ documentId: alpha, columnId: nullableColumn.id, value: 'original actual Main value row' })
      // Approved historical input fixture only: the public setter deletes nulls,
      // but the existing schema permits an original SQL NULL value row. This is
      // before group creation/publication; no fork/baseline/receipt is fabricated.
      assert.equal(A.db.prepare('UPDATE document_database_values SET value_text=NULL WHERE document_id=? AND column_id=?').run(alpha, nullableColumn.id).changes, 1)
      const command = createRequest(A.db, { documentId: groupHost, selectedRootIds: [sourceBlock] }), ack = created(applySyncedHostCommand(A.db, command))
      await original.send(A); accepted(await original.track(receiveInitialSyncedSnapshot(B.db, original.input(randomUUID(), B), runtime)))
      const exchange = (profile: Profile = B, operationId: string = randomUUID(), signal?: AbortSignal) => original.track(exchangeSyncedSnapshot(profile.db,
        original.input(operationId, profile), { ...runtime, ...(signal ? { signal } : {}) }))
      completed(await exchange(A), 'noop'); completed(await exchange(B), 'noop')
      const connect = (profile: Profile = B, readonly = false) => original.connect(profile, readonly)
      const reopen = () => { if (B.db.open) B.db.close(); B.db = connect(B); return B.db }
      const f = bindBoth({ ...original, A, B, host: groupHost, sourceBlock, command, ack, islands: [alpha], exchange, connect, reopen })
      assert.equal((B.db.prepare('SELECT count(*) AS n FROM database_entities WHERE document_id=?').get(alpha) as { n: number }).n, 3)
      await run({ ...f, sourceStore, localStore, alpha, originalBodyId, sourceGroupId: ack.createdLifecycle.groupId,
        defaultColumn: defaultColumn.id, nullableColumn: nullableColumn.id, missingColumn: emptyColumn.id,
        customColumns: customColumns.map(column => column.id), customDatabases: customDatabases.map(database => database.id), standalone: standalone.id })
    } finally { localStore.destroy(); sourceStore.destroy() }
  })
}

export function renameBody(store: KnowbookStore, id: string, title: string, text: string) {
  const before = store.getDocumentDetail(id)
  assert.ok(before, 'A pre-opened actual Main Store reads its ordinary document before the supported title/content edit')
  store.updateDocument(id, { title, summary: before.summary, blocks: before.blocks.map(block => block.type === 'paragraph' ? { ...block, content: text } : block) })
}
