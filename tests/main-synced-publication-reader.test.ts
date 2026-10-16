import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SYNCED_GROUP_MAX_BYTES } from '../src/shared/syncedBlockValidation'
import { withPublicationFixture, prepared, facts, remote, rejectedCode, runtime, encode, hash, contentRequests,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, publishInitialSyncedPublication,
  queryInitialSyncedPublication,
  created, createRequest, applySyncedHostCommand, bodyId, a, b, customId, savedViewId,
  allTables, totalChanges, copy, now } from './helpers/synced-publication-fixture'

const manifestPath = '/Publication/manifest.json'
type Fixture = Parameters<Parameters<typeof withPublicationFixture>[0]>[0]
type RawRecord = Record<string, any> // Explicitly untrusted remote corruption fixtures only.
function manifest(f: Fixture): { version: number; workspaceId: string; entries: Record<string, string>; syncedInstances: Array<{ documentId: string; instanceId: string; groupId: string; groupHash: string }> } {
  const bytes = f.server.files.get(manifestPath); assert.ok(bytes, 'A real sender published the manifest before remote mutation'); return JSON.parse(bytes.toString())
}
function alterRecord(f: Fixture, key: string, change: (record: RawRecord) => RawRecord | void) {
  const value = manifest(f), original = value.entries[key], bytes = f.server.files.get('/Publication/objects/' + original + '.json')
  assert.ok(bytes, 'Remote mutation starts from an actual sender-generated object')
  const record = JSON.parse(bytes.toString()) as RawRecord, after = change(record) ?? record, next = Buffer.from(encode(after)), digest = hash(next)
  f.server.files.set('/Publication/objects/' + digest + '.json', next); value.entries[key] = digest
  if (key.startsWith('group:')) for (const instance of value.syncedInstances) if (instance.groupId === key.slice(6)) instance.groupHash = digest
  f.server.files.set(manifestPath, Buffer.from(encode(value)))
}
async function published(run: (f: Fixture, ownGroupId: string, handle: Awaited<ReturnType<typeof prepared>>) => Promise<void>) {
  return withPublicationFixture(async f => {
    const [asset] = await f.assets.import([{ name: 'reader original.png', bytes: Buffer.from('actual readonly asset bytes') }])
    f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('![image](<' + asset.url + '>) and [local](Host%20B.md)', bodyId(a))
    const creation = created(applySyncedHostCommand(f.db, createRequest(f.db))), handle = await prepared(f.db, f.input())
    assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed')
    await run(f, creation.createdLifecycle.groupId, handle)
  })
}
async function invalidReadWithoutSql(f: Fixture) {
  const before = allTables(f.db), changes = totalChanges(f.db), start = f.server.requests.length
  await rejectedCode(() => readSyncedPublishedSnapshot(f.client()), 'invalid')
  assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes)
  assert.ok(f.server.requests.slice(start).every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'A strict network read never probes capabilities or performs content writes')
}

test('the actual Manifest5 strict reader roundtrips closed opaque IDs all groups instances portable bytes and readonly frozen facts', () => published(async (f, own) => {
  const before = allTables(f.db), changes = totalChanges(f.db), start = f.server.requests.length, read = await remote(f.client()), value = read.facts.manifest
  assert.deepEqual(Object.keys(value).sort(), ['version', 'workspaceId', 'entries', 'syncedInstances'].sort()); assert.equal(value.version, 5)
  assert.ok(Object.hasOwn(value.entries, 'doc:' + a), 'The actual opaque original document identity is not rejected by the old validId regex')
  assert.ok(Object.hasOwn(value.entries, 'group:' + own), 'The real create group is a direct GroupWire record')
  assert.equal(value.syncedInstances.length, read.facts.records.filter(item => item.record.kind === 'document').reduce((count, item) => item.record.kind === 'document' ? count + item.record.content.blocks.filter(block => block.type === 'synced-block').length : count, 0))
  assert.equal(Object.isFrozen(read.facts), true); assert.equal(Object.isFrozen(read.facts.manifest.entries), true)
  assert.equal(readSyncedPublishedSnapshotFacts({ ...read.facts } as never), null)
  for (const item of read.facts.records) { const bytes = f.server.files.get('/Publication/objects/' + item.hash + '.json'); assert.ok(bytes, 'Every remote fact references its exact actual HTTP object'); assert.equal(bytes.length, item.bytes); assert.equal(hash(bytes), item.hash); assert.equal(bytes.toString(), encode(item.record)) }
  assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes); assert.ok(f.server.requests.slice(start).every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'The successful reader performs only versioned reads')
}))

