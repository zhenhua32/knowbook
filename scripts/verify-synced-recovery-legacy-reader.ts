import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import extractZip from 'extract-zip'
import { KnowbookStore } from '../src/main/database/store'
import { applySyncedHostCommand } from '../src/main/database/synced-host-final'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { RECOVERY_BOUNDARY_CHANNEL, recoveryEpochMarkerId } from '../src/main/database/synced-recovery-boundary-model'
import { assertSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { createRequest, created, editCreatedGroup, edit } from '../tests/helpers/synced-host-command-create-fixture'

// Explicit source-isolation oracle, never part of npm test or a UI launch.
// Run only in the root validation lane after integration. This script prepares
// a real current Main boundary; it never fabricates a receipt or a legacy reader.
const OLD_COMMIT = '92c4766d551c625ac6e1708331c5697da94a186b'
const here = dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--workspace-root', 'Only an optional explicit workspace-root is accepted')
const root = args.length ? resolve(args[1]) : resolve(here, '..')
const startedAt = new Date().toISOString()
// Short paths leave room for archived source names and SQLite sidecars on Windows.
const evidence = join(root, 'test-results', 'rec-legacy', randomUUID().slice(0, 8)), oldSource = join(evidence, 'old')
let ownsEvidence = false
const require = createRequire(pathToFileURL(join(root, 'package.json'))), loader = pathToFileURL(require.resolve('tsx')).href
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hashFile = (file: string) => hash(readFileSync(file))
const fresh = (file: string, value: unknown) => writeFileSync(file,
  Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
function git(values: string[], binary = false): string | Buffer {
  return execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...values], {
    cwd: root, windowsHide: true, maxBuffer: 256 * 1024 * 1024, encoding: binary ? undefined : 'utf8'
  })
}
interface GitEntry { path: string; mode: string; blob: string }
function treeEntries(commit: string): GitEntry[] {
  return String(git(['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean).map(value => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(value)
    assert.ok(match, 'The complete pinned tree must contain original regular source blobs only')
    const path = match[3]
    assert.ok(!isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
    return { mode: match[1], blob: match[2], path }
  })
}
function assertArchive(entries: GitEntry[]) {
  const actual: string[] = []
  const walk = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (path === 'node_modules') continue // The explicit dependency junction is not source authority.
      const file = join(directory, entry.name), stat = lstatSync(file)
      assert.equal(stat.isSymbolicLink(), false, 'Archived source cannot be substituted: ' + path)
      if (stat.isDirectory()) walk(file, path + '/')
      else { assert.equal(stat.isFile(), true); actual.push(path) }
    }
  }
  walk(oldSource)
  assert.deepEqual(actual.sort(), entries.map(entry => entry.path).sort(), 'All and only the complete pinned Git tree is extracted')
  return entries.map(entry => {
    const bytes = readFileSync(join(oldSource, ...entry.path.split('/')))
    const blob = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex')
    assert.equal(blob, entry.blob, 'Exact original Git blob bytes, without EOL normalization: ' + entry.path)
    return { ...entry, bytes: bytes.length, sha256: hash(bytes) }
  })
}
function currentSources() {
  const paths = String(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'tests/helpers',
    'scripts/verify-synced-recovery-legacy-reader.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.test.json']))
    .split('\0').filter(Boolean)
  return [...new Set(paths)].sort().map(path => {
    const file = join(root, ...path.split('/')), stat = lstatSync(file)
    assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true)
    return { path, bytes: stat.size, sha256: hashFile(file) }
  })
}
function files(file: string) {
  return ['', '-wal', '-shm', '-journal'].map(suffix => {
    const path = file + suffix, exists = existsSync(path)
    if (exists) { assert.equal(lstatSync(path).isSymbolicLink(), false); assert.equal(lstatSync(path).isFile(), true) }
    return { suffix, exists, bytes: exists ? lstatSync(path).size : null, sha256: exists ? hashFile(path) : null }
  })
}
function standalone(file: string): void {
  const db = new Database(file, { fileMustExist: true })
  try { db.pragma('journal_mode=DELETE') } finally { db.close() }
}
function errorFacts(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null } : { value: String(error) }
}

