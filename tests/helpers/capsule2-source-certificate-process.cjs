;(async () => {
  const { reopenCertifiedCapsule2Source, readCertifiedCapsule2Source, readCertifiedCapsule2SourceMaterial } = await import('../../src/main/database/restore-knowledge-capsule2-source-certificate.ts')
  const handle = await reopenCertifiedCapsule2Source(JSON.parse(process.argv[2]))
  process.stdout.write(JSON.stringify({ pid:process.pid,info:await readCertifiedCapsule2Source(handle),value:await readCertifiedCapsule2SourceMaterial(handle) }))
})().catch(error => { console.error(error); process.exitCode=1 })