test('unsupported historical versions and finite tombstones do not silently become an initial Manifest5 plan or SQL authority', async () => {
  for (const kind of ['version4', 'version4-formatted', 'document-delete', 'group-delete'] as const) await published(async (f, own) => {
    if (kind === 'version4') { const value = manifest(f); value.version = 4; f.server.files.set(manifestPath, Buffer.from(encode(value))) }
    else if (kind === 'version4-formatted') f.server.files.set(manifestPath, Buffer.from(' { "workspaceId": "legacy_workspace", "entries": {}, "version": 4 }\n'))
    else if (kind === 'document-delete') alterRecord(f, 'doc:' + b, record => ({ kind: 'deleted', id: record.id }))
    else alterRecord(f, 'group:' + own, record => ({ kind: 'synced-group-deleted', id: record.id, creationId: record.creationId, previousHash: manifest(f).entries['group:' + own], deletedAt: now }))
    const before = allTables(f.db), changes = totalChanges(f.db), start = f.server.requests.length
    assert.deepEqual(await readSyncedPublishedSnapshot(f.client()), { status: 'unsupported', reason: 'initial-snapshot-only' })
    assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes); assert.ok(f.server.requests.slice(start).every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'Unsupported read formats grant no upload or installation rights')
    if (kind.startsWith('version4')) assert.equal(f.server.requests.slice(start).some(req => req.path.startsWith('/Publication/objects/')), false)
  })
})

