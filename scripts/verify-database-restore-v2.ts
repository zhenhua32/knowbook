import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import extractZip from 'extract-zip'

// Standalone, explicitly invoked compatibility verification. npm test must not
// depend on a shallow clone already containing this historical Git object.
const OLD_COMMIT = 'a62a69807b57375fb7b0e359102244d68795a657'
const cases = ['real-schema25-database-restore-fresh-boundary'] as const
const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--workspace-root', 'Only an optional explicit workspace-root is accepted')
const root = args.length ? resolve(args[1]) : resolve(here, '..')
const startedAt = new Date().toISOString()
const evidence = join(root, 'test-results', 'database-restore-v2-compat', randomUUID())
let ownsEvidence = false
const oldSource = join(evidence, 'legacy-a62a698')
const helperFile = join(here, 'fixtures', 'database-restore-v2', 'evidence.mjs')
const legacyDriver = join(here, 'fixtures', 'database-restore-v2', 'legacy-child.mjs')
const currentDriver = join(here, 'fixtures', 'database-restore-v2', 'current-child.mjs')
const require = createRequire(pathToFileURL(join(root, 'package.json')))
const loader = pathToFileURL(require.resolve('tsx')).href
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const shaFile = (file: string) => sha(readFileSync(file))
const fresh = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
function git(args: string[], binary = false): string | Buffer {
  return execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
    cwd: root, windowsHide: true, maxBuffer: 256 * 1024 * 1024, encoding: binary ? undefined : 'utf8'
  })
}
interface SourceEntry { path: string; mode: string; blob: string; bytes: number; sha256: string }
function treeEntries(commit: string): Array<Omit<SourceEntry, 'bytes' | 'sha256'>> {
  return String(git(['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean).map(value => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(value)
    assert.ok(match, 'The complete pinned source archive contains regular Git blobs only')
    const path = match[3], segments = path.split('/')
    assert.ok(!isAbsolute(path) && !path.includes('\\') && segments.every(part => part !== '' && part !== '.' && part !== '..'), 'Git source paths remain inside the archive')
    return { mode: match[1], blob: match[2], path }
  })
}
function assertArchive(entries: Array<Omit<SourceEntry, 'bytes' | 'sha256'>>): SourceEntry[] {
  const actual: string[] = []
  function walk(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (path === 'node_modules') continue // The single explicit dependency alias, never source authority.
      const file = join(directory, entry.name), stat = lstatSync(file)
      assert.equal(stat.isSymbolicLink(), false, 'No substituted/symlinked source: ' + path)
      if (stat.isDirectory()) walk(file, path + '/')
      else { assert.equal(stat.isFile(), true); actual.push(path) }
    }
  }
  walk(oldSource)
  assert.deepEqual(actual.sort(), entries.map(row => row.path).sort(), 'All and only complete original source blobs are present')
  return entries.map(entry => {
    const bytes = readFileSync(join(oldSource, ...entry.path.split('/')))
    const blob = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex')
    assert.equal(blob, entry.blob, 'Exact original Git blob bytes, without EOL normalization: ' + entry.path)
    return { ...entry, bytes: bytes.length, sha256: sha(bytes) }
  })
}
function currentSources(): Array<{ path: string; bytes: number; sha256: string }> {
  const paths = String(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'tests/helpers', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.test.json']))
    .split('\0').filter(Boolean)
  return [...new Set(paths)].sort().map(path => {
    const file = join(root, ...path.split('/')); assert.equal(lstatSync(file).isFile(), true)
    const bytes = readFileSync(file)
    return { path, bytes: bytes.length, sha256: sha(bytes) }
  })
}
function errorFacts(cause: unknown) {
  return cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack ?? null } : { value: String(cause) }
}

