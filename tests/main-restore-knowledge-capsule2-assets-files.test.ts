import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, readdir, link, realpath, lstat, rename, symlink } from 'node:fs/promises'
import { join, basename, relative, resolve, sep, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { AttachmentStore } from '../src/main/attachments'
import { KnowbookStore } from '../src/main/database/store'
import { assistantTurnId, assistantStepId } from '../src/shared/assistant-session'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchContent, type OwnedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { prepareCapsule2KnownAssetOriginals, readPreparedCapsule2KnownAssetOriginals,
  type PreparedCapsule2KnownAssetOriginals } from '../src/main/database/restore-knowledge-capsule2-assets-files'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { withV3Fixture, addV3Assets, allTables, request, applied, applySyncedHostFinal, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { withIncomingFixture, accepted } from './helpers/synced-initial-incoming-fixture'
import { removeSchema27ForLegacyFixture } from './helpers/schema27-legacy-fixture'
import { windowsShortPath } from './helpers/windows-short-path'

async function original(f: Pick<V3Fixture, 'userDataRoot' | 'db'>) {
  const profileRoot = await realpath(f.userDataRoot), recoveryDirectory = join(profileRoot, 'backups', 'database-restore', randomUUID())
  const sealedDirectory = join(recoveryDirectory, 'sealed')
  await mkdir(sealedDirectory, { recursive: true })
  await f.db.backup(join(sealedDirectory, 'knowbook.db'))
  const handle = await prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory, sealedDirectory, capsuleId: randomUUID(), label: 'actual-source' })
  const info = readOwnedRawCapsuleOriginal(handle), inventory = await restoreInventory(info.originalDirectory)
  const output = join(recoveryDirectory, 'knowledge-asset-originals-v2', basename(info.capsuleDirectory))
  return { handle, info, inventory, output }
}
function summary(f: V3Fixture, text: string) {
  applied(applySyncedHostFinal(f.db, request(f.db, [f.targetId], sides => { sides[0].summary = text })))
}
async function saved(f: V3Fixture) {
  const source = await original(f), before = allTables(f.db)
  const handle = await prepareCapsule2KnownAssetOriginals(source.handle), value = await readPreparedCapsule2KnownAssetOriginals(handle)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
  assert.deepEqual(allTables(f.db), before)
  assert.equal(value.manifest.certified, false); assert.equal(value.manifest.semanticValidationComplete, false); assert.equal(value.manifest.permit, false)
  assert.equal(Object.isFrozen(value.manifest.aliases), true)
  assert.deepEqual((await readdir(source.info.capsuleDirectory)).sort(), ['original','scratch'])
  return { source, handle, value }
}

test('capsule2 known asset originals persist both real Main same-hash names into one independent durable blob without changing SQL or the legacy capsule layout', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), { source, value } = await saved(f)
  assert.deepEqual(value.manifest.aliases.map(alias => alias.uri).sort(), added.attachments.map(asset => asset.url).sort())
  assert.equal(value.manifest.files.length, 1); assert.equal(value.manifest.files[0].hash, added.hash)
  assert.deepEqual(await readFile(join(value.directory, 'files', added.hash)), added.bytes)
  assert.deepEqual(value.manifest.sourceInventory, source.info.originalInventory)
  assert.match(value.manifest.sourceContentHash, /^[a-f0-9]{64}$/)
  assert.match(value.manifest.assetReferencesObservationHash, /^[a-f0-9]{64}$/)
}))

test('capsule2 known asset originals remain readable from actual copies after all live source names disappear', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), { handle, value } = await saved(f)
  for (const asset of added.attachments) await unlink(f.assets.resolve(asset.url))
  assert.deepEqual(await readPreparedCapsule2KnownAssetOriginals(handle), value)
  assert.deepEqual(await readFile(join(value.directory, 'files', added.hash)), added.bytes)
}))

