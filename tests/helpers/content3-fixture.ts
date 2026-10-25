import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { readdir, writeFile } from 'node:fs/promises'
import { withV3Fixture, addV3Assets, allTables, randomUUID } from './synced-backup-v3-fixture'
import { captureMixedSource } from './mixed-required-source-fixture'
import { writeMixedOrdinary501 } from './capsule2-raw-fixture'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { tryReadCertifiedCapsule2SourceInputs } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'

type SourcePacket = NonNullable<Awaited<ReturnType<typeof tryReadCertifiedCapsule2SourceInputs>>>['value']
type BeforeCurrent = (source: Parameters<typeof captureMixedSource>[0], original: SourcePacket) => void | Promise<void>
export async function withContent3Fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, beforeCurrent?: BeforeCurrent,
  beforeSource?: (source: Parameters<typeof captureMixedSource>[0]) => void | Promise<void>,
  beforeOrdinary?: (source: Parameters<typeof captureMixedSource>[0]) => void | Promise<void>) {
  await withV3Fixture(source => withV3Fixture(async receiver => { await run(await setup(source, receiver, beforeCurrent, beforeSource,beforeOrdinary)) }))
}
async function setup(source: Parameters<typeof captureMixedSource>[0], receiver: Parameters<typeof captureMixedSource>[0], beforeCurrent?: BeforeCurrent,
  beforeSource?: (source: Parameters<typeof captureMixedSource>[0]) => void | Promise<void>,
  beforeOrdinary?: (source: Parameters<typeof captureMixedSource>[0]) => void | Promise<void>) {
  await addV3Assets(source)
  // Fixture-only initialization hook: genuine Main commands precede the raw
  // ordinary body below, whose literal file URL is not a portable asset.
  await beforeOrdinary?.(source)
  const ordinary = writeMixedOrdinary501(source)
  source.store.saveSetting('ai.apiKey', 'source-private-key-must-never-be-in-business-candidate')
  // Real raw SQLite TEXT bytes, including NUL and a path-looking literal, are
  // business content. Neither normalization nor secret scanning selects rows.
  const raw = 'Incoming literal\0body [target](V3%20Target.md) and file:///opaque'
  source.db.prepare('UPDATE blocks SET content=? WHERE id=?').run(raw, source.targetBodyId)
  await beforeSource?.(source)
  const left = await captureMixedSource(source, 2)
  const sourcePacket = (await tryReadCertifiedCapsule2SourceInputs(left.handle))!.value
  source.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Different current business body', source.targetBodyId)
  source.store.saveSetting('ai.apiKey', 'current-key-is-retained-policy-only')
  await beforeCurrent?.(source, sourcePacket)
  const right = await captureMixedSource(source, 2)
  const currentPacket = (await tryReadCertifiedCapsule2SourceInputs(right.handle))!.value
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
  return { source, receiver, sourcePacket, currentPacket, saved, ordinary, raw,
    beforeSource: allTables(source.db), beforeReceiver: allTables(receiver.db) }
}
export async function tamperContent3VerificationOriginals(profileRoot: string) {
  const originals: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name === 'knowbook.db' && basename(directory) === 'original') originals.push(path)
    }
  }
  await visit(join(profileRoot, 'original-input-verification'))
  assert.ok(originals.length >= 2)
  for (const file of originals) await writeFile(file, 'changed actual verification SQL, immutable bundle left intact')
  return originals.length
}
