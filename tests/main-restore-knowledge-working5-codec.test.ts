import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { withPendingWorkingSource5 } from './helpers/working5-automatic-source-fixture'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { parseWorkingOriginals5, validateWorkingOriginalsManifest5, validateWorkingOriginalsPointer5, describeWorkingOriginals5 } from '../src/main/database/restore-knowledge-capsule5-working-model'
import { parseCapsule2CompleteAssetArchiveManifest, reopenCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { reopenPreparedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { assertRestorePath } from '../src/main/database/restore-safety-files'

test('Working5 rejects compact pointer lies and a fully re-signed pending-to-settled skip after genuine cold original bytes are opened',
  { concurrency: false }, () => withPendingWorkingSource5(async f => {
    const pointer = f.working.pointer, text = capsuleJson(f.working.manifest) + '\n'
    assert.throws(() => validateWorkingOriginalsPointer5({ ...pointer, files: [] }))
    for (const changed of [
      { ...pointer, manifestHash: '0'.repeat(64) },
      { ...pointer, manifestFile: { ...pointer.manifestFile, bytes: pointer.manifestFile.bytes + 1 } },
      { ...pointer, manifestFile: { ...pointer.manifestFile, sha256: '0'.repeat(64) } },
      { ...pointer, originalFileBytes: pointer.originalFileBytes + 1 },
      { ...pointer, fileCount: pointer.fileCount + 1 },
      { ...pointer, filesHash: '0'.repeat(64) }
    ]) assert.throws(() => parseWorkingOriginals5(text, changed))
    const archive = f.value.assetArchive; assert.equal(archive.version, 5)
    if (archive.version !== 5) throw new Error('Actual archive5 required')
    const captured = f.working.manifest.captures.find(item => item.jobSettingKey === f.row.key); assert.ok(captured)
    assert.equal(captured.state, 'captured')
    const { state: _state, fileHashes: _fileHashes, ...binding } = captured
    const captures = f.working.manifest.captures.filter(item => item.jobSettingKey !== captured.jobSettingKey)
    const usedHashes = new Set(captures.flatMap(item => item.fileHashes))
    const forged = validateWorkingOriginalsManifest5({ ...f.working.manifest, captures,
      files: f.working.manifest.files.filter(item => usedHashes.has(item.sha256)),
      settledBindings: [...f.working.manifest.settledBindings, { ...binding, contextHash: '0'.repeat(64), bindingHash: '0'.repeat(64) }]
        .sort((a, b) => a.jobSettingKey < b.jobSettingKey ? -1 : 1) })
    const forgedText = capsuleJson(forged) + '\n', forgedArchive = { ...archive, workingOriginals: describeWorkingOriginals5(forged) }
    const archiveText = capsuleJson(forgedArchive) + '\n', archiveHash = capsuleBytesHash('knowbook.capsule2.complete-asset-archive.v5\0' + capsuleJson(forgedArchive))
    assert.deepEqual(parseWorkingOriginals5(forgedText, forgedArchive.workingOriginals), forged)
    assert.equal(parseCapsule2CompleteAssetArchiveManifest(archiveText, archive.capsuleId, archiveHash).version, 5,
      'Both new contracts are re-signed; this negative must reach the genuine original partition check')
    const manifestPath = join(f.working.directory, 'manifest.json'), archivePath = join(dirname(f.working.directory), 'manifest.json')
    const oldManifest = await readFile(manifestPath), oldArchive = await readFile(archivePath), filesPath = join(f.working.directory, 'files')
    const fixtureRoot = await realpath(f.f.folder), retired = join(fixtureRoot, 'retired-forged-working5-' + randomUUID())
    await assertRestorePath(filesPath, fixtureRoot); assert.equal(dirname(retired), fixtureRoot)
    await rename(filesPath, retired); await mkdir(filesPath)
    try {
      for (const file of forged.files) await copyFile(join(retired, file.sha256), join(filesPath, file.sha256))
      await writeFile(manifestPath, forgedText); await writeFile(archivePath, archiveText)
      const fresh = await reopenPreparedRawCapsuleOriginal({ profileRoot: f.original.info.profileRoot,
        operationId: basename(f.original.info.recoveryDirectory), capsuleId: archive.capsuleId, expectedInventory: f.original.inventory })
      await assert.rejects(reopenCapsule2AssetArchive(fresh, archiveHash), /实际base\/automatic分区不符/,
        'Caller DTOs cannot replace a pending original SQL job with settled evidence')
    } finally {
      await writeFile(manifestPath, oldManifest); await writeFile(archivePath, oldArchive)
      // Preserve both real trees as test diagnostics without deleting recursively.
      await rename(filesPath, join(fixtureRoot, 'rejected-forged-working5-' + randomUUID()))
      await rename(retired, filesPath)
    }
  }))