async function produce() {
  const beforeFile = join(evidence, 'before.db'), afterFile = join(evidence, 'after.db')
  const store = new KnowbookStore(join(evidence, 'producer.db'))
  try {
    const documentId = store.createDocument(null), otherDocumentId = store.createDocument(null), selected = randomUUID()
    for (const [id, first] of [[documentId, selected], [otherDocumentId, randomUUID()]]) store.updateDocument(id, {
      title: id === documentId ? 'Boundary source' : 'Boundary second host', summary: '', blocks: [first, randomUUID()].map((blockId, index) => ({
        id: blockId, type: 'paragraph' as const, content: 'Real source paragraph ' + index, checked: false, depth: 0, parentBlockId: null
      }))
    })
    const db = store.getUnsafeDatabaseHandle(), input = createRequest(db, { documentId, selectedRootIds: [selected] })
    const createAck = created(applySyncedHostCommand(db, input))
    editCreatedGroup(db, input.action.groupId)
    const hostEdit = edit(db, [documentId, otherDocumentId], 'Real shared host edit')
    assert.ok(hostEdit.ack.historyToken)
    const originals = {
      operations: db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(),
      pins: db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all(),
      groupHistory: db.prepare('SELECT * FROM synced_group_history ORDER BY group_id,position').all(),
      hostMappings: db.prepare('SELECT * FROM synced_host_history_documents ORDER BY history_id,document_id').all()
    }
    assert.ok(originals.operations.length >= 3 && originals.pins.length >= 1 && originals.groupHistory.length >= 1 && originals.hostMappings.length >= 3)
    await db.backup(beforeFile)
    const workspace = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string }
    const stamps = (db.prepare('SELECT updated_at FROM documents').all() as Array<{ updated_at: string }>).map(row => Date.parse(row.updated_at))
    const allocation = { operationId: randomUUID(), expectedWorkspaceScope: workspace.workspace_scope, expectedRecoveryEpoch: workspace.recovery_epoch,
      workspaceScope: workspace.workspace_scope, recoveryEpoch: randomUUID(), acceptedAt: new Date().toISOString(),
      documentBoundary: new Date(Math.max(Date.now(), ...stamps) + 60_000).toISOString() }
    const receipt = db.transaction(() => {
      assert.equal(db.inTransaction, true)
      return advanceSyncedRecoveryEpoch(db, allocation)
    }).immediate()
    assert.ok(receipt, 'Actual nonempty Main history yields its own persisted boundary receipt')
    const boundary = db.transaction(() => {
      assertSyncedLifecycleSchema(db)
      const records = assertSyncedRecoveryBoundaryRecords(db)
      assert.equal(records.boundaries.size, 1)
      assert.ok(records.hostCuts.has(createAck.historyToken!) && records.hostCuts.has(hostEdit.ack.historyToken!))
      return records.boundaries.get(allocation.operationId)
    })()
    assert.ok(boundary)
    const anchor = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(recoveryEpochMarkerId(allocation.operationId)) as { channel: string; state: string }
    assert.equal(anchor.channel, RECOVERY_BOUNDARY_CHANNEL); assert.equal(anchor.state, 'possible')
    assert.equal(db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=?').get(recoveryEpochMarkerId(allocation.operationId)), undefined)
    assert.equal(db.prepare('SELECT 1 FROM synced_group_history LIMIT 1').get(), undefined)
    assert.equal(db.prepare('SELECT 1 FROM synced_host_history_documents LIMIT 1').get(), undefined)
    await db.backup(afterFile)
    fresh(join(evidence, 'actual-producer.json'), { allocation, receipt, boundary, anchor, createAck, hostEdit, originals })
  } finally { store.destroy() }
  // Freeze independent consistent backups only after their own journal mode is
  // finalized. The old reader is never permitted to open the live producer DB.
  standalone(beforeFile); standalone(afterFile)
  return { beforeFile, afterFile }
}

function legacyDriver(): string {
  return `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [oldSource,beforeFile,afterFile]=process.argv.slice(2);
const require=createRequire(pathToFileURL(join(oldSource,'package.json'))), Database=require('better-sqlite3');
const {assertSyncedLifecycleSchema}=await import(pathToFileURL(join(oldSource,'src/main/database/synced-lifecycle-schema.ts')).href);
const {KnowbookStore}=await import(pathToFileURL(join(oldSource,'src/main/database/store.ts')).href);
function inspect(file) {
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try {
    db.pragma('foreign_keys=ON'); assert.equal(db.pragma('user_version',{simple:true}),27);
    db.transaction(()=>assertSyncedLifecycleSchema(db))();
  } finally {db.close();}
}
inspect(beforeFile);
let lifecycleError=null,storeError=null;
try {inspect(afterFile);} catch(error) {lifecycleError=String(error);}
assert.match(lifecycleError??'',/没有准确参与组的发布记录/,'Original old schema27 lifecycle reader must reject the real new zero-member anchor');
try {const store=new KnowbookStore(afterFile);store.destroy();} catch(error) {storeError=String(error);}
assert.match(storeError??'',/没有准确参与组的发布记录/,'Original old cold Store must reject at its actual lifecycle gate, before generic sync support checks');
process.stdout.write(JSON.stringify({status:'passed',baselineLifecycleAccepted:true,lifecycleError,storeError,oldSource}));
`
}