test('real readonly versioned query and reader use HEAD or PROPFIND and conditional GET when ordinary GET lacks ETag', async () => {
  for (const mode of ['HEAD', 'PROPFIND'] as const) await published(async (f, _own, handle) => {
    f.server.setOptions({ omitGetEtag: true, omitHeadEtag: mode === 'PROPFIND' })
    const before = allTables(f.db), changes = totalChanges(f.db), start = f.server.requests.length
    assert.equal((await queryInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed'); await remote(f.client())
    const requests = f.server.requests.slice(start)
    assert.ok(requests.some(req => req.method === mode), 'The real versioned reader reaches the required readonly metadata branch')
    assert.ok(requests.some(req => req.method === 'GET' && req.ifMatch?.startsWith('"knowbook-missing-')), 'The real client proves that a mismatched conditional GET is rejected')
    assert.ok(requests.some(req => req.method === 'GET' && req.ifMatch && !req.ifMatch.startsWith('"knowbook-missing-')), 'The actual returned bytes are reread with the observed metadata version')
    assert.ok(requests.every(req => ['GET', 'HEAD', 'PROPFIND'].includes(req.method)), 'Metadata fallback never calls initialize test or a write/probe method')
    assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes)
  })
})

test('closed Manifest5 unknown keys duplicate JSON keys wrong Key hashes and unsorted or duplicate instances are refused', async () => {
  for (const kind of ['unknown-key', 'duplicate-json', 'missing-object', 'wrong-object-hash', 'extra-record-key', 'instance-duplicate', 'instance-missing', 'instance-hash', 'instance-order'] as const) await published(async (f, own) => {
    const value = manifest(f)
    if (kind === 'unknown-key') f.server.files.set(manifestPath, Buffer.from(encode({ ...value, recoveryEpoch: randomUUID() })))
    else if (kind === 'duplicate-json') f.server.files.set(manifestPath, Buffer.from('{"version":5,' + encode(value).slice(1)))
    else if (kind === 'missing-object') f.server.files.delete('/Publication/objects/' + value.entries['group:' + own] + '.json')
    else if (kind === 'wrong-object-hash') f.server.files.set('/Publication/objects/' + value.entries['group:' + own] + '.json', Buffer.from('{}'))
    else { if (kind === 'extra-record-key') value.entries['unknown:record'] = value.entries['group:' + own]
      if (kind === 'instance-duplicate') value.syncedInstances.push(copy(value.syncedInstances[0]))
      if (kind === 'instance-missing') value.syncedInstances.pop()
      if (kind === 'instance-hash') value.syncedInstances[0].groupHash = '0'.repeat(64)
      if (kind === 'instance-order') value.syncedInstances.reverse()
      f.server.files.set(manifestPath, Buffer.from(encode(value))) }
    await invalidReadWithoutSql(f)
  })
})

test('remote host or canonical shape owner Origin and exact parser binding Key corruption is rejected after hash recomputation', async () => {
  for (const kind of ['unknown-group-key', 'wire-CAS', 'binding-raw', 'binding-missing', 'binding-duplicate', 'binding-syntax', 'origin-extra', 'duplicate-owner', 'missing-group', 'host-cycle'] as const) await published(async (f, own) => {
    if (kind === 'duplicate-owner') {
      const value = manifest(f), group = JSON.parse(f.server.files.get('/Publication/objects/' + value.entries['group:' + own] + '.json')!.toString())
      alterRecord(f, 'doc:' + b, record => { const { createdAt: _birth, ...block } = group.blocks[0]; record.content.blocks.push(block) })
    } else if (kind === 'missing-group') { const value = manifest(f); delete value.entries['group:' + own]; f.server.files.set(manifestPath, Buffer.from(encode(value))) }
    else if (kind === 'host-cycle') alterRecord(f, 'doc:' + b, record => { record.parentId = record.id })
    else alterRecord(f, 'group:' + own, record => {
      if (kind === 'unknown-group-key') record.extra = true
      if (kind === 'wire-CAS') record.revision = randomUUID()
      if (kind === 'binding-raw') record.bindings[0].raw = 'a different equal-length substring'
      if (kind === 'binding-missing') record.bindings = []
      if (kind === 'binding-duplicate') record.bindings.push(copy(record.bindings[0]))
      if (kind === 'binding-syntax') record.bindings[0].syntax = 'url'
      if (kind === 'origin-extra') record.origin.owner = 'caller-authority'
    })
    await invalidReadWithoutSql(f)
  })
})

test('remote depth seven host and canonical forests are rejected under the original depth six gate after canonical hashes are recomputed', async () => {
  for (const kind of ['host', 'group'] as const) await published(async (f, own) => {
    alterRecord(f, kind === 'host' ? 'doc:' + b : 'group:' + own, record => {
      const chain = Array.from({ length: 8 }, (_, depth) => ({ id: ' remote:overdepth:' + depth, type: depth === 7 ? 'paragraph' : 'toggle', content: 'Remote overdepth', checked: false, depth,
        parentBlockId: depth ? ' remote:overdepth:' + (depth - 1) : null, ...(kind === 'group' ? { createdAt: now } : {}) }))
      if (kind === 'group') { record.blocks = chain; record.bindings = [] } else record.content.blocks = chain
    })
    await invalidReadWithoutSql(f)
  })
})

test('remote local file URLs unsafe portable spellings missing assets and mismatched real asset bytes never produce a ready plan', async () => {
  for (const kind of ['missing', 'wrong-bytes', 'uppercase-hash', 'dot-name', 'escaped-alias', 'query', 'local-file'] as const) await published(async (f, own) => {
    const asset = [...f.server.files.keys()].find(path => /\/assets\/[a-f0-9]{64}$/.test(path))!
    if (kind === 'missing') f.server.files.delete(asset)
    else if (kind === 'wrong-bytes') f.server.files.set(asset, Buffer.from('different bytes'))
    else alterRecord(f, 'group:' + own, record => {
      const block = record.blocks.find((block: RawRecord) => block.content.includes('knowbook-asset://')), current = /knowbook-asset:\/\/[^>\s)]+/.exec(block.content)![0]
      let next = current
      if (kind === 'uppercase-hash') next = current.replace(/^knowbook-asset:\/\/([a-f0-9]{64})/, (_all: string, digest: string) => 'knowbook-asset://' + digest.toUpperCase())
      if (kind === 'dot-name') next = current.replace(/\/[^/]+$/, '/..')
      if (kind === 'escaped-alias') next = current.replace(/\.png$/, '%2Epng')
      if (kind === 'query') next += '?not-canonical=1'
      if (kind === 'local-file') next = 'file:///outside/real-workspace.png'
      const delta = next.length - current.length, at = block.content.indexOf(current); block.content = block.content.slice(0, at) + next + block.content.slice(at + current.length)
      for (const binding of record.bindings) if (binding.blockId === block.id && binding.from > at) { binding.from += delta; binding.to += delta; binding.raw = block.content.slice(binding.from, binding.to) }
    })
    await invalidReadWithoutSql(f)
  })
})

