;(async () => {
  const { reopenPreparedRawCapsuleOriginal } = await import('../../src/main/database/restore-knowledge-capsule-files.ts')
  const { reopenCapsule2AssetArchive } = await import('../../src/main/database/restore-knowledge-capsule2-asset-archive.ts')
  const { extractCapsule2SourceMaterial, readCapsule2SourceMaterial } = await import('../../src/main/database/restore-knowledge-capsule2-source-material.ts')
  const input = JSON.parse(process.argv[2]), original = await reopenPreparedRawCapsuleOriginal(input.original)
  const archive = await reopenCapsule2AssetArchive(original, input.manifestHash)
  const value = await readCapsule2SourceMaterial(await extractCapsule2SourceMaterial(archive))
  process.stdout.write(JSON.stringify({ pid: process.pid, value }))
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1 })