test('capsule2 known asset originals preserve actual Main imports through a native Windows short profile alias', { skip: process.platform !== 'win32' }, t => withV3Fixture(async f => {
  const profileRoot = await realpath(f.userDataRoot), shortRoot = windowsShortPath(profileRoot)
  if (shortRoot.toLowerCase() === profileRoot.toLowerCase()) { t.skip('This native volume does not provide a distinct 8.3 profile alias'); return }
  const assets = new AttachmentStore(join(shortRoot, 'storage', 'assets')), bytes = Buffer.from('actual native short-profile import')
  const [asset] = await assets.import([{ name: 'actual-short-profile.png', bytes }])
  summary(f, '[native](<' + asset.url + '>)')
  const source = await original(f), before = allTables(f.db)
  assert.equal(source.info.profileRoot.toLowerCase(), profileRoot.toLowerCase())
  assert.notEqual(fileURLToPath(asset.url).toLowerCase(), (await realpath(fileURLToPath(asset.url))).toLowerCase())
  t.diagnostic(JSON.stringify({ nativeShortRoot: shortRoot, canonicalProfileRoot: profileRoot, originalUri: asset.url }))
  const handle = await prepareCapsule2KnownAssetOriginals(source.handle), value = await readPreparedCapsule2KnownAssetOriginals(handle)
  assert.equal(value.manifest.aliases.length, 1); assert.equal(value.manifest.aliases[0].uri, asset.url)
  assert.equal(value.manifest.aliases[0].name, asset.name)
  assert.deepEqual(await readFile(join(value.directory, 'files', value.manifest.files[0].hash)), bytes)
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 known asset preparation rejects a real foreign asset reached through a native Windows short alias', { skip: process.platform !== 'win32' }, t => withV3Fixture(async f => {
  const physical = await realpath(f.root), shortRoot = windowsShortPath(physical)
  if (shortRoot.toLowerCase() === physical.toLowerCase()) { t.skip('This native volume does not provide a distinct 8.3 fixture alias'); return }
  await mkdir(f.assets.root, { recursive: true })
  const foreign = new AttachmentStore(join(shortRoot, 'foreign-assets'))
  const [asset] = await foreign.import([{ name: 'actual-foreign-short.png', bytes: Buffer.from('foreign native alias') }])
  summary(f, '[foreign](<' + asset.url + '>)')
  const source = await original(f), before = allTables(f.db)
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.handle), /路径越过真实profile|outside the workspace/)
  assert.deepEqual(await readdir(join(source.output, 'files')), [])
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 known asset preparation rejects a native Windows short URI through a junction even when its physical file is owned', { skip: process.platform !== 'win32' }, t => withV3Fixture(async f => {
  const profileRoot = await realpath(f.userDataRoot), shortRoot = windowsShortPath(profileRoot)
  if (shortRoot.toLowerCase() === profileRoot.toLowerCase()) { t.skip('This native volume does not provide a distinct 8.3 profile alias'); return }
  const [asset] = await f.assets.import([{ name: 'owned-through-junction.png', bytes: Buffer.from('actual owned junction target') }])
  const junction = join(profileRoot, 'asset-junction')
  await symlink(await realpath(f.assets.root), junction, 'junction')
  const alias = pathToFileURL(join(shortRoot, 'asset-junction', relative(f.assets.root, fileURLToPath(asset.url)))).href
  assert.equal((await realpath(fileURLToPath(alias))).toLowerCase(), (await realpath(fileURLToPath(asset.url))).toLowerCase())
  summary(f, '[junction](<' + alias + '>)')
  const source = await original(f), before = allTables(f.db)
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.handle), /symlink|junction/)
  assert.deepEqual(await readdir(join(source.output, 'files')), [])
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 known asset originals copy actual incoming hardlink names into an independent durable blob', () => withIncomingFixture(async f => {
  await f.publish(); accepted(await f.receive())
  const source = await original({ userDataRoot: f.B.root, db: f.B.db })
  const handle = await prepareCapsule2KnownAssetOriginals(source.handle), value = await readPreparedCapsule2KnownAssetOriginals(handle)
  assert.equal(value.manifest.files.length, 1)
  assert.deepEqual([...new Set(value.manifest.aliases.map(alias => alias.name))].sort(), f.aliases.map(alias => alias.name).sort())
  const file = join(value.directory, 'files', value.manifest.files[0].hash)
  assert.equal((await lstat(file)).nlink, 1)
  assert.deepEqual(await readFile(file), f.aliases[0].bytes)
}, { assets: true }))