test('database scalar and ASCII NOCASE saved-view uniqueness oracle follows real SQLite columns rather than generic SQL scalar permissiveness', async () => {
  for (const kind of ['database-name-null', 'database-description-number', 'entity-title-null', 'view-query-number', 'view-name-ASCII-collision', 'view-name-NUL-collision', 'duplicate-document-entity', 'unknown-column', 'foreign-column', 'broken-options'] as const) await published(async (f) => {
    alterRecord(f, 'databases', record => {
      const custom = record.tables.databases.find((row: RawRecord) => row.id === customId), view = record.tables.database_saved_views.find((row: RawRecord) => row.id === savedViewId)
      if (kind === 'database-name-null') custom.name = null
      if (kind === 'database-description-number') custom.description = 17
      if (kind === 'entity-title-null') record.tables.database_entities[0].title = null
      if (kind === 'view-query-number') view.filter_query = 17
      if (kind === 'view-name-ASCII-collision') { view.name = 'Alpha'; record.tables.database_saved_views.push({ ...view, id: randomUUID(), name: 'alpha' }) }
      if (kind === 'view-name-NUL-collision') { view.name = 'a\0x'; record.tables.database_saved_views.push({ ...view, id: randomUUID(), name: 'A\0y' }) }
      if (kind === 'duplicate-document-entity') { const original = record.tables.database_entities[0]; record.tables.database_entities.push({ ...original, id: randomUUID(), document_id: b }, { ...original, id: randomUUID(), document_id: b }) }
      if (kind === 'unknown-column') custom.unknown = 'extra'
      if (kind === 'foreign-column') record.tables.database_entity_values[0].column_id = randomUUID()
      if (kind === 'broken-options') record.tables.document_database_columns[0].options_json = '{}'
    })
    await invalidReadWithoutSql(f)
  })
})

test('SQLite ASCII NOCASE permits distinct accented saved-view names and the real publication reader must keep that distinction', () => withPublicationFixture(async f => {
  f.db.prepare('UPDATE database_saved_views SET name=? WHERE id=?').run('É', savedViewId)
  f.db.prepare('INSERT INTO database_saved_views(id,database_id,name,filter_query,filter_scope,sort_mode,view_mode,config_json,config_version,sort_order,created_at,updated_at) SELECT ?,database_id,?,filter_query,filter_scope,sort_mode,view_mode,config_json,config_version,1,created_at,updated_at FROM database_saved_views WHERE id=?').run(randomUUID(), 'é', savedViewId)
  const handle = await prepared(f.db, f.input()); assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed')
  const read = await remote(f.client()), item = read.facts.records.find(record => record.key === 'databases')
  assert.ok(item && item.record.kind === 'databases', 'The actual database snapshot includes both valid SQLite saved views')
  if (!item || item.record.kind !== 'databases') throw new Error('Actual database record required')
  assert.deepEqual(item.record.tables.database_saved_views.filter(row => row.database_id === customId).map(row => row.name).sort(), ['É', 'é'].sort())
}))

