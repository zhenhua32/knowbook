import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { EditorRecoveryDraftRepository, parseEditorRecoveryDraftWrite } from '../src/main/editor-recovery-drafts'
import type { EditorRecoveryDraftInput, EditorRecoveryDraftVersion } from '../src/shared/editor-recovery-drafts'

test('recovery checkpoints survive reopening and CAS discard without replaying old generations', () => {
  const storage = mkdtempSync(join(tmpdir(), 'knowbook-editor-recovery-'))
  const workspace = { workspaceScope: randomUUID(), recoveryEpoch: randomUUID() }
  const nextWorkspace = { ...workspace, recoveryEpoch: randomUUID() }
  const payload = '源文本\r\n\uD800\n {"pending":{"operationId":"original","requestHash":"exact"}}'
  const record: EditorRecoveryDraftInput = { draftSessionId: randomUUID(), generation: 1, kind: 'source', targetId: 'source:原件', payload }
  const write = (records: EditorRecoveryDraftInput[]) => parseEditorRecoveryDraftWrite({ workspace, records })
  const drafts = new EditorRecoveryDraftRepository(storage)
  try {
    assert.deepEqual(drafts.list(), [])
    assert.equal(existsSync(join(storage, 'recovery')), false)
    const first = drafts.write(write([record]), workspace).records[0]
    assert.deepEqual(drafts.write(write([record]), workspace).records, [first])
    assert.equal(drafts.confirm(workspace, [first]), true)
    assert.equal(drafts.confirm(nextWorkspace, [first]), false)
    assert.throws(() => drafts.write(write([{ ...record, generation: 2 }]), nextWorkspace), /workspace changed/)
    assert.throws(() => drafts.write(write([
      { ...record, targetId: 'different' }, { ...record, payload: 'conflicting same generation' }
    ]), workspace), /stale or already used/)
    assert.equal(drafts.list().length, 1, 'The complete batch rolls back when any version conflicts')
    drafts.close()

    const saved = drafts.read(first.recordId)!
    assert.equal(saved.payload, payload)
    assert.deepEqual(saved.workspace, workspace)
    assert.equal(saved.targetId, record.targetId)
    const latest = drafts.write(write([{ ...record, generation: 2, payload: 'later input' }]), workspace).records[0]
    assert.equal(latest.recordId, first.recordId)
    assert.equal(drafts.confirm(workspace, [first]), false)
    assert.equal(drafts.confirm(workspace, [latest]), true)
    assert.equal(drafts.discard({ recordId: first.recordId, generation: first.generation, hash: first.hash }), false)
    assert.equal(drafts.discard({ recordId: latest.recordId, generation: latest.generation, hash: first.hash }), false)
    assert.equal(drafts.discard({ recordId: latest.recordId, generation: latest.generation, hash: latest.hash }), true)
    assert.equal(drafts.read(first.recordId), null)
    assert.deepEqual(drafts.list(), [])
    assert.throws(() => drafts.write(write([{ ...record, generation: 2, payload: 'later input' }]), workspace), /stale or already used/)
  } finally { drafts.close(); rmSync(storage, { force: true, recursive: true }) }
})

test('a checkpoint acknowledged by another process survives its forced exit without closing SQLite', async () => {
  const storage = mkdtempSync(join(tmpdir(), 'knowbook-editor-recovery-crash-'))
  const workspace = { workspaceScope: randomUUID(), recoveryEpoch: randomUUID() }
  const payload = '完全保留的草稿和原 nonce\r\n', draftSessionId = randomUUID()
  const source = `
    import { EditorRecoveryDraftRepository } from ${JSON.stringify(new URL('../src/main/editor-recovery-drafts.ts', import.meta.url).href)};
    const storage = process.argv[1];
    const input = ${JSON.stringify({ workspace, records: [{ payload, draftSessionId, generation: 1, kind: 'document', targetId: 'doc' }] })};
    const repository = new EditorRecoveryDraftRepository(storage);
    process.stdout.write(JSON.stringify(repository.write(input, input.workspace).records[0]) + '\\n');
    setInterval(() => {}, 1000);`
  const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, storage], {
    windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'inherit']
  })
  const ended = once(worker, 'exit'), output = createInterface({ input: worker.stdout })
  const drafts = new EditorRecoveryDraftRepository(storage)
  try {
    const [line] = await Promise.race([once(output, 'line'), ended.then(() => { throw new Error('Draft writer exited before acknowledging the commit.') })])
    const receipt = JSON.parse(line) as EditorRecoveryDraftVersion
    assert.equal(worker.kill('SIGKILL'), true)
    const [code, signal] = await ended
    assert.ok(signal === 'SIGKILL' || code !== 0, 'The writer did not run a clean close')
    assert.equal(drafts.read(receipt.recordId)?.payload, payload)
    assert.equal(drafts.confirm(workspace, [receipt]), true)
  } finally {
    output.close()
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    try { await ended } finally { drafts.close(); rmSync(storage, { force: true, recursive: true }) }
  }
})
