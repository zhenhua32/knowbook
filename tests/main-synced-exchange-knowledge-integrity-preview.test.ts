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

test('actual knowledge preview index bytes are required for both public selection modes and cannot be repaired from remembered public facts', async () => {
  for (const mode of ['choice', 'both'] as const) await withKnowledge(async f => {
    const original = await selected(f, mode), key = indexKey(mode, original.previewId)
    const row = f.B.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined
    assert.ok(row, 'The new Main writer produced its own exact private format2 index for the actual preview')
    const changed = JSON.parse(row.value) as { version: number; previewHash: string }
    assert.equal(changed.version, 2); changed.previewHash = flip(changed.previewHash)
    f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(changed), key)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => original.execute(), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before); unchangedDenial(f)
  })
})

test('coexisting old and knowledge private indexes for the same real preview ID are refused before HTTP instead of choosing whichever appears usable', async () => {
  for (const mode of ['choice', 'both'] as const) await withKnowledge(async f => {
    const original = await selected(f, mode), key = indexKey(mode, original.previewId)
    const row = f.B.db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(key) as { value: string; updated_at: string } | undefined
    assert.ok(row, 'The dual-index bad input starts with a genuine new private index')
    const old = JSON.parse(row.value) as { version: number }; old.version = 1
    f.B.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(indexKey(mode, original.previewId, 1), encode(old), row.updated_at)
    const before = allTables(f.B.db), requests = f.server.requests.length
    await rejected(() => original.execute(), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before); unchangedDenial(f)
  })
})