async function main() {
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1'); assert.ok(process.versions.electron, 'Use Electron Node with the real native SQLite ABI; no BrowserWindow is created')
  mkdirSync(dirname(evidence), { recursive: true }); mkdirSync(evidence); ownsEvidence = true; mkdirSync(oldSource)
  const oldCommit = String(git(['rev-parse', OLD_COMMIT + '^{commit}'])).trim(); assert.equal(oldCommit, OLD_COMMIT)
  const oldTree = String(git(['rev-parse', OLD_COMMIT + '^{tree}'])).trim(), currentHead = String(git(['rev-parse', 'HEAD'])).trim()
  const entries = treeEntries(oldCommit); assert.ok(entries.length > 0)
  const zip = join(evidence, 'old-source.zip')
  fresh(zip, git(['archive', '--format=zip', oldCommit], true)); await extractZip(zip, { dir: oldSource })
  const archivedBefore = assertArchive(entries)
  assert.equal(readFileSync(join(oldSource, 'src/main/database/schema-version.ts'), 'utf8').trim(), 'export const CURRENT_DATABASE_SCHEMA_VERSION = 27')
  assert.equal(existsSync(join(oldSource, 'src/main/database/synced-recovery-boundary-read.ts')), false)
  const dependencies = join(root, 'node_modules'), dependencyAlias = join(oldSource, 'node_modules')
  symlinkSync(dependencies, dependencyAlias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(realpathSync.native(dependencyAlias), realpathSync.native(dependencies))
  const sourceManifest = { oldCommit, oldTree, currentHead, startedAt, files: archivedBefore,
    zip: { bytes: lstatSync(zip).size, sha256: hashFile(zip) }, dependencyAlias, dependencyTarget: dependencies,
    sourceAuthority: 'Complete original Git ZIP; every extracted file authenticated against the original tree blob SHA-1' }
  fresh(join(evidence, 'source-before.json'), sourceManifest)
  const currentBefore = currentSources(); fresh(join(evidence, 'current-before.json'), currentBefore)
  const { beforeFile, afterFile } = await produce()
  const probes = join(evidence, 'probe'); mkdirSync(probes)
  const beforeProbe = join(probes, 'before.db'), afterProbe = join(probes, 'after.db')
  copyFileSync(beforeFile, beforeProbe, constants.COPYFILE_EXCL); copyFileSync(afterFile, afterProbe, constants.COPYFILE_EXCL)
  assert.equal(hashFile(beforeProbe), hashFile(beforeFile)); assert.equal(hashFile(afterProbe), hashFile(afterFile))
  // Keep original before/after backups even if a defective old reader changes
  // its exact-byte independent input. Both originals and probes are compared.
  const bytesBefore = { before: files(beforeFile), after: files(afterFile), beforeProbe: files(beforeProbe), afterProbe: files(afterProbe) }
  const driver = join(evidence, 'old-driver.mjs'); fresh(driver, legacyDriver())
  const processResult = spawnSync(process.execPath, ['--import', loader, driver, oldSource, beforeProbe, afterProbe], {
    cwd: oldSource, windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TSX_TSCONFIG_PATH: join(oldSource, 'tsconfig.node.json') }
  })
  const processReport = { executable: process.execPath, cwd: oldSource, driverSha256: hashFile(driver), status: processResult.status,
    signal: processResult.signal, error: processResult.error?.message ?? null, stdout: processResult.stdout, stderr: processResult.stderr }
  fresh(join(evidence, 'old-process.json'), processReport)
  // Record preservation before asserting the oracle outcome, so a failed old
  // reader still leaves actual before/after source and DB evidence to inspect.
  const bytesAfter = { before: files(beforeFile), after: files(afterFile), beforeProbe: files(beforeProbe), afterProbe: files(afterProbe) }, archivedAfter = assertArchive(entries)
  fresh(join(evidence, 'preservation.json'), { bytesBefore, bytesAfter, archivedAfter })
  assert.deepEqual(bytesAfter, bytesBefore, 'Both complete original before/after DB bytes and sidecars remain unchanged by real old reads')
  assert.deepEqual(archivedAfter, archivedBefore); assert.deepEqual(currentSources(), currentBefore)
  assert.equal(hashFile(zip), sourceManifest.zip.sha256)
  assert.equal(readdirSync(probes).some(name => name.startsWith('after.db.pre-migration')), false)
  assert.equal(processResult.error, undefined); assert.equal(processResult.signal, null); assert.equal(processResult.status, 0, JSON.stringify(processReport))
  const outcome = JSON.parse(processResult.stdout) as { status: string; baselineLifecycleAccepted: boolean }
  assert.equal(outcome.status, 'passed'); assert.equal(outcome.baselineLifecycleAccepted, true)
  fresh(join(evidence, 'summary.json'), { status: 'passed', oldCommit, oldTree, currentHead, startedAt, completedAt: new Date().toISOString(),
    sourceFiles: archivedBefore.length, beforeFile, afterFile, beforeProbe, afterProbe, outcome, bytesBefore, bytesAfter,
    limitations: 'Source-isolated original schema27 lifecycle and cold Store oracle only; no installed-client UI or complete restoration installer is claimed.' })
  process.stdout.write(JSON.stringify({ status: 'passed', evidence, oldCommit, sourceFiles: archivedBefore.length }) + '\n')
}

main().catch(error => {
  try { if (ownsEvidence) fresh(join(evidence, 'failure.json'), errorFacts(error)) } catch { /* Preserve the primary error. */ }
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n'); process.exitCode = 1
})