test('capsule2 known asset originals capture an actual retained cross-chunk assistant destination from the complete source SQL', () => withV3Fixture(async f => {
  const bytes = Buffer.from('actual assistant-only original'), [asset] = await f.assets.import([{ name: 'assistant-only.png', bytes }])
  const repository = f.store.assistantSessions, session = repository.createSession({ workspaceId: 'actual-files', title: 'actual retained stream', modelConfig: null })
  const turnId = assistantTurnId('actual-files-turn'), stepId = assistantStepId('actual-files-step')
  repository.append(session.id, { type: 'turn.started', payload: { turnId } })
  repository.append(session.id, { type: 'step.started', payload: { turnId, stepId, provider: 'actual', model: 'actual', visibleTools: [] } })
  for (const text of ['![actual](<', asset.url, '>)']) repository.append(session.id, { type: 'assistant.chunk', payload: { turnId, stepId, text } })
  const { value } = await saved(f)
  assert.equal(value.manifest.aliases.length, 1); assert.equal(value.manifest.aliases[0].uri, asset.url)
  assert.deepEqual(await readFile(join(value.directory, 'files', value.manifest.files[0].hash)), bytes)
}))

test('capsule2 zero known Markdown assets remain explicit known-only prepared data without an empty knowledge or installation claim', () => withV3Fixture(async f => {
  const { value } = await saved(f)
  assert.deepEqual(value.manifest.aliases, []); assert.deepEqual(value.manifest.files, [])
  assert.equal(value.manifest.state, 'known-markdown-files-only')
  assert.deepEqual(await readdir(join(value.directory, 'files')), [])
}))

test('capsule2 known asset originals keep genuine zero-byte managed imports as present files', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: 'actual-empty.bin', bytes: Buffer.alloc(0) }]); summary(f, '[empty](<' + asset.url + '>)')
  const { value } = await saved(f)
  assert.equal(value.manifest.files.length, 1); assert.equal(value.manifest.files[0].bytes, 0)
  assert.equal((await readFile(join(value.directory, 'files', value.manifest.files[0].hash))).length, 0)
}))

test('capsule2 known asset originals preserve complete schema26 column-fixture bytes without migration or source repair', () => withV3Fixture(async f => {
  const userDataRoot = join(f.root, 'complete-source26'), file = join(userDataRoot, 'storage', 'knowbook.db')
  const store = new KnowbookStore(file)
  try {
    const assets = new AttachmentStore(join(userDataRoot, 'storage', 'assets')), bytes = Buffer.from('actual source26 bytes')
    const [asset] = await assets.import([{ name: 'source26.png', bytes }]), id = store.createDocument(null), detail = store.getDocumentDetail(id)
    assert.ok(detail)
    store.updateDocument(id, { title: detail.title, summary: '[actual](<' + asset.url + '>)', blocks: detail.blocks })
    const db = store.getUnsafeDatabaseHandle()
    // Existing narrow old-column fixture: a complete current Store with the
    // empty27 namespace removed, not a claim of a genuine old Main oracle.
    removeSchema27ForLegacyFixture(db); db.pragma('user_version=26')
    const source = await original({ userDataRoot, db }), handle = await prepareCapsule2KnownAssetOriginals(source.handle), value = await readPreparedCapsule2KnownAssetOriginals(handle)
    assert.equal(value.manifest.schemaVersion, 26); assert.equal(db.pragma('user_version', { simple: true }), 26)
    assert.equal(value.manifest.aliases[0].uri, asset.url)
    assert.deepEqual(await readFile(join(value.directory, 'files', value.manifest.files[0].hash)), bytes)
  } finally { store.destroy() }
}))

