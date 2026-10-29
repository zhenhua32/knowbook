// REVIEW DRAFT. Actual fresh mixed import registry + complete qualified reader.
;(async () => {
  const assert = require('node:assert/strict'), path = require('node:path'), url = require('node:url'), module = require('node:module')
  const input = JSON.parse(process.argv[2]), native = require('node:fs'), promises = require('node:fs/promises'), originals = [], accesses = [], createdDirectories = []
  const forbidden = path.resolve(input.forbiddenOriginRoot), key = value => process.platform === 'win32' ? value.toLowerCase() : value
  function check(value, operation) {
    if (value instanceof URL && value.protocol === 'file:') value = url.fileURLToPath(value)
    if (typeof value !== 'string') return
    const actual = key(path.resolve(value)), root = key(forbidden)
    if (actual === root || actual.startsWith(root + path.sep)) { accesses.push({ operation, path: value }); throw new Error('Retired original profile must never be probed') }
  }
  try {
    for (const [object, names] of [[native, ['openSync', 'lstatSync', 'statSync', 'readFileSync', 'realpathSync', 'existsSync', 'readdirSync', 'copyFileSync']], [promises, ['open', 'lstat', 'stat', 'readFile', 'realpath', 'opendir', 'readdir', 'mkdir', 'copyFile']]]) for (const name of names) {
      const original = object[name], wrapped = function (...args) {
        check(args[0], name)
        const result = Reflect.apply(original, this, args)
        if (name !== 'mkdir') return result
        return result.then(value => { if (typeof args[0] === 'string') createdDirectories.push(path.resolve(args[0])); return value })
      }
      Object.assign(wrapped, original)
      if (name === 'realpathSync' && typeof original.native === 'function') wrapped.native = function (...args) { check(args[0], 'realpathSync.native'); return Reflect.apply(original.native, this, args) }
      originals.push({ object, name, original }); object[name] = wrapped
    }
    module.syncBuiltinESMExports()
    const { captureReopenedPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
    const { readCompleteOriginalContentPair3, captureReopenedQualifiedOriginalBundle } = await import('../../src/main/database/restore-knowledge-qualified-originals.ts')
    const { capsule2SourceManifestHash } = await import('../../src/main/database/restore-knowledge-capsule2-source-seal-model.ts')
    assert.ok(input.mode === 'mixed' || input.mode === 'qualified')
    const captured = input.mode === 'qualified' ? await captureReopenedQualifiedOriginalBundle(input.locator) : await captureReopenedPreparedMixedOriginBundle(input.locator)
    const actual = await readCompleteOriginalContentPair3(captured.bundle), source = actual.source, current = actual.current, archive = source.assetArchive
    assert.equal(archive.version, 3); assert.equal(current.assetArchive.version, 2)
    const sourceManifestPath = `catalog/backups/database-restore/${source.operationId}/knowledge-source-capsules-v2/${source.capsuleId}/manifest.json`
    const sourceManifestFile = actual.originalPackage.files.find(file => file.path === sourceManifestPath)
    assert.ok(sourceManifestFile)
    const sourceManifest = JSON.parse(await promises.readFile(sourceManifestFile.sourcePath, 'utf8'))
    const logicalCurrentAssets = `catalog/backups/database-restore/${current.operationId}/knowledge-complete-assets-v2/${current.capsuleId}`
    assert.ok(actual.originalPackage.directories.some(dir => !dir.frame.length && dir.path === logicalCurrentAssets + '/files'))
    assert.equal(actual.originalPackage.directories.some(dir => !dir.frame.length && dir.path === logicalCurrentAssets + '/contexts'), false)
    // Qualified storage is a by-frame object store. Empty directories are
    // logical catalog facts, recreated by the real Main verification profile;
    // observe actual mkdir calls, not an invented flat catalog disk path.
    const suffix = path.join('backups', 'database-restore', current.operationId, 'knowledge-complete-assets-v2', current.capsuleId, 'files')
    const recreated = [...new Set(createdDirectories.filter(value => key(value).endsWith(path.sep + key(suffix))))]
    assert.ok(recreated.length > 0, 'The genuine fresh reader recreates the transported empty directory')
    for (const directory of recreated) assert.deepEqual(await promises.readdir(directory), [])
    assert.equal(actual.originalPackage.original.managedOriginalBytes, captured.value.managedOriginalBytes)
    assert.deepEqual(accesses, []); assert.equal(archive.coverage.installPermit, false)
    process.stdout.write(JSON.stringify({ mode: input.mode, pid: process.pid, forbiddenOriginAccesses: accesses,
      sourceManifestHash: capsule2SourceManifestHash(sourceManifest), sourceMaterialHash: source.materialHash, sourceArchiveHash: source.assetArchiveHash,
      currentMaterialHash: current.materialHash, currentArchiveVersion: current.assetArchive.version,
      contextInventoryHash: archive.contextOriginals.inventoryHash, supplementalObservationHash: archive.assetScopeSupplement.observationHash,
      managedOriginalBytes: captured.value.managedOriginalBytes, currentFilesDirectoryEmpty: true, recreatedEmptyDirectoryCount: recreated.length,
      acceptedCoverage: captured.value.acceptedCoverage, permit: captured.value.permit }))
  } finally { for (const item of originals) item.object[item.name] = item.original; module.syncBuiltinESMExports() }
})().catch(error => { console.error(error); process.exitCode = 1 })
