import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSealedCapsule2SourceWithSettledContextProvenance4 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { reopenPreparedRawCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-files'
import { reopenCapsule2BaseProjection4, readCapsule2BaseProjection4 } from '../../src/main/database/restore-knowledge-capsule2-base-projection4'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { withSettledPortable3 } from './settled-portable-owner-fixture'

type Settled = Parameters<Parameters<typeof withSettledPortable3>[0]>[0]
const require = createRequire(import.meta.url)
function normalized(value: string): string { const path = resolve(value); return process.platform === 'win32' ? path.toLowerCase() : path }
/** Observe only the exact fixture spools known to have been truly retired.
 * Every unrelated FS call reaches its original native implementation. A probe
 * throws instead of synthesizing ENOENT or a successful production result. */
export async function withoutSettledSpoolProbes4<T>(spools: readonly string[], run: () => Promise<T>, observeSpools: readonly string[] = []) {
  const native = require('node:fs') as Record<string, unknown>, promises = require('node:fs/promises') as Record<string, unknown>
  const roots = spools.map(normalized), observedRoots = observeSpools.map(normalized)
  const attempts: Array<{ method: string; path: string }> = [], observations: Array<{ method: string; path: string }> = [], undo: Array<() => void> = []
  const matches = (value: unknown, candidates: readonly string[]) => {
    if (value instanceof URL && value.protocol === 'file:') value = fileURLToPath(value)
    if (Buffer.isBuffer(value)) value = value.toString()
    if (typeof value !== 'string') return false
    const path = normalized(value); return candidates.some(root => path === root || path.startsWith(root + sep))
  }
  try {
    for (const [object, names] of [[native, ['openSync','lstatSync','statSync','readFileSync','realpathSync','existsSync','accessSync','readdirSync','opendirSync',
      'open','lstat','stat','readFile','realpath','access','readdir','opendir']],
      [promises, ['open','lstat','stat','readFile','realpath','access','readdir','opendir']]] as const) for (const name of names) {
      const original = object[name] as ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown }
      const check = (method: string, args: unknown[]) => {
        if (matches(args[0], observedRoots)) observations.push({ method, path: String(args[0]) })
        if (matches(args[0], roots)) { attempts.push({ method, path: String(args[0]) }); throw new Error('Settled fixture spool must not be probed: ' + method) }
      }
      const wrapped = function(this: unknown, ...args: unknown[]) { check(name, args); return original.apply(this, args) }
      Object.assign(wrapped, original)
      if (typeof original.native === 'function') Object.assign(wrapped, { native: function(this: unknown, ...args: unknown[]) {
        check(name + '.native', args); return original.native!.apply(this, args)
      } })
      object[name] = wrapped; undo.push(() => { object[name] = original })
    }
    syncBuiltinESMExports()
    const value = await run()
    assert.deepEqual(attempts, [])
    return { value, attempts, observations }
  } finally { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports() }
}
export async function captureSettledContext4(saved: Settled) {
  const original = await captureAssetOriginal({ userDataRoot: saved.f.B.root, db: saved.f.B.db })
  const spools = saved.jobs.map(value => resolve(saved.f.B.root, 'storage', 'synced-exchanges-v1', value.job.request.operationId, value.job.attemptId))
  const captured = await withoutSettledSpoolProbes4(spools, () => captureSealedCapsule2SourceWithSettledContextProvenance4(original.original))
  const sealed = captured.value, value = sealed.value, sourceInput = { profileRoot: original.info.profileRoot,
    operationId: sealed.info.manifest.operationId, capsuleId: sealed.info.manifest.capsuleId, expectedManifestHash: sealed.info.manifestHash }
  assert.equal(value.assetArchive.version, 4)
  if (value.assetArchive.version !== 4) throw new Error('The explicit producer must produce archive4')
  const expectedBaseManifestHash = value.assetArchive.baseProjection.baseManifestHash
  const expectedBasePointer = value.assetArchive.baseProjection
  const readBase = async () => {
    const fresh = await reopenPreparedRawCapsuleOriginal({ profileRoot: original.info.profileRoot,
      operationId: sourceInput.operationId, capsuleId: sourceInput.capsuleId, expectedInventory: original.inventory })
    const owner = await reopenCapsule2BaseProjection4(fresh, expectedBaseManifestHash, expectedBasePointer)
    return { original: fresh, owner, value: await readCapsule2BaseProjection4(owner) }
  }
  return { saved, original, sealed, source: sealed.source, value, info: sealed.info, sourceInput,
    expectedRecords: saved.oracleRecords, spools, spoolProbeAttempts: captured.attempts, readBase }
}
export type SettledContext4Fixture = Awaited<ReturnType<typeof captureSettledContext4>>
export function withSettledContext4(run: (value: SettledContext4Fixture) => Promise<void>, options: { nativeAliases?: boolean; group?: boolean } = {}) {
  return withSettledPortable3(async saved => run(await captureSettledContext4(saved)), options)
}
