import assert from 'node:assert/strict'
import { reopenDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, readCertifiedDurableSqlCapsule,
  type CertifiedDurableSqlCapsule } from '../../src/main/database/restore-knowledge-capsule-read'
import { capsuleBytesHash, capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'

// This real child process has none of the parent's WeakMap identities. The only
// serialized input is the trusted test owner's fixed locator and expected hash.
try {
  const original = await reopenDurableSqlCapsuleOriginal(JSON.parse(process.argv[2] ?? 'null'))
  const info = readOwnedRawCapsuleOriginal(original)
  await assert.rejects(readCertifiedDurableSqlCapsule({ kind: 'certified-durable-sql-capsule' } as CertifiedDurableSqlCapsule), /句柄/)
  const capsule = await certifyDurableSqlCapsuleOriginal(original), seal = await readCertifiedDurableSqlCapsule(capsule)
  process.stdout.write(JSON.stringify({ kind: 'reopened-capsule-test-result', pid: process.pid, manifestHash: seal.manifestHash,
    manifestPath: seal.manifestPath, scratchDirectory: info.scratchDirectory, factsHash: capsuleBytesHash(capsuleJson(seal.facts)),
    facts: seal.facts.length, certifiedForInstallation: false }) + '\n')
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
