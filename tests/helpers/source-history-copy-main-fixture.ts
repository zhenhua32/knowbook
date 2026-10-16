import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { EditorState } from '@codemirror/state'
import type { SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedGroupSaved,
  SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../../src/shared/synced-blocks'
import { captureSyncedGroupBindings } from '../../src/main/database/synced-block-links'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, validateSyncedReadOwner,
  releaseSyncedReadOwner } from '../../src/main/database/synced-binding-sources'
import { getSyncedGroupSnapshots } from '../../src/main/database/synced-blocks-read'
import { getSyncedOperation, updateSyncedBlockGroup, restoreSyncedGroupOperation } from '../../src/main/database/synced-blocks-content'
import { installSyncedLifecycleSchema } from '../../src/main/database/synced-lifecycle-schema'
import { getSyncedWorkspaceController, type SyncedControllerOptions } from '../../src/renderer/src/features/synced-blocks/controller'
import { openSyncedSourceCheckpoint, prepareSourceCheckpoint, applyPreparedSourceCheckpoint, readPreparedSourceCheckpoint,
  createCanonicalSourceLedgerSession, openSyncedSourceReadOwner, adoptSyncedSourceBaseline, adoptSyncedAcceptedSource,
  readAdoptedSourceSide, type SourceReadOwner, type SourceLedgerDraft } from '../../src/renderer/src/features/synced-blocks/sourceLedger'
import { markdownSourceEditorText } from '../../src/renderer/src/utils/markdownSourceSession'
import type { SyncedGroupBinding, SyncedGroupScope } from '../../src/renderer/src/features/synced-blocks/types'
import { born, now, host, other, groupId, initialize, snapshot } from './synced-content-fixture'

export { host, other, groupId, snapshot }
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
export const keyId = (key: SyncedBindingKey) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
type ReadPort = NonNullable<SyncedControllerOptions['readSources']>

/** Every successful writer/lookup is the real Main implementation. Hooks alter
 * transport timing or explicitly fail before Main; they never fabricate ACKs. */
export class HistoryMainApi implements SyncedBlocksApi {
  readonly writes: SyncedUpdateGroupInput[] = []
  readonly lookups: string[] = []
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  beforeWrite: (input: SyncedUpdateGroupInput) => Promise<void> = async () => {}
  wireInput = (input: SyncedUpdateGroupInput): SyncedUpdateGroupInput => input
  deliver: (ack: SyncedGroupSaved) => Promise<SyncedGroupSaved> = async ack => ack
  lookupDelivery: (value: ReturnType<typeof getSyncedOperation>) => Promise<ReturnType<typeof getSyncedOperation>> = async value => value
  snapshotReply = (value: ReturnType<typeof getSyncedGroupSnapshots>) => value
  constructor(public db: Database.Database) {}
  async getSyncedGroupSnapshots(input: { groupIds: string[] }) { return this.snapshotReply(getSyncedGroupSnapshots(this.db, input)) }
  async listSyncedGroups() { return { items: [], total: 0 } }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) {
    this.writes.push(structuredClone(input)); await this.beforeWrite(input)
    const result = updateSyncedBlockGroup(this.db, this.wireInput(input))
    return 'snapshot' in result ? this.deliver(result) : result
  }
  async getSyncedOperation(input: { clientOperationId: string }) {
    this.lookups.push(input.clientOperationId); return this.lookupDelivery(getSyncedOperation(this.db, input))
  }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput) { return restoreSyncedGroupOperation(this.db, input) }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> { throw new Error('No structure writer in this fixture') }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> { throw new Error('No host history in this fixture') }
  async getSyncedHostHistory(): ReturnType<SyncedBlocksApi['getSyncedHostHistory']> { throw new Error('No host history in this fixture') }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

