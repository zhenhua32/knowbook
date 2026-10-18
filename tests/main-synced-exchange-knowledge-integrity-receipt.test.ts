import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withKnowledge, divergeGroup, ready, component, side, readyBoth, bothComponent, selectBoth, acceptedBoth,
  completed, unchangedDenial, allTables, rejected, storedReceipt, jobForReceipt, randomUUID, encode, hash, flip,
  state, type Fixture } from './helpers/synced-exchange-knowledge-fixture'

type Mode = 'choice' | 'both'
async function selected(f: Fixture, mode: Mode) {
  const conflict = await divergeGroup(f)
  if (mode === 'choice') {
    const p = ready(await f.preview()), decision = side(component(p, conflict.key), 'local')
    return { previewId: p.previewId, execute: (operationId: string = randomUUID()) => f.resolve(p, [decision], operationId) }
  }
  const p = readyBoth(await f.previewBoth()), decision = selectBoth(bothComponent(p, conflict.key), { copies: [], hosts: 'none' })
  return { previewId: p.previewId, execute: (operationId: string = randomUUID()) => f.resolveBoth(p, [decision], operationId) }
}
function indexKey(mode: Mode, id: string, version: 1 | 2 = 2) { return 'sync.webdav.protocol5.' + (mode === 'choice' ? 'exchange-preview' : 'exchange-both-preview') + '.v' + version + '.' + id }

test('the exact new private preview file is indispensable and modified source bytes cannot be replaced by a fresh current component capture', async () => {
  for (const mode of ['choice', 'both'] as const) await withKnowledge(async f => {
    const original = await selected(f, mode), file = join(f.B.root, 'storage', mode === 'choice' ? 'synced-exchange-previews-v2' : 'synced-exchange-both-previews-v2', original.previewId, 'preview.json')
    const bytes = readFileSync(file), value = JSON.parse(bytes.toString()) as { version: number; localFingerprint: string }
    assert.equal(value.version, 2); assert.match(value.localFingerprint, /^[a-f0-9]{64}$/)
    value.localFingerprint = flip(value.localFingerprint); writeFileSync(file, encode(value))
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => original.execute(), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
    assert.notEqual(hash(readFileSync(file)), hash(bytes), 'Rejection leaves the actual corrupted private file available as evidence rather than silently repairing it')
    unchangedDenial(f)
  })
})

test('a real successful format5 or format6 cannot launder a jointly changed receipt job knowledge hash or rewritten knowledge source past its original historical phase chain', async () => {
  for (const mode of ['choice', 'both'] as const) for (const fault of ['joint-hash', 'joint-source'] as const) await withKnowledge(async f => {
    const selection = await selected(f, mode), operationId = randomUUID(), result = await selection.execute(operationId)
    if (mode === 'choice') completed(result as Awaited<ReturnType<typeof f.resolve>>)
    else acceptedBoth(result as Awaited<ReturnType<typeof f.resolveBoth>>)
    const receipt = storedReceipt(f.B.db, operationId, mode === 'choice' ? 5 : 6), originalJob = jobForReceipt(f.B.db, operationId, receipt.value.provenance.attemptId)
    const job = JSON.parse(originalJob.value) as { version: number; knowledgeHash: string; knowledgeSource: { deleted: unknown[]; absentBaseline: unknown[] } }
    assert.equal(job.version, mode === 'choice' ? 5 : 6); assert.equal(job.knowledgeHash, receipt.value.provenance.knowledgeHash)
    assert.ok(job.knowledgeSource.deleted.length > 0 && job.knowledgeSource.absentBaseline.length > 0, 'The actual historical job owns the complete original authenticated knowledge preimage')
    if (fault === 'joint-source') {
      job.knowledgeSource.deleted = []; job.knowledgeSource.absentBaseline = []
      job.knowledgeHash = hash(encode(job.knowledgeSource))
    } else job.knowledgeHash = flip(job.knowledgeHash)
    receipt.value.provenance.knowledgeHash = job.knowledgeHash
    const before = allTables(f.B.db)
    f.B.db.transaction(() => {
      f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(job), originalJob.key)
      f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(receipt.value), operationId)
    })()
    const corrupted = allTables(f.B.db), without = (tables: ReturnType<typeof allTables>) => ({ ...tables,
      app_settings: (tables.app_settings as Array<{ key: string }>).filter(row => row.key !== originalJob.key),
      synced_operations: (tables.synced_operations as Array<{ client_operation_id: string }>).filter(row => row.client_operation_id !== operationId) })
    assert.deepEqual(without(corrupted), without(before), 'Only the jointly edited JSON facts changed; original phase head inputs state proofs and all physical rows remain exact')
    const requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => selection.execute(operationId), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), corrupted)
    unchangedDenial(f)
  })
})

test('a successful knowledge selection still authenticates the entire carried absence set and cannot forget one whole baseline row before its next exchange', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  completed(await f.resolve(p, [side(c, 'remote')], operationId), 'applied'); storedReceipt(f.B.db, operationId, 5)
  const original = state(f.B.db), changed = structuredClone(original.parsed)
  assert.ok(changed.baseline.some(row => row.key === f.denialKey), 'The genuine successful operation carried the original absent record into its exact next state')
  changed.baseline = changed.baseline.filter(row => row.key !== f.denialKey)
  f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(changed), original.key)
  const before = allTables(f.B.db), requests = f.server.requests.length
  f.reopenPeer(); await rejected(() => f.exchange(), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
}))