async function main() {
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'Use the same Electron Node runtime as the real native SQLite test lane')
  assert.ok(process.versions.electron, 'This explicit verifier uses Electron Node; it never creates a BrowserWindow')
  assert.ok(existsSync(join(root, 'node_modules')), 'Dependencies are installed by the ordinary CI install step')
  mkdirSync(dirname(evidence), { recursive: true })
  mkdirSync(evidence, { recursive: false })
  ownsEvidence = true
  mkdirSync(oldSource, { recursive: false })
  const helpers = await import(pathToFileURL(helperFile).href)
  const oldCommit = String(git(['rev-parse', OLD_COMMIT + '^{commit}'])).trim()
  assert.equal(oldCommit, OLD_COMMIT, 'CI must explicitly fetch the pinned complete historical commit')
  const oldTree = String(git(['rev-parse', oldCommit + '^{tree}'])).trim()
  const currentHead = String(git(['rev-parse', 'HEAD'])).trim()
  const entries = treeEntries(oldCommit)
  assert.equal(entries.length, 1314, 'The exact pinned complete source inventory is retained')
  assert.equal(new Set(entries.map(row => row.path)).size, entries.length)
  const tar = join(evidence, 'legacy-a62a698-full-source.tar'), zip = join(evidence, 'legacy-a62a698-full-source.zip')
  fresh(tar, git(['archive', '--format=tar', oldCommit], true))
  fresh(zip, git(['archive', '--format=zip', oldCommit], true))
  await extractZip(zip, { dir: oldSource })
  const before = assertArchive(entries)
  assert.equal(readFileSync(join(oldSource, 'src/main/database/schema-version.ts'), 'utf8').trim(), 'export const CURRENT_DATABASE_SCHEMA_VERSION = 25')
  const original = readFileSync(join(oldSource, 'src/main/backup/v2-format.ts'), 'utf8')
  assert.ok(original.includes("export const BACKUP_V2 = '2'"), 'The exact old archive contains its real V2 codec')
  assert.ok(original.includes("unsupported backupFormatVersion"), 'The real old reader enforces its version gate')
  symlinkSync(join(root, 'node_modules'), join(oldSource, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const sourceManifest = { status: 'source-verified', oldCommit, oldTree, currentHead, startedAt,
    archive: { path: tar, bytes: lstatSync(tar).size, sha256: shaFile(tar) },
    extractionArchive: { path: zip, bytes: lstatSync(zip).size, sha256: shaFile(zip) },
    extraction: 'UTF-8 Git ZIP; every extracted source also verified against the complete Git tree blob SHA-1',
    files: before, dependencyAlias: { path: join(oldSource, 'node_modules'), target: join(root, 'node_modules') },
    driverInputs: [fileURLToPath(import.meta.url), helperFile, legacyDriver, currentDriver].map(path => ({ path, bytes: lstatSync(path).size, sha256: shaFile(path) })) }
  fresh(join(evidence, 'legacy-source-before.json'), sourceManifest)
  const currentBefore = currentSources()
  fresh(join(evidence, 'current-source-before.json'), currentBefore)
  const reports: unknown[] = []
  let primaryFailure: unknown = null
  try {
    for (const caseName of cases) {
      const directory = join(evidence, caseName); mkdirSync(directory, { recursive: false })
      const input = join(directory, 'legacy-input.json')
      fresh(input, { caseName, oldCommit, oldSource, currentRoot: root, evidence: directory, currentDriver, loader })
      const processReport = await helpers.runChild({ name: 'legacy', script: legacyDriver, args: [input], cwd: oldSource,
        loader, tsconfig: join(oldSource, 'tsconfig.test.json'), evidence: directory })
      const report = JSON.parse(readFileSync(join(directory, 'case-result.json'), 'utf8')) as { status: unknown; caseName: unknown }
      assert.equal(report.status, 'passed'); assert.equal(report.caseName, caseName)
      reports.push({ ...report, legacyProcess: processReport })
    }
  } catch (cause) {
    primaryFailure = cause
    fresh(join(evidence, 'first-failure.json'), { status: 'failed', completedCases: reports.length, cause: errorFacts(cause), at: new Date().toISOString() })
  }
  let preservationFailure: unknown = null
  try {
    const after = assertArchive(entries)
    assert.deepEqual(after, before, 'The complete original source archive is unchanged after all old/current child processes')
    assert.deepEqual(currentSources(), currentBefore, 'Current product source/config inputs remain raw-identical during the verifier')
    assert.equal(shaFile(tar), sourceManifest.archive.sha256); assert.equal(shaFile(zip), sourceManifest.extractionArchive.sha256)
    for (const input of sourceManifest.driverInputs) assert.equal(shaFile(input.path), input.sha256, 'The exact reviewed driver inputs did not change during execution')
    fresh(join(evidence, 'legacy-source-after.json'), { oldCommit, oldTree, files: after, archivesUnchanged: true, currentInputsUnchanged: true, at: new Date().toISOString() })
  } catch (cause) {
    preservationFailure = cause
    fresh(join(evidence, 'preservation-failure.json'), { status: 'failed', cause: errorFacts(cause), primaryFailurePreserved: primaryFailure !== null, at: new Date().toISOString() })
  }
  const status = primaryFailure === null && preservationFailure === null && reports.length === cases.length ? 'passed' : 'failed'
  fresh(join(evidence, 'summary.json'), { status, oldCommit, oldTree, currentHead, startedAt, completedAt: new Date().toISOString(),
    cases: reports, expectedCaseCount: cases.length, completedCaseCount: reports.length,
    sourceFileCount: before.length, sourceManifestSha256: shaFile(join(evidence, 'legacy-source-before.json')),
    runtime: { executable: process.execPath, platform: process.platform, versions: process.versions },
    sourceIsolation: 'Legacy children import only complete a62a698 source; current children import only current product; dependency packages are shared.',
    claim: 'Actual complete pinned schema25 Store creates a genuine standalone database backup; current existing restore API migrates its private stage with original owner, preserves source/original raw bytes, and commits fixed epoch/ordinary CAS boundary twice. No installed legacy client or full synchronized-knowledge installer claim.',
    primaryFailure: primaryFailure === null ? null : errorFacts(primaryFailure), preservationFailure: preservationFailure === null ? null : errorFacts(preservationFailure) })
  if (primaryFailure !== null) throw primaryFailure
  if (preservationFailure !== null) throw preservationFailure
  assert.equal(reports.length, cases.length)
  process.stdout.write(JSON.stringify({ status: 'passed', evidence, oldCommit, cases: reports.length, sourceFiles: before.length }) + '\n')
}
main().catch(error => {
  // A new UUID directory preserves the first failure and is never overwritten.
  try {
    if (!ownsEvidence) {
      mkdirSync(dirname(evidence), { recursive: true })
      mkdirSync(evidence, { recursive: false })
      ownsEvidence = true
    }
    if (!existsSync(join(evidence, 'failure.json'))) fresh(join(evidence, 'failure.json'), { status: 'failed', oldCommit: OLD_COMMIT,
      startedAt, completedAt: new Date().toISOString(), cause: errorFacts(error) })
  } catch (recording) {
    process.stderr.write('Evidence recording also failed; original error below. ' + String(recording) + '\n')
  }
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n')
  process.exitCode = 1
})
