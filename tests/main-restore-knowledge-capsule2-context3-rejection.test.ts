// Real byte failures, without mocked stat/hash/capability results.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readCapsule2ArchiveSourceInputs } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { readSealedCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withCapturedContext3 } from './helpers/capsule2-context3-producer-fixture'

test('genuine archive3 refuses missing context headers object or asset originals and exact descriptor or same-length byte changes without altering SQL',
  { concurrency: false }, () => withCapturedContext3(async saved => {
    const before = allTables(saved.f.B.db), raw = saved.saved.value.source.sourceContent
    const roleFiles = ['inputs.json', 'job.json', 'ready.json', 'manifest.json',
      saved.expectedContextFiles.find(file => file.name.startsWith('objects/'))!.name,
      saved.expectedContextFiles.find(file => file.name === 'assets/' + saved.customHash)!.name]
    for (const [index, role] of roleFiles.entries()) {
      const expected = saved.expectedContextFiles.find(file => file.name === role)!, original = join(saved.archiveDirectory, 'contexts', expected.sha256)
      const parked = join(saved.f.folder, 'parked-one-context-original-' + index)
      await assert.rejects(lstat(parked), { code: 'ENOENT' })
      await rename(original, parked)
      try { await assert.rejects(readSealedCapsule2SourceMaterial(saved.saved.source), 'Missing actual original rejects: ' + role) }
      finally { await rename(parked, original) }
      assert.equal((await readSealedCapsule2SourceMaterial(saved.saved.source)).materialHash, saved.saved.value.materialHash)
    }
    const contextAsset = join(saved.archiveDirectory, 'contexts', saved.customHash), originalAsset = await readFile(contextAsset), changedAsset = Buffer.from(originalAsset)
    changedAsset[0] ^= 1; assert.equal(changedAsset.length, originalAsset.length)
    try { await writeFile(contextAsset, changedAsset); await assert.rejects(readCapsule2ArchiveSourceInputs(saved.archive)) }
    finally { await writeFile(contextAsset, originalAsset) }
    const manifestPath = join(saved.archiveDirectory, 'manifest.json'), originalManifest = await readFile(manifestPath), changedManifest = JSON.parse(originalManifest.toString('utf8'))
    changedManifest.assetScopeSupplement.referenceCount++
    try { await writeFile(manifestPath, capsuleJson(changedManifest) + '\n'); await assert.rejects(readCapsule2ArchiveSourceInputs(saved.archive)) }
    finally { await writeFile(manifestPath, originalManifest) }
    const recovered = await readSealedCapsule2SourceMaterial(saved.saved.source)
    assert.equal(recovered.materialHash, saved.saved.value.materialHash); assert.deepEqual(recovered.source.sourceContent, raw)
    assert.deepEqual(allTables(saved.f.B.db), before)
  }))

test('genuine archive3 rejects a real same-length managed asset rewrite after its first EOF and during later full context observation',
  { concurrency: false }, () => withCapturedContext3(async saved => {
    const manifest = saved.saved.value.assetArchive
    assert.equal(manifest.version, 3)
    if (manifest.version !== 3) throw new Error('Explicit archive3 required')
    const asset = manifest.tree.files.find(file => file.hash === saved.customHash)!
    assert.ok(asset)
    const assetPath = resolve(saved.archiveDirectory, 'files', asset.hash), inputs = saved.expectedContextFiles.find(file => file.name === 'inputs.json')!
    const inputsPath = resolve(saved.archiveDirectory, 'contexts', inputs.sha256), originalAsset = await readFile(assetPath), changed = Buffer.from(originalAsset)
    changed[0] ^= 1; assert.equal(changed.length, originalAsset.length)
    assert.notEqual(inputs.bytes, 64 * 1024, 'Distinguish actual complete input data buffer from the independent fixed hash buffer')
    const before = allTables(saved.f.B.db), require = createRequire(import.meta.url), promises = require('node:fs/promises') as Record<string, unknown>
    const originalOpen = promises.open as (...args: unknown[]) => Promise<import('node:fs/promises').FileHandle>
    const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    let firstAssetEof = false, actualInputDataEof = false, rewritten = false
    try {
      promises.open = async (...args: unknown[]) => {
        const fd = await originalOpen(...args), candidate = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0]
        if (typeof candidate !== 'string') return fd
        const current = resolve(candidate), isAsset = samePath(current, assetPath), isInputs = samePath(current, inputsPath)
        if (!isAsset && !isInputs) return fd
        const realRead = fd.read, realClose = fd.close; let bytesRead = 0, eof = false, completeInputBuffer = false
        Object.defineProperty(fd, 'read', { configurable: true, value: async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(realRead, fd, readArgs) as { bytesRead: number }
          bytesRead += result.bytesRead; if (result.bytesRead === 0) eof = true
          if (isInputs && readArgs[0] instanceof Uint8Array && readArgs[0].byteLength === inputs.bytes && result.bytesRead > 0) completeInputBuffer = true
          return result
        } })
        Object.defineProperty(fd, 'close', { configurable: true, value: async () => {
          await Reflect.apply(realClose, fd, [])
          if (isAsset && eof && bytesRead === originalAsset.length && !rewritten) firstAssetEof = true
          if (isInputs && eof && completeInputBuffer && bytesRead === inputs.bytes && !rewritten) {
            assert.equal(firstAssetEof, true, 'Real managed asset full read/EOF precedes the actual context payload read')
            actualInputDataEof = true
            await writeFile(assetPath, changed); rewritten = true
          }
        } })
        return fd
      }
      syncBuiltinESMExports()
      // Deliberately use the single archive semantic read. A later unrelated
      // material read would add another hash and could hide the old missing tail.
      await assert.rejects(readCapsule2ArchiveSourceInputs(saved.archive))
      assert.equal(firstAssetEof, true); assert.equal(actualInputDataEof, true); assert.equal(rewritten, true)
      assert.deepEqual(await readFile(assetPath), changed, 'The fixture changed actual bytes, not observed hash/stat results')
    } finally { promises.open = originalOpen; syncBuiltinESMExports(); await writeFile(assetPath, originalAsset) }
    const recovered = await readSealedCapsule2SourceMaterial(saved.saved.source)
    assert.equal(recovered.materialHash, saved.saved.value.materialHash)
    assert.deepEqual(recovered.source.sourceContent, saved.saved.value.source.sourceContent)
    assert.deepEqual(allTables(saved.f.B.db), before)
  }))
