import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join, sep } from 'node:path'
import { captureSealedCapsule2SourceFromArchive } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { prepareCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureOriginalReferenceContextWithInitialInputs } from '../src/main/database/restore-knowledge-reference-context'
import { readPreparedMixedOriginBundleOriginalInputs } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'
import { withMixedBundleFixture } from './helpers/mixed-origin-bundle-fixture'
import { addOriginalReferenceSyntax, sealedReferenceSource } from './helpers/qualified-originals-fixture'

const require = createRequire(import.meta.url)
const fs: typeof import('node:fs/promises') = require('node:fs/promises')
async function afterManifestClose(t: TestContext, matches: (path: string) => boolean, mutate: () => Promise<void>, run: () => Promise<unknown>) {
  const open = fs.open; let injected = false
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const fd = await Reflect.apply(open, fs, args), close = fd.close.bind(fd)
    if (matches(String(args[0]))) fd.close = async () => { await close(); if (!injected) { injected = true; await mutate() } }
    return fd
  })
  syncBuiltinESMExports()
  try { await assert.rejects(run); assert.equal(injected, true, 'The real manifest FD closed after actual capture/copy and before the final complete immutable-byte bracket') }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}
test('cold sealed-source capture rejects original SQL changed after its actual source capture and manifest close', { concurrency: false }, t => withV3Fixture(async f => {
  const original = await captureAssetOriginal(f), archive = await prepareCapsule2AssetArchive(original.original), before = allTables(f.db)
  await afterManifestClose(t, path => path.includes(sep + 'knowledge-source-capsules-v2' + sep) && path.endsWith(sep + 'manifest.json'),
    () => fs.writeFile(join(original.info.originalDirectory, 'knowbook.db'), 'late changed complete original SQL'), () => captureSealedCapsule2SourceFromArchive(archive))
  assert.deepEqual(allTables(f.db), before)
}))
test('cold context capture rechecks every source-parent original after copying rather than authorizing its saved SQL packet', { concurrency: false }, t => withMixedBundleFixture([1, 1], async f => {
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const source = await sealedReferenceSource(f.source), parent = await readPreparedMixedOriginBundleOriginalInputs(f.handle)
  const sql = parent.files.find(file => file.path.endsWith('/original/knowbook.db'))!, before = allTables(f.source.db)
  await afterManifestClose(t, path => path.includes(sep + 'knowledge-original-reference-contexts' + sep) && path.endsWith(sep + 'descriptor.json'),
    () => fs.writeFile(sql.sourcePath, 'late changed already-copied parent SQL'),
    () => captureOriginalReferenceContextWithInitialInputs({ source: source.source, parents: [f.handle] }))
  assert.deepEqual(allTables(f.source.db), before); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
