import assert from 'node:assert/strict'
import test from 'node:test'
import { withBothCatalog, renameBody } from './helpers/synced-exchange-both-catalog-fixture'
import { withBoth, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary, overlappingGroup,
  completed, executionRows, localPortable, remoteActual, stateRow, readonlyRequests, rejected, mutateRemote, randomUUID } from './helpers/synced-exchange-both-fixture'

test('actual both selectors cannot omit a required local document closure or smuggle caller candidate IDs and getters into execution', () => withBothCatalog(async f => {
  renameBody(f.sourceStore, f.alpha, 'REMOTE selector title', 'REMOTE selector body'); completed(await f.exchange(f.A), 'applied')
  renameBody(f.localStore, f.alpha, 'LOCAL selector title', 'LOCAL selector body')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'doc:' + f.alpha), valid = selectBoth(c)
  assert.ok(c.copyDocuments.some(doc => doc.sourceDocumentId === f.alpha && doc.required), 'The original preview explicitly requires the exact local document copy')
  const before = executionRows(f.B), baseline = stateRow(f.B.db).value, local = localPortable(f.B).entries, remote = remoteActual(f).bytes
  let getterReads = 0
  const invalid: unknown[] = [
    [{ ...valid, copyDocumentIds: [] }],
    [{ ...valid, copyDocumentIds: [...valid.copyDocumentIds, randomUUID()] }],
    [{ ...valid, copyDocumentIds: [valid.copyDocumentIds[0], valid.copyDocumentIds[0]] }],
    [{ ...valid, documentId: randomUUID() }],
    [{ ...valid, allocation: { groups: [] } }],
    [{ ...valid, get copyDocumentIds() { getterReads++; return valid.copyDocumentIds } }]
  ]
  for (const decisions of invalid) {
    const start = f.server.requests.length
    await rejected(() => f.resolveBoth(p, decisions as never), 'invalid')
    readonlyRequests(f.server.requests.slice(start))
    assert.deepEqual(executionRows(f.B), before); assert.equal(stateRow(f.B.db).value, baseline)
    assert.deepEqual(localPortable(f.B).entries, local); assert.deepEqual(remoteActual(f).bytes, remote)
  }
  assert.equal(getterReads, 0, 'Descriptor validation refuses caller accessors without executing them')
}))

test('actual both preview preserves the entire 500-unit source title and installs only its displayed compact fresh-UUID destination', () => withBothCatalog(async f => {
  renameBody(f.sourceStore, f.alpha, 'REMOTE full source title', 'REMOTE full source body'); completed(await f.exchange(f.A), 'applied')
  const sourceTitle = '长'.repeat(500)
  renameBody(f.localStore, f.alpha, sourceTitle, 'LOCAL complete source title body')
  assert.equal(f.localStore.getDocumentDetail(f.alpha)?.title, sourceTitle, 'The real Main writer stores the complete legal 500-unit local source title')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'doc:' + f.alpha), shown = c.copyDocuments.find(doc => doc.sourceDocumentId === f.alpha)
  assert.ok(shown, 'The exact source document has a fully displayed candidate destination')
  assert.equal(shown.sourceTitle, sourceTitle); assert.ok(shown.title.length <= 500 && shown.title === shown.title.trim(), 'The proposed destination meets the same real title semantics')
  assert.ok(shown.title.includes(shown.documentId), 'The compact candidate contains its entire fresh UUID instead of clipping the original title to 450')
  assert.equal(shown.parentId, null); assert.equal(shown.path, shown.title)
  const accepted = acceptedBoth(await f.resolveBoth(p, [selectBoth(c)])), summary = forkSummary(accepted, c.componentId), copy = summary.documents.find(doc => doc.sourceDocumentId === f.alpha)
  assert.ok(copy, 'The installed result is bound to the original displayed destination')
  assert.deepEqual(copy, { sourceDocumentId: f.alpha, documentId: shown.documentId, title: shown.title, parentId: shown.parentId, path: shown.path })
  const actual = f.localStore.getDocumentDetail(copy.documentId)
  assert.ok(actual, 'The copied host is an actual persisted document')
  assert.equal(actual.title, shown.title); assert.equal(actual.path, shown.path); assert.equal(actual.blocks[0].content, 'LOCAL complete source title body')
}))

test('actual both keeps a different-incarnation remote group blocked rather than treating both as immutable tuple replacement permission', () => withBoth(async f => {
  const id = await overlappingGroup(f), before = localPortable(f.B).entries, baseline = stateRow(f.B.db).value
  // Negative remote-wire fixture derived from an actual published object. It is
  // not a fabricated SQL success, receipt, or a claim that a writer accepted it.
  mutateRemote(f.server, f.targetConfig.directory, 'group:' + id, record => { record.creationId = randomUUID() })
  const remote = remoteActual(f).bytes, p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id)
  assert.equal(c.reason, 'incarnation'); assert.deepEqual(c.choices, [])
  assert.deepEqual(localPortable(f.B).entries, before); assert.equal(stateRow(f.B.db).value, baseline); assert.deepEqual(remoteActual(f).bytes, remote)
}))
