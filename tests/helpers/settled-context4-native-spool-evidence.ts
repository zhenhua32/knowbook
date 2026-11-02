import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type Observation = { readonly method: string; readonly path: string }
const normalized = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const identity = (value: BigIntStats) => ({ dev: String(value.dev), ino: String(value.ino) })
function sameOpenFile(a: BigIntStats, b: BigIntStats) {
  assert.equal(a.isFile(), true); assert.equal(b.isFile(), true)
  assert.notEqual(a.ino, 0n); assert.notEqual(b.ino, 0n)
  if (process.platform === 'win32') { assert.notEqual(a.dev, 0n); assert.notEqual(b.dev, 0n) }
  // Both sides are fstat from simultaneously open descriptors. No path.dev
  // wildcard, low32 comparison or guessed short/long spelling is used.
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino)
}
async function opened<T>(paths: readonly string[], run: (files: Awaited<ReturnType<typeof open>>[]) => Promise<T>) {
  const files: Awaited<ReturnType<typeof open>>[] = []
  try { for (const path of paths) files.push(await open(path, 'r')); return await run(files) }
  finally { const closed = await Promise.allSettled(files.map(file => file.close())); for (const result of closed) if (result.status === 'rejected') throw result.reason }
}

/** The fixture's temp root may use actual NTFS 8.3 components. Main captures
 * realpath first. Prove both spellings via the same live DB inode before using
 * the owner's exact canonical root for a pending or absent spool observation. */
export async function proveContext4NativeSpoolRoots(literalProfileRoot: string, ownedProfileRoot: string) {
  const literal = resolve(literalProfileRoot), canonical = resolve(ownedProfileRoot)
  assert.equal(normalized(await realpath(literal)), normalized(await realpath(canonical)))
  assert.equal(normalized(await realpath(canonical)), normalized(canonical))
  const anchors = [join(literal, 'storage', 'knowbook.db'), join(canonical, 'storage', 'knowbook.db')]
  const anchor = await opened(anchors, async files => {
    const before = await Promise.all(files.map(file => file.stat({ bigint: true })))
    sameOpenFile(before[0], before[1])
    const after = await Promise.all(files.map(file => file.stat({ bigint: true })))
    sameOpenFile(before[0], after[0]); sameOpenFile(before[1], after[1])
    return identity(before[0])
  })
  const spools = (operationId: string, attemptId: string) => {
    for (const value of [operationId, attemptId]) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    const suffix = join('storage', 'synced-exchanges-v1', operationId, attemptId)
    const paths = { literal: join(literal, suffix), canonical: join(canonical, suffix) }
    return { ...paths, aliases: [...new Set([paths.literal, paths.canonical])] }
  }
  return { literalProfileRoot: literal, canonicalProfileRoot: canonical, anchor, anchors, spools }
}
type Roots = Awaited<ReturnType<typeof proveContext4NativeSpoolRoots>>

/** Match the actual observed open to this operation/attempt, then independently
 * open observed/literal/canonical paths together and hash every genuine byte. */
export async function proveContext4ObservedSpoolFile(roots: Roots, operationId: string, attemptId: string,
  observations: readonly Observation[], expected: { readonly name: string; readonly sha256: string; readonly bytes: number }) {
  const spool = roots.spools(operationId, attemptId), canonicalFile = join(spool.canonical, ...expected.name.split('/'))
  const actual = observations.find(value => value.method === 'open' && normalized(value.path) === normalized(canonicalFile))
  assert.ok(actual, 'No native open of the exact canonical spool file: ' + JSON.stringify({ spool, observations, rootIdentity: roots.anchor }))
  const paths = [actual.path, join(spool.literal, ...expected.name.split('/')), canonicalFile]
  const proof = await opened(paths, async files => {
    const before = await Promise.all(files.map(file => file.stat({ bigint: true })))
    for (const stat of before) { sameOpenFile(before[0], stat); assert.equal(stat.size, BigInt(expected.bytes)) }
    const bytes = await Promise.all(files.map(file => file.readFile()))
    for (const value of bytes) { assert.equal(value.length, expected.bytes); assert.equal(createHash('sha256').update(value).digest('hex'), expected.sha256) }
    const after = await Promise.all(files.map(file => file.stat({ bigint: true })))
    for (let index = 0; index < after.length; index++) {
      sameOpenFile(before[index], after[index]); assert.equal(after[index].size, before[index].size)
      assert.equal(after[index].mtimeNs, before[index].mtimeNs); assert.equal(after[index].ctimeNs, before[index].ctimeNs)
    }
    return { ...identity(before[0]), bytes: expected.bytes, sha256: expected.sha256 }
  })
  return { rootIdentity: roots.anchor, spool, observedOpen: actual, paths, fileIdentity: proof }
}

/** An absent directory has no FD to invent. The preproved exact profile and
 * operation/attempt suffix identify both names; real native ENOENT is checked
 * independently after the producer has actually probed the canonical spool. */
export async function proveContext4ObservedMissingSpool(roots: Roots, operationId: string, attemptId: string, observations: readonly Observation[]) {
  const spool = roots.spools(operationId, attemptId)
  const actual = observations.find(value => /^(?:lstat|stat|realpath)(?:Sync)?(?:\.native)?$/.test(value.method)
    && normalized(value.path) === normalized(spool.canonical))
  assert.ok(actual, 'No native lookup of the exact canonical missing spool: ' + JSON.stringify({ spool, observations, rootIdentity: roots.anchor }))
  for (const path of spool.aliases) await assert.rejects(lstat(path), { code: 'ENOENT' })
  return { rootIdentity: roots.anchor, spool, observedLookup: actual, missingAliases: spool.aliases }
}
