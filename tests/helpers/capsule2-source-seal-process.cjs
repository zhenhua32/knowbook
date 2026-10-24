;(async () => {
  const { reopenSealedCapsule2Source, readSealedCapsule2Source, readSealedCapsule2SourceMaterial } = await import('../../src/main/database/restore-knowledge-capsule2-source-seal.ts')
  const handle = await reopenSealedCapsule2Source(JSON.parse(process.argv[2]))
  process.stdout.write(JSON.stringify({ pid: process.pid, info: await readSealedCapsule2Source(handle), value: await readSealedCapsule2SourceMaterial(handle) }))
})().catch(error => { console.error(error); process.exitCode = 1 })