export async function withHistoryMain(run: (api: HistoryMainApi) => Promise<void>, content = '[A](Target.md) and [B](Target.md)') {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-source-copy-')), db = new Database(join(directory, 'main.db'))
  try {
    initialize(db)
    db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
    const initial = snapshot(db), blocks = [{ ...initial.blocks[0], content }]
    const bindings = captureSyncedGroupBindings(db, initial.origin, blocks)
    if (bindings.length === 2) bindings[1].target = { kind: 'document', id: host, state: 'live' }
    db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(content, groupId)
    db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
    db.pragma('user_version=26')
    db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
    await run(new HistoryMainApi(db))
  } finally {
    if (db.open) db.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('knowbook-source-copy-'), 'Only this fixture temporary directory is removed')
    rmSync(directory, { recursive: true, force: true })
  }
}
export function replaceTarget(api: HistoryMainApi): string {
  api.db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', other)
  const id = randomUUID()
  api.db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'Target', id, 'Original/Target', born, now)
  return id
}
export function mainSources(api: HistoryMainApi) {
  const captures: Array<Extract<ReturnType<typeof captureSyncedBaselineOwner>, { status: 'ready' }>> = []
  const validations: string[] = [], operations: string[] = [], releases: string[] = []
  const hooks = {
    validate: async (value: ReturnType<typeof validateSyncedReadOwner>) => value,
    capture: async (value: ReturnType<typeof captureSyncedBaselineOwner>) => value
  }
  const port: ReadPort = {
    captureBaseline: async input => {
      const result = captureSyncedBaselineOwner(api.db, input)
      if (result.status === 'ready') captures.push(structuredClone(result))
      return hooks.capture(result)
    },
    operation: async input => { operations.push(input.clientOperationId); return getSyncedOperationWithOwnedLinkSource(api.db, input) },
    validate: async input => { validations.push(input.readOwnerId); return hooks.validate(validateSyncedReadOwner(api.db, input)) },
    release: async input => { releases.push(input.readOwnerId); releaseSyncedReadOwner(api.db, input) }
  }
  return { port, captures, validations, operations, releases, hooks }
}
export function sourceSession(binding: SyncedGroupBinding) {
  const opened = openSyncedSourceCheckpoint(binding)
  assert.ok(opened, 'The real registered controller opens this Source checkpoint')
  const session = createCanonicalSourceLedgerSession({ draft: opened.draft })
  let state = EditorState.create({ doc: markdownSourceEditorText(opened.draft.source), extensions: session.extension })
  const edit = (from: number, to: number, insert: string) => {
    state = state.update({ changes: { from, to, insert } }).state; return session.read(state)
  }
  const prepare = (draft: SourceLedgerDraft, owner?: SourceReadOwner) => {
    const result = prepareSourceCheckpoint({ checkpoint: opened.checkpoint, draft, ...(owner ? { historyOwner: owner } : {}) })
    assert.equal(result.status, 'prepared', 'This real descendant has complete original source witnesses')
    if (result.status !== 'prepared') throw new Error('Fixture requires a prepared Source descendant')
    return result.preparation
  }
  const apply = (draft: SourceLedgerDraft, transactionId: string = randomUUID(), owner?: SourceReadOwner) => {
    const preparation = prepare(draft, owner), result = applyPreparedSourceCheckpoint({ preparation, transactionId })
    assert.equal(result.status, 'accepted', 'The real controller accepts this exact preparation')
    if (result.status !== 'accepted') throw new Error('Fixture requires actual Source acceptance')
    return { preparation, accepted: result.accepted, facts: readPreparedSourceCheckpoint(preparation) }
  }
  const replay = (draft: SourceLedgerDraft) => {
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdownSourceEditorText(draft.source) },
      annotations: session.replay.of(draft) }).state
    return session.read(state)
  }
  return { ...opened, edit, prepare, apply, replay, current: () => session.read(state),
    replace: (text: string) => edit(0, state.doc.length, text), append: (text: string) => edit(state.doc.length, state.doc.length, text) }
}
export async function setup(api: HistoryMainApi, reads = mainSources(api)) {
  const workspace = getSyncedWorkspaceController(api, { readSources: reads.port }); await workspace.load([groupId])
  const controller = workspace.getGroup(groupId)
  assert.ok(controller, 'The actual Main baseline registers its workspace group')
  let callout = () => {}
  const scope: SyncedGroupScope = { owner: { kind: 'synced-group', groupId }, ...controller.getSnapshot().snapshot.instances[0],
    windowSessionId: randomUUID(), hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: 'source-copy-fixture',
    root: () => null, isCurrent: () => { callout(); return true } }
  const binding = controller.bind(scope), source = sourceSession(binding)
  return { workspace, controller, binding, source, reads, scope, callout: (next: () => void) => { callout = next } }
}
export async function sourceOwner(source: ReturnType<typeof sourceSession>) {
  const owner = await openSyncedSourceReadOwner(source.checkpoint)
  assert.ok(owner, 'The original initial Main owned read supplies this checkpoint consumer')
  return owner
}
export function adopted(result: Awaited<ReturnType<typeof adoptSyncedSourceBaseline>> | Awaited<ReturnType<typeof adoptSyncedAcceptedSource>>) {
  assert.equal(result.status, 'adopted')
  if (result.status !== 'adopted') throw new Error('Fixture requires an actual privately adopted side')
  const facts = readAdoptedSourceSide(result.side)
  assert.ok(facts, 'Only an actual opaque adopted side supplies original Main facts')
  return { side: result.side, facts }
}