test('multiple independent null document custom entities are legal and survive the real complete initial snapshot roundtrip', () => withPublicationFixture(async f => {
  f.db.prepare('INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), customId, 'Another independent null entity', null, now, now)
  const expected = f.db.prepare('SELECT id FROM database_entities WHERE database_id=? AND document_id IS NULL ORDER BY id').all(customId) as Array<{ id: string }>
  assert.equal(expected.length, 2)
  const handle = await prepared(f.db, f.input()); assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed')
  const read = await remote(f.client()), item = read.facts.records.find(record => record.key === 'databases')
  assert.ok(item && item.record.kind === 'databases', 'A strict real publication carries both standalone custom entity identities')
  if (!item || item.record.kind !== 'databases') throw new Error('Actual database record required')
  assert.deepEqual(item.record.tables.database_entities.filter(row => row.database_id === customId && row.document_id === null).map(row => row.id).sort(), expected.map(row => row.id))
}))

test('SQLite NOCASE keeps the different UTF8 byte-length NUL saved-view pair legal through real publication', () => withPublicationFixture(async f => {
  f.db.prepare('UPDATE database_saved_views SET name=? WHERE id=?').run('a\0x', savedViewId)
  f.db.prepare('INSERT INTO database_saved_views(id,database_id,name,filter_query,filter_scope,sort_mode,view_mode,config_json,config_version,sort_order,created_at,updated_at) SELECT ?,database_id,?,filter_query,filter_scope,sort_mode,view_mode,config_json,config_version,1,created_at,updated_at FROM database_saved_views WHERE id=?').run(randomUUID(), 'A\0é', savedViewId)
  const handle = await prepared(f.db, f.input()); assert.equal((await publishInitialSyncedPublication(f.db, handle, runtime)).status, 'confirmed')
  const read = await remote(f.client()), item = read.facts.records.find(record => record.key === 'databases')
  assert.ok(item && item.record.kind === 'databases', 'Real SQLite accepted names are not collapsed by a new Unicode or NUL ban')
  if (!item || item.record.kind !== 'databases') throw new Error('Actual database record required')
  assert.deepEqual(item.record.tables.database_saved_views.filter(row => row.database_id === customId).map(row => row.name).sort(), ['a\0x', 'A\0é'].sort())
}))

test('unchanged group and protocol raw byte limits reject oversized real remote objects and entry tables before any SQL authority', async () => {
  for (const kind of ['group-five-MiB', 'record-sixteen-MiB', 'entry-count', 'instance-count'] as const) await published(async (f, own) => {
    if (kind === 'group-five-MiB') alterRecord(f, 'group:' + own, record => { record.blocks[0].content = 'X'.repeat(SYNCED_GROUP_MAX_BYTES); record.bindings = [] })
    else if (kind === 'record-sixteen-MiB') alterRecord(f, 'doc:' + b, record => { record.content.summary = 'Y'.repeat(16 * 1024 * 1024) })
    else { const value = manifest(f)
      if (kind === 'entry-count') { const missing = 100001 - Object.keys(value.entries).length; for (let i = 0; i < missing; i++) value.entries['doc:overflow-' + i] = '0'.repeat(64) }
      else value.syncedInstances = Array.from({ length: 100001 }, () => copy(value.syncedInstances[0]))
      f.server.files.set(manifestPath, Buffer.from(encode(value))) }
    await invalidReadWithoutSql(f)
  })
})
