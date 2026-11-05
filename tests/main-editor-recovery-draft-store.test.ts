import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { validateEditorRecoveryDraftInput, type EditorRecoveryBase, type EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-cr-store-')), directory = join(root, 'recovery'), store = new EditorRecoveryDraftStore(directory)
  const base: EditorRecoveryBase = { workspaceScope: randomUUID(), recoveryEpoch: randomUUID(), owner: { kind: 'host', documentId: '原文档',
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:01.000Z' }, persistedWorking: {
      kind: 'host', title: 'Persisted title', summary: '', blocks: [{ id: '原块', type: 'paragraph', content: 'persisted P', checked: false, depth: 0, parentBlockId: null }] }, originals: [] }
  const source = '未Apply\r\n汉字\u0000\ud800 literal <div>'
  const draft: EditorRecoveryDraftInput = { draftSessionId: randomUUID(), generation: 1, expectedPreviousGeneration: 0,
    working: { kind: 'host', title: '未保存的标题', summary: '\r\n摘要 ', blocks: [{ id: '原块', type: 'paragraph', content: 'complete W\r\n\udfff', checked: false, depth: 0, parentBlockId: null, tags: [] }] },
    sources: [{ sourceId: randomUUID(), kind: 'ordinary-host', openingSource: 'opening', acceptedSource: 'opening', source,
      selection: { anchor: 2, head: source.length }, composing: false, applying: false, importing: false }],
    pending: [], selection: { blockId: '原块', anchor: 0, head: 5 }, composing: false, importing: false }
  return { root, directory, store, base, draft, close() { store.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('private draft store durably preserves complete W, unapplied exact UTF16 Source and selection in an independent cold process without a business write permit', () => {
  const f = fixture()
  try {
    const receipt = f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' }), item = receipt.records[0]
    assert.equal(receipt.requestId, null); assert.equal(receipt.closeGeneration, null)
    assert.deepEqual(f.store.read(item).draft, f.draft)
    f.store.close()
    const runner = join(f.root, 'cold.cjs'), expected = { ...item, directory: f.directory }
    writeFileSync(runner, `const {EditorRecoveryDraftStore}=require(${JSON.stringify(resolve('src/main/editor-recovery/draft-store.ts'))});const input=JSON.parse(process.argv[2]);const store=new EditorRecoveryDraftStore(input.directory,{readonly:true});try{process.stdout.write(JSON.stringify(store.read(input)))}finally{store.close()}`)
    const output = execFileSync(process.execPath, ['--import', 'tsx', runner, JSON.stringify(expected)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000, encoding: 'utf8', windowsHide: true })
    const cold = JSON.parse(output)
    assert.deepEqual(cold.base, f.base); assert.deepEqual(cold.draft, f.draft)
    assert.equal(cold.writePermit, false); assert.equal(cold.businessOperationCommitted, false)
  } finally { f.close() }
})

test('generation CAS and an old decision cannot overwrite or discard later complete W/Source, while same-generation exact replay keeps one immutable record', () => {
  const f = fixture()
  try {
    const first = f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' }).records[0]
    const replay = f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' }).records[0]
    assert.deepEqual(replay, first)
    const different = structuredClone(f.draft); different.sources[0].source += 'X'
    assert.throws(() => f.store.write([{ base: f.base, draft: different }], { kind: 'background' }), /different complete capture/)
    const next = structuredClone(f.draft); next.generation = 2; next.expectedPreviousGeneration = 1; next.sources[0].source += '后续C'
    const second = f.store.write([{ base: f.base, draft: next }], { kind: 'close', requestId: randomUUID(), closeGeneration: 7 })
    assert.equal(second.purpose, 'close'); assert.equal(second.closeGeneration, 7)
    assert.throws(() => f.store.decide(first, 'discard'), /old decision/)
    assert.deepEqual(f.store.read(second.records[0]).draft, next)
    assert.throws(() => f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' }), /stale capture/)
    assert.deepEqual(f.store.list({ limit: 100 }).records.map(item => item.recordId), [second.records[0].recordId])
    f.store.decide(second.records[0], 'discard')
    assert.equal(f.store.list({ limit: 100 }).records.length, 0)
    assert.equal(f.store.head(next.draftSessionId), null)
    assert.throws(() => f.store.readReceipt(second.receiptId, true), /latest head/)
    assert.throws(() => f.store.decide(second.records[0], 'restore-draft'), /old decision cannot affect newer draft/)
    assert.equal(f.store.head(next.draftSessionId), null)
  } finally { f.close() }
})

test('sealed B is stored once and obsolete generations and receipt dependencies are collected while the current generation stays independently readable', () => {
  const f = fixture()
  try {
    if (f.base.persistedWorking.kind === 'host') f.base.persistedWorking.blocks[0].content = 'large original B\r\n'.repeat(12_000)
    const pointer = f.store.sealBase(f.base), db = (f.store as unknown as { db: Database.Database }).db
    let previous: ReturnType<EditorRecoveryDraftStore['write']>['records'][number] | null = null
    for (let generation = 1; generation <= 30; generation++) {
      const draft = structuredClone(f.draft); draft.generation = generation; draft.expectedPreviousGeneration = generation - 1
      draft.sources[0].source += String(generation)
      const receipt = f.store.write([{ base: pointer, draft }], { kind: 'background' })
      f.store.collectGarbage([pointer.baseId], [receipt.receiptId])
      assert.equal((db.prepare('SELECT count(*) AS n FROM recovery_bases').get() as { n: number }).n, 1)
      assert.equal((db.prepare('SELECT count(*) AS n FROM recovery_records').get() as { n: number }).n, 1)
      assert.equal((db.prepare('SELECT count(*) AS n FROM recovery_receipts').get() as { n: number }).n, 1)
      assert.ok((db.prepare('SELECT length(payload) AS n FROM recovery_records').get() as { n: number }).n < 10_000, 'generation body does not embed static large B')
      assert.deepEqual(f.store.read(receipt.records[0]).base, f.base)
      assert.deepEqual(f.store.read(receipt.records[0]).draft, draft)
      if (previous) assert.throws(() => f.store.decide(previous!, 'discard'), /absent|old|unavailable/)
      previous = receipt.records[0]
    }
    const cold = new EditorRecoveryDraftStore(f.directory, { readonly: true })
    try { assert.equal(cold.read(previous!).draft.generation, 30) } finally { cold.close() }
    f.store.decide(previous!, 'discard'); f.store.collectGarbage([])
    for (const table of ['recovery_records', 'recovery_receipts', 'recovery_receipt_records', 'recovery_bases']) {
      assert.equal((db.prepare('SELECT count(*) AS n FROM ' + table).get() as { n: number }).n, 0)
    }
  } finally { f.close() }
})

test('a real TEMP SQLite receipt failure rolls back all new draft heads and records and returns no receipt; removing only that trigger admits the same original capture once', () => {
  const f = fixture()
  try {
    // Fault injection accesses only this test's private side-store connection.
    // TEMP trigger does not change the sealed main sqlite_schema contract.
    const db = (f.store as unknown as { db: Database.Database }).db
    db.exec("CREATE TEMP TRIGGER receipt_failure BEFORE INSERT ON recovery_receipts BEGIN SELECT RAISE(ABORT,'real injected receipt failure'); END")
    const before = ['recovery_bases', 'recovery_records', 'recovery_heads', 'recovery_receipts', 'recovery_receipt_records', 'recovery_decisions'].map(table => db.prepare('SELECT * FROM ' + table).all())
    assert.throws(() => f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' }), /real injected receipt failure/)
    assert.equal(db.inTransaction, false)
    assert.deepEqual(['recovery_bases', 'recovery_records', 'recovery_heads', 'recovery_receipts', 'recovery_receipt_records', 'recovery_decisions'].map(table => db.prepare('SELECT * FROM ' + table).all()), before)
    // SQLite total_changes is not rolled back; no false zero-change claim.
    db.exec('DROP TRIGGER temp.receipt_failure')
    const receipt = f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' })
    assert.equal(receipt.records.length, 1)
    assert.equal((db.prepare('SELECT count(*) AS n FROM recovery_records').get() as { n: number }).n, 1)
  } finally { f.close() }
})

test('closed draft codec rejects getters, unknown fields, wrong Source coordinates and recursive incoming without invoking accessors or losing the previous durable draft', () => {
  const f = fixture()
  try {
    const item = f.store.write([{ base: f.base, draft: f.draft }], { kind: 'background' }).records[0]
    let invoked = 0
    const accessor = { ...f.draft }; Object.defineProperty(accessor, 'working', { enumerable: true, get() { invoked++; return f.draft.working } })
    assert.throws(() => validateEditorRecoveryDraftInput(accessor), /accessor/); assert.equal(invoked, 0)
    assert.throws(() => validateEditorRecoveryDraftInput({ ...f.draft, writePermit: true }), /closed fields/)
    const outside = structuredClone(f.draft); outside.sources[0].selection.head = outside.sources[0].source.length + 1
    assert.throws(() => validateEditorRecoveryDraftInput(outside), /outside exact UTF16/)
    const recursive: { kind: 'group'; blocks: []; incoming: unknown } = { kind: 'group', blocks: [], incoming: null }; recursive.incoming = recursive
    assert.throws(() => validateEditorRecoveryDraftInput({ ...f.draft, working: recursive }), /recursive incoming/)
    assert.deepEqual(f.store.read(item).draft, f.draft)
  } finally { f.close() }
})
