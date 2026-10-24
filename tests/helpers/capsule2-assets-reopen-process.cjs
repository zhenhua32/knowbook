;(async () => {
  const { reopenPreparedRawCapsuleOriginal, readOwnedRawCapsuleOriginal } = await import('../../src/main/database/restore-knowledge-capsule-files.ts')
  const { reopenCapsule2ManagedAssetOriginals, readPreparedCapsule2ManagedAssetOriginals } = await import('../../src/main/database/restore-knowledge-capsule2-managed-assets-files.ts')
  const input = JSON.parse(process.argv[2])
  const original = await reopenPreparedRawCapsuleOriginal(input.original)
  const prepared = await reopenCapsule2ManagedAssetOriginals(original, input.manifestHash)
  const value = await readPreparedCapsule2ManagedAssetOriginals(prepared)
  process.stdout.write(JSON.stringify({ pid: process.pid, info: readOwnedRawCapsuleOriginal(original), value }))
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1 })
