const { syncBuiltinESMExports } = require('node:module')
const { resolve, sep } = require('node:path')
const { fileURLToPath } = require('node:url')
const input = JSON.parse(process.argv[2]), fs = require('node:fs'), promises = require('node:fs/promises')
const oldRoot = resolve(input.oldRoot).toLowerCase(), oldRootAccesses = []
function old(value) {
  if (value instanceof URL && value.protocol === 'file:') value = fileURLToPath(value)
  if (Buffer.isBuffer(value)) value = value.toString()
  if (typeof value !== 'string') return false
  const path = resolve(value).toLowerCase(); return path === oldRoot || path.startsWith(oldRoot + sep)
}
for (const [object, names] of [[fs, ['openSync', 'lstatSync', 'statSync', 'readFileSync', 'realpathSync', 'realpath', 'existsSync', 'accessSync', 'readdirSync', 'opendirSync']],
  [promises, ['open', 'lstat', 'stat', 'readFile', 'realpath', 'access', 'readdir', 'opendir']]]) for (const name of names) {
  const original = object[name]
  const wrapped = function (...args) {
    if (old(args[0])) { oldRootAccesses.push({ name, path: String(args[0]) }); throw new Error('Retired original root IO is forbidden') }
    return original.apply(this, args)
  }
  Object.assign(wrapped, original)
  if (typeof original.native === 'function') wrapped.native = function (...args) {
    if (old(args[0])) { oldRootAccesses.push({ name: name + '.native', path: String(args[0]) }); throw new Error('Retired original root native realpath is forbidden') }
    return original.native.apply(this, args)
  }
  object[name] = wrapped
}
syncBuiltinESMExports()
;(async () => {
  const { reopenSealedCapsule2Source } = await import('../../src/main/database/restore-knowledge-capsule2-source-seal.ts')
  const { prepareCapsule2SettledPortableSource3, readCapsule2SettledPortableSource3 } = await import('../../src/main/database/restore-knowledge-assets3-settled-portable-owner.ts')
  const { publicationHash, publicationJson } = await import('../../src/main/sync/synced-publication-model.ts')
  const source = await reopenSealedCapsule2Source(input.source), prepared = await prepareCapsule2SettledPortableSource3(source)
  const value = await readCapsule2SettledPortableSource3(prepared.owner)
  process.stdout.write(JSON.stringify({ pid: process.pid, evidenceHash: value.evidenceHash, factsHash: publicationHash(publicationJson(value)),
    sourceManifestHash: value.binding.sourceManifestHash, sourceMaterialHash: value.binding.sourceMaterialHash, assetArchiveHash: value.binding.assetArchiveHash,
    records: value.jobs.flatMap(job => job.merged.map(item => ({ key: item.recordKey, bytes: publicationJson(item.record), hash: item.provenance.resultHash }))),
    oldRootAccesses, spoolSkipPermission: value.spoolSkipPermission, installPermit: value.installPermit }) + '\n')
})().catch(error => { process.stderr.write(String(error && error.stack || error)); process.exitCode = 1 })