test('capsule2 known asset preparation refuses a genuine foreign managed root without reading it as this Main source authority', () => withV3Fixture(async f => {
  const store = new AttachmentStore(join(f.root, 'foreign-assets')), [asset] = await store.import([{ name: 'foreign.png', bytes: Buffer.from('actual foreign bytes') }])
  summary(f, '[foreign](<' + asset.url + '>)')
  const source = await original(f), before = allTables(f.db)
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.handle))
  assert.deepEqual(allTables(f.db), before)
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 known asset preparation rejects an actual storage ancestor junction before following the logical owned URI prefix', () => withIncomingFixture(async f => {
  await f.publish(); accepted(await f.receive())
  const source = await original({ userDataRoot: f.B.root, db: f.B.db })
  f.B.db.close()
  const owned = await realpath(f.folder)
  const storage = await realpath(join(f.B.root, 'storage')), foreign = join(owned, 'outside-receiver-storage')
  for (const path of [storage, resolve(foreign)]) {
    const child = relative(owned, path)
    assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child), 'Both native move targets stay in the actual isolated fixture root')
  }
  await rename(storage, foreign)
  await symlink(foreign, storage, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.handle), /symlink|junction|自有路径/)
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}, { assets: true }))

test('capsule2 partial known asset preparation preserves its real first blob and never overwrites or retries after a damaged second name', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), source = await original(f)
  await writeFile(f.assets.resolve(added.attachments[1].url), 'damaged actual second source')
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.handle))
  assert.deepEqual(await readFile(join(source.output, 'files', added.hash)), added.bytes)
  await assert.rejects(readFile(join(source.output, 'manifest.json')))
  await writeFile(f.assets.resolve(added.attachments[1].url), added.bytes)
  await assert.rejects(prepareCapsule2KnownAssetOriginals(source.handle), /重入|覆盖/)
}))

test('capsule2 known asset data handles cannot be forged from the public kind or a copied prepared DTO', () => withV3Fixture(async f => {
  const { handle, value } = await saved(f)
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals({ ...handle }))
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals(value as unknown as PreparedCapsule2KnownAssetOriginals))
  await assert.rejects(prepareCapsule2KnownAssetOriginals({ kind: 'owned-raw-capsule-original' } as OwnedRawCapsuleOriginal))
}))

test('capsule2 known asset data is freshly checked against the immutable original SQL inventory on every use', () => withV3Fixture(async f => {
  const { source, handle } = await saved(f)
  await writeFile(join(source.info.originalDirectory, 'knowbook.db'), 'changed actual original SQL')
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals(handle))
}))

test('capsule2 known asset data refuses changed manifest bytes even when it remains valid JSON', () => withV3Fixture(async f => {
  const { handle, value } = await saved(f)
  const path = join(value.directory, 'manifest.json'), body = await readFile(path, 'utf8')
  await writeFile(path, body.replace('known-markdown-files-only', 'known-markdown-files-ONLY'))
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals(handle))
}))

test('capsule2 known asset data refuses a same-length changed blob and any extra file in the complete directory', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), { handle, value } = await saved(f), path = join(value.directory, 'files', added.hash)
  const changed = Buffer.from(added.bytes); changed[0] ^= 1
  await writeFile(path, changed)
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals(handle))
  await writeFile(path, added.bytes); await writeFile(join(value.directory, 'files', 'unexpected'), 'extra')
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals(handle))
}))

test('capsule2 saved known asset blobs are independently owned copies and refuse later filesystem hardlink aliases', () => withV3Fixture(async f => {
  const added = await addV3Assets(f), { handle, value } = await saved(f)
  await link(join(value.directory, 'files', added.hash), join(f.userDataRoot, 'unexpected-blob-link'))
  await assert.rejects(readPreparedCapsule2KnownAssetOriginals(handle))
}))

test('capsule2 post-read source guard admits SQLite derived scratch sidecars and refuses changed SQL while prepared originals remain independent', () => withV3Fixture(async f => {
  const { source, handle, value } = await saved(f)
  await assertOwnedRawCapsuleScratchContent(source.handle)
  const db = new Database(restoreSqliteFilename(source.info.databasePath))
  try { db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('actual-changed-scratch', 'actual', new Date().toISOString()) }
  finally { db.close() }
  await assert.rejects(assertOwnedRawCapsuleScratchContent(source.handle))
  assert.deepEqual(await readPreparedCapsule2KnownAssetOriginals(handle), value)
}))
