import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import extractZip from 'extract-zip'
import { KnowbookStore } from '../src/main/database/store'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { createdGroup27, retireFixture27 } from '../tests/helpers/synced-lifecycle-fixture'

// Run only after integration, under the repository's Electron Node runtime.
// This is a source-isolation verifier, not an installed-client or UI test.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Keep backup filenames and their SQLite sidecars within Windows path limits.
const startedAt = new Date().toISOString()
const evidence = join(root, 'test-results', 'schema27-legacy-readers', randomUUID())
const oldSource = join(evidence, 'legacy-6d61134')
const require = createRequire(import.meta.url)
const loader = pathToFileURL(require.resolve('tsx')).href
const encode = canonicalSyncedPortableJson
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sidecars = ['', '-wal', '-shm', '-journal']
function git(args: string[], binary = false): string | Buffer {
  return execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    encoding: binary ? undefined : 'utf8' })
}
function files(file: string) {
  return sidecars.map(suffix => ({ suffix, exists: existsSync(file + suffix),
    sha256: existsSync(file + suffix) ? sha256(file + suffix) : null }))
}
function inspection(file: string) {
  const copyRoot = join(evidence, 'inspection', randomUUID()), copy = join(copyRoot, 'workspace.db')
  mkdirSync(copyRoot, { recursive: true })
  // Inspect a private copy. A read/close of the source WAL could checkpoint
  // the very evidence whose byte-preservation is being verified.
  for (const suffix of ['', '-wal', '-journal']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
  // A hot rollback journal may need recovery. Only this disposable independent
  // copy is writable; the source and its sidecars are never opened here.
  const db = new Database(copy, { fileMustExist: true })
  try {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map(({ name }) => {
        assert.match(name, /^[a-z_0-9]+$/i)
        const rows = db.prepare(`SELECT * FROM "${name}"`).all().map(row => encode(row)).sort()
        return { name, rows }
      })
    return { version: db.pragma('user_version', { simple: true }), schema, tables }
  } finally { db.close() }
}
function runChild(name: string, script: string, args: string[], cwd = oldSource) {
  const path = join(evidence, `${name}.mjs`)
  writeFileSync(path, script)
  const result = spawnSync(process.execPath, ['--import', loader, path, ...args], { cwd, windowsHide: true,
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const report = { name, cwd, scriptSha256: sha256(path), status: result.status,
    signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr }
  writeFileSync(join(evidence, `${name}-process.json`), JSON.stringify(report, null, 2))
  assert.equal(result.error, undefined, JSON.stringify(report))
  assert.equal(result.status, 0, JSON.stringify(report))
  return JSON.parse(result.stdout) as Record<string, unknown>
}
function standalone(file: string) {
  const db = new Database(file)
  try { db.pragma('journal_mode=DELETE') } finally { db.close() }
}

async function main() {
  mkdirSync(oldSource, { recursive: true })
  const oldCommit = String(git(['rev-parse', '6d61134b917d88753bdbc72a5cafe6e3d81fc216^{commit}'])).trim()
  const oldTree = String(git(['rev-parse', `${oldCommit}^{tree}`])).trim()
  const paths = String(git(['ls-tree', '-r', '-z', '--name-only', oldCommit])).split('\0').filter(Boolean)
  assert.ok(paths.every(path => !path.startsWith('/') && !path.includes('..') && !path.includes('\\')))
  const archive = join(evidence, 'legacy-6d61134-full-source.tar')
  writeFileSync(archive, git(['archive', '--format=tar', oldCommit], true))
  // Windows' system tar cannot reliably decode all UTF-8 Git path names.
  // Keep the complete TAR evidence and extract an equivalent full Git ZIP.
  const extractionArchive = join(evidence, 'legacy-6d61134-full-source.zip')
  writeFileSync(extractionArchive, git(['archive', '--format=zip', oldCommit], true))
  await extractZip(extractionArchive, { dir: oldSource })
  const archivedFiles = paths.map(path => ({ path, sha256: sha256(join(oldSource, path)) }))
  assert.equal(readFileSync(join(oldSource, 'src/main/database/schema-version.ts'), 'utf8').trim(),
    'export const CURRENT_DATABASE_SCHEMA_VERSION = 26')
  symlinkSync(join(root, 'node_modules'), join(oldSource, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(evidence, 'legacy-source-manifest.json'), JSON.stringify({ oldCommit, oldTree,
    startedAt, archiveSha256: sha256(archive), extractionArchiveSha256: sha256(extractionArchive),
    extraction: 'extract-zip with UTF-8 Git paths', files: archivedFiles, dependencyDirectory: join(root, 'node_modules') }, null, 2))
  const oldStore = pathToFileURL(join(oldSource, 'src/main/database/store.ts')).href
  const oldRestore = pathToFileURL(join(oldSource, 'src/main/database/restore-maintenance.ts')).href
  const real26 = join(evidence, 'real26.db')
  runChild('create-real26', `
    const { KnowbookStore } = await import(${JSON.stringify(oldStore)});
    const store = new KnowbookStore(process.argv[2]);
    const documentId = store.createDocument(null);
    store.updateDocument(documentId,{title:'Original 26 source',summary:'Exact data',blocks:[{id:' old:opaque\\0 ',type:'paragraph',content:'Preserve old body',checked:false,depth:0,parentBlockId:null}]});
    const version = store.getUnsafeDatabaseHandle().pragma('user_version',{simple:true});
    store.destroy(); process.stdout.write(JSON.stringify({version}));
  `, [real26])
  standalone(real26)
  const before26 = inspection(real26)
  assert.equal(before26.version, 26)
  const bad26 = join(evidence, 'bad26.db')
  copyFileSync(real26, bad26)
  const bad = new Database(bad26)
  bad.exec('DROP TRIGGER trg_synced_identity_delete'); bad.close()
  const badBefore = files(bad26), badRowsBefore = inspection(bad26)
  assert.throws(() => new KnowbookStore(bad26), /schema26.*关键结构/)
  assert.deepEqual(files(bad26), badBefore)
  assert.deepEqual(inspection(bad26), badRowsBefore)
  assert.equal(readdirSync(evidence).some(name => name.startsWith('bad26.db.pre-migration')), false)
  const current = new KnowbookStore(real26); current.destroy()
  const after27 = inspection(real26)
  assert.equal(after27.version, 27)
  for (const table of before26.tables) assert.deepEqual(after27.tables.find(item => item.name === table.name), table)
  for (const entry of before26.schema) assert.ok(after27.schema.some(item => encode(item) === encode(entry)))
  const copies = readdirSync(evidence).filter(name => name.startsWith('real26.db.pre-migration-v26-to-v27-'))
  assert.equal(copies.length, 1)
  assert.deepEqual(inspection(join(evidence, copies[0])), before26)
  writeFileSync(join(evidence, 'real26-migration.json'), JSON.stringify({ oldCommit, oldTree,
    before26, after27, safetyCopy: copies[0], bad26FilesBefore: badBefore, bad26FilesAfter: files(bad26) }, null, 2))

  const cases: Array<{ name: string; file: string; restore: boolean }> = []
  for (const mode of ['empty', 'active', 'retired'] as const) {
    const file = join(evidence, `${mode}27.db`), store = new KnowbookStore(file)
    if (mode !== 'empty') {
      const fixture = createdGroup27(store.getUnsafeDatabaseHandle())
      if (mode === 'retired') retireFixture27(store.getUnsafeDatabaseHandle(), fixture)
    }
    store.destroy(); standalone(file)
    cases.push({ name: mode, file, restore: true })
  }
  const walFile = join(evidence, 'retired27-only-in-wal.db'), walStore = new KnowbookStore(walFile)
  walStore.destroy()
  // Changing DELETE→WAL itself changes the main DB header. Finish that setup
  // and checkpoint/close it before freezing the main-file hash; the child then
  // only appends the actual group transaction to the established WAL mode.
  const walBaseline = new Database(walFile)
  try { walBaseline.pragma('journal_mode=WAL'); walBaseline.pragma('wal_checkpoint(TRUNCATE)') } finally { walBaseline.close() }
  const mainBeforeWal = sha256(walFile)
  const currentFixture = pathToFileURL(join(root, 'tests/helpers/synced-lifecycle-fixture.ts')).href
  const sqlitePath = require.resolve('better-sqlite3')
  runChild('write-real27-wal', `
    import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);
    const Database=require(${JSON.stringify(sqlitePath)});
    const {createdGroup27,retireFixture27}=await import(${JSON.stringify(currentFixture)});
    const db=new Database(process.argv[2]); db.pragma('foreign_keys=ON');
    if(db.pragma('journal_mode',{simple:true})!=='wal') throw new Error('WAL mode must already be part of the frozen main-file baseline');
    db.pragma('wal_autocheckpoint=0');
    const created=createdGroup27(db); retireFixture27(db,created);
    process.stdout.write(JSON.stringify({groupId:created.groupId})); process.exit(0);
  `, [walFile], root)
  assert.equal(sha256(walFile), mainBeforeWal, 'The retired group must exist only in real committed WAL')
  assert.ok(existsSync(walFile + '-wal')); assert.ok(existsSync(walFile + '-shm'))
  cases.push({ name: 'retired-only-in-wal', file: walFile, restore: false })
  const journalFile = join(evidence, 'hot-rollback-journal27.db'), journalStore = new KnowbookStore(journalFile)
  journalStore.destroy(); standalone(journalFile)
  runChild('write-real27-hot-journal', `
    import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);
    const Database=require(${JSON.stringify(sqlitePath)}); const db=new Database(process.argv[2]);
    db.pragma('journal_mode=DELETE'); db.pragma('synchronous=FULL'); db.pragma('cache_size=1');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('hot-journal-uncommitted','x'.repeat(2*1024*1024),new Date().toISOString());
    process.stdout.write(JSON.stringify({uncommitted:true})); process.exit(0);
  `, [journalFile], root)
  assert.ok(existsSync(journalFile + '-journal'))
  cases.push({ name: 'hot-rollback-journal', file: journalFile, restore: false })
  for (const item of cases) {
    const bytesBefore = files(item.file), rowsBefore = inspection(item.file)
    assert.equal(rowsBefore.version, 27)
    const profile = join(evidence, `restore-target-${item.name}`), target = join(profile, 'storage', 'knowbook.db')
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, 'Original target sentinel')
    const targetBefore = files(target)
    const result = runChild(`old-reader-${item.name}`, `
      const {KnowbookStore}=await import(${JSON.stringify(oldStore)});
      const {restoreKnowbookDatabase}=await import(${JSON.stringify(oldRestore)});
      let storeError=null,restoreError=null,stopCalled=false;
      try { const store=new KnowbookStore(process.argv[2]); store.destroy(); } catch(error) {storeError=String(error);}
      if(!storeError?.includes('schema version 27 is newer than supported version 26')) throw new Error('Old Store did not reject by the version boundary: '+storeError);
      if(process.argv[4]==='restore') {
        try {await restoreKnowbookDatabase({userDataRoot:process.argv[3],backupPath:process.argv[2],stopProcesses:async()=>{stopCalled=true;return[];}});}
        catch(error){restoreError=String(error);}
        if(!restoreError?.includes('不支持的 KnowBook schema 版本 27')||stopCalled) throw new Error('Old restorer did not reject before process/write actions: '+restoreError);
      }
      process.stdout.write(JSON.stringify({storeError,restoreError,stopCalled}));
    `, [item.file, profile, item.restore ? 'restore' : 'store-only'])
    assert.deepEqual(files(item.file), bytesBefore)
    assert.deepEqual(inspection(item.file), rowsBefore)
    assert.deepEqual(files(target), targetBefore)
    writeFileSync(join(evidence, `${item.name}-verified.json`), JSON.stringify({ oldCommit, oldTree,
      source: relative(root, item.file), bytesBefore, bytesAfter: files(item.file), rowsBefore, result,
      targetBefore, targetAfter: files(target), restoreVerified: item.restore }, null, 2))
  }
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ status: 'passed', oldCommit, oldTree,
    startedAt, cases, sourceIsolation: 'All old reader imports come from the complete archived commit; dependencies are shared.',
    currentHead: String(git(['rev-parse', 'HEAD'])).trim(), completedAt: new Date().toISOString() }, null, 2))
  process.stdout.write(JSON.stringify({ status: 'passed', evidence, archivedFiles: archivedFiles.length, cases: cases.length }) + '\n')
}

try { await main() }
catch (error) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error),
    stack: error instanceof Error ? error.stack : undefined }, null, 2))
  throw error
}
