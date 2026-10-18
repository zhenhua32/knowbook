import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import extractZip from 'extract-zip'

// Standalone, explicitly invoked compatibility verification. npm test must not
// depend on a shallow clone already containing this historical Git object.
const OLD_COMMIT = '58991583bd59c932d242168223ca7b9e5d0cafd0'
const cases = ['group', 'document'] as const
const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--workspace-root', 'Only an optional explicit workspace-root is accepted')
const root = args.length ? resolve(args[1]) : resolve(here, '..')
const startedAt = new Date().toISOString()
const evidence = join(root, 'test-results', 'synced-tombstone-legacy-readers', randomUUID())
let ownsEvidence = false
const oldSource = join(evidence, 'legacy-5899158')
const legacyDriver = join(here, 'fixtures', 'tombstone-old', 'held.mjs')
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
  const paths = String(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.test.json']))
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


async function runHeld(input: string, directory: string, prepareBaseline: () => Promise<void>, applyDeletion: () => Promise<void>) {
  const stdoutPath=join(directory,'old-stdout.log'),stderrPath=join(directory,'old-stderr.log')
  fresh(stdoutPath,'');fresh(stderrPath,'')
  const stdout=createWriteStream(stdoutPath,{flags:'a'}),stderr=createWriteStream(stderrPath,{flags:'a'})
  const finished=Promise.all([new Promise<void>((resolve,reject)=>{stdout.once('finish',resolve);stdout.once('error',reject)}),new Promise<void>((resolve,reject)=>{stderr.once('finish',resolve);stderr.once('error',reject)})])
  const start=performance.now(),startedAt=new Date().toISOString()
  const child=spawn(process.execPath,['--import',loader,legacyDriver,input],{cwd:oldSource,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TSX_TSCONFIG_PATH:join(oldSource,'tsconfig.test.json')},stdio:['ignore','pipe','pipe','ipc']})
  child.stdout!.pipe(stdout);child.stderr!.pipe(stderr)
  let ready=false,bootstrapped=false,primary:unknown=null,launchError:unknown=null,timedOut=false
  let action:Promise<void>|null=null
  child.once('error',error=>{launchError=errorFacts(error)})
  child.on('message',message=>{
    if(!message||typeof message!=='object'||!('status' in message))return
    if(message.status==='bootstrap-ready'){
      if(bootstrapped){primary=new Error('Duplicate bootstrap');return}bootstrapped=true
      fresh(join(directory,'old-bootstrap.json'),message)
      action=(async()=>{try{await prepareBaseline();child.send({action:'prepare'})}catch(cause){primary=cause;if(child.connected)child.send({action:'abort'})}})()
      return
    }
    if(message.status!=='ready')return
    assert.equal(bootstrapped,true)
    if(ready){primary=new Error('Duplicate old child ready');return}ready=true
    fresh(join(directory,'old-ready.json'),message)
    action=(async()=>{try{await applyDeletion();child.send({action:'observe'})}catch(cause){primary=cause;if(child.connected)child.send({action:'abort'})}})()
  })
  const timer=setTimeout(()=>{timedOut=true;child.kill()},120_000)
  const terminal=await new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})))
  clearTimeout(timer);if(action)await action;await finished
  const report={pid:child.pid??null,cwd:oldSource,executable:process.execPath,script:legacyDriver,scriptSha256:shaFile(legacyDriver),input,inputSha256:shaFile(input),startedAt,finishedAt:new Date().toISOString(),wallMs:performance.now()-start,...terminal,ready,timedOut,launchError,primary:primary===null?null:errorFacts(primary),stdoutSha256:shaFile(stdoutPath),stderrSha256:shaFile(stderrPath)}
  fresh(join(directory,'old-process.json'),report)
  if(primary!==null)throw primary
  assert.equal(launchError,null);assert.equal(timedOut,false);assert.equal(ready,true);assert.equal(terminal.signal,null);assert.equal(terminal.exitCode,0,'Actual old process failed; original logs retained')
  return report
}
async function main(){
  assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');assert.ok(process.versions.electron)
  mkdirSync(dirname(evidence),{recursive:true});mkdirSync(evidence);ownsEvidence=true;mkdirSync(oldSource)
  const oldCommit=String(git(['rev-parse',OLD_COMMIT+'^{commit}'])).trim();assert.equal(oldCommit,OLD_COMMIT)
  const oldTree=String(git(['rev-parse',OLD_COMMIT+'^{tree}'])).trim(),entries=treeEntries(oldCommit),currentHead=String(git(['rev-parse','HEAD'])).trim()
  const tar=join(evidence,'legacy-5899158-full-source.tar'),zip=join(evidence,'legacy-5899158-full-source.zip')
  fresh(tar,git(['archive','--format=tar',oldCommit],true));fresh(zip,git(['archive','--format=zip',oldCommit],true));await extractZip(zip,{dir:oldSource})
  const before=assertArchive(entries);assert.equal(before.length,1513)
  assert.equal(readFileSync(join(oldSource,'src/main/database/schema-version.ts'),'utf8').trim(),'export const CURRENT_DATABASE_SCHEMA_VERSION = 27')
  assert.equal(existsSync(join(oldSource,'src/main/database/synced-logical-deletion-read.ts')),false)
  symlinkSync(join(root,'node_modules'),join(oldSource,'node_modules'),process.platform==='win32'?'junction':'dir')
  const sourceManifest={oldCommit,oldTree,currentHead,files:before,archiveSha256:shaFile(tar),zipSha256:shaFile(zip),driverInputs:[fileURLToPath(import.meta.url),legacyDriver].map(path=>({path,sha256:shaFile(path)}))}
  fresh(join(evidence,'legacy-source-before.json'),sourceManifest)
  const currentBefore=currentSources();fresh(join(evidence,'current-source-before.json'),currentBefore)
  const fixture=await import(pathToFileURL(join(root,'tests/helpers/synced-initial-incoming-fixture.ts')).href) as typeof import('../tests/helpers/synced-initial-incoming-fixture')
  const exchange=await import(pathToFileURL(join(root,'tests/helpers/synced-exchange-fixture.ts')).href) as typeof import('../tests/helpers/synced-exchange-fixture')
  const protocol=await import(pathToFileURL(join(root,'src/main/sync/synced-protocol5-model.ts')).href) as typeof import('../src/main/sync/synced-protocol5-model')
  const results:unknown[]=[]
  let primary:unknown=null
  try{for(const caseName of cases){const directory=join(evidence,caseName);mkdirSync(directory)
    await fixture.withIncomingFixture(async f=>{
      const S=f.A,A=f.newPristine('old-reader-independent-peer'),B=f.B,documentId=' old:ordinary '+randomUUID(),groupId=f.orphanId
      assert.ok(groupId);fixture.seedLocalDocument(S.db,documentId)
      const input=join(directory,'input.json');fresh(input,{caseName,oldSource,evidence:directory,file:B.file,groupId,documentId})
      const runExchange=(profile:typeof B)=>f.track(exchange.exchangeSyncedSnapshot(profile.db,f.input(randomUUID(),profile),exchange.runtime))
      const processReport=await runHeld(input,directory,async()=>{
        // The old Store is already genuinely open on pristine B before the
        // current Main installs any group. No production gate is removed.
        await f.send(S);fixture.accepted(await f.track(fixture.receiveInitialSyncedSnapshot(A.db,f.input(randomUUID(),A),exchange.runtime)));fixture.accepted(await f.receive())
        exchange.completed(await runExchange(A),'noop');exchange.completed(await runExchange(B),'noop')
        assert.equal((B.db.prepare('SELECT count(*) AS n FROM synced_group_pins WHERE group_id=?').get(groupId) as {n:number}).n,0)
      },async()=>{
        const path='/'+f.targetConfig.directory+'/manifest.json',raw=f.server.files.get(path);assert.ok(raw)
        const manifest=JSON.parse(raw.toString()) as import('../src/main/sync/synced-protocol5-model').SyncedProtocol5Snapshot['manifest']
        const records=new Map(Object.entries(manifest.entries).map(([key,digest])=>{const bytes=f.server.files.get('/'+f.targetConfig.directory+'/objects/'+digest+'.json');assert.ok(bytes);assert.equal(fixture.hash(bytes),digest);return [key,JSON.parse(bytes.toString()) as import('../src/main/sync/synced-protocol5-model').SyncedProtocol5Record]}))
        if(caseName==='document'){assert.equal(records.get('doc:'+documentId)?.kind,'document');records.set('doc:'+documentId,{kind:'deleted',id:documentId})}else{const live=records.get('group:'+groupId);assert.ok(live?.kind==='synced-group');records.set('group:'+groupId,{kind:'synced-group-deleted',id:groupId,creationId:live.creationId,previousHash:fixture.hash(fixture.encode(live)),deletedAt:new Date().toISOString()})}
        manifest.entries=Object.fromEntries([...records].map(([key,record])=>[key,fixture.hash(fixture.encode(record))]))
        protocol.validateSyncedProtocol5Snapshot(manifest,[...records].map(([key,record])=>({key,record})))
        for(const [key,record] of records)f.server.files.set('/'+f.targetConfig.directory+'/objects/'+manifest.entries[key]+'.json',Buffer.from(fixture.encode(record)))
        f.server.files.set(path,Buffer.from(fixture.encode(manifest)))
        const result=exchange.completed(await runExchange(B),'applied'),key=caseName==='document'?'doc:'+documentId:'group:'+groupId
        assert.ok(result.appliedKeys.includes(key)&&result.acceptedKeys.includes(key))
        const anchors=B.db.prepare("SELECT * FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'").all();assert.equal(anchors.length,1,'Document deletion cannot borrow a group denial anchor')
        fresh(join(directory,'actual-current-deletion.json'),{result,anchors,deletedDocument:B.db.prepare('SELECT * FROM documents WHERE id=?').get(documentId)??null,group:B.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(groupId),canonical:B.db.prepare('SELECT * FROM synced_group_blocks WHERE group_id=?').all(groupId)})
      })
      const outcome=JSON.parse(readFileSync(join(directory,'old-result.json'),'utf8'));assert.equal(outcome.status,'passed');assert.equal(outcome.caseName,caseName)
      results.push({caseName,processReport,outcome})
    },{orphan:true})
  }}catch(cause){primary=cause;fresh(join(evidence,'first-failure.json'),errorFacts(cause))}
  let preservation:unknown=null
  try{assert.deepEqual(assertArchive(entries),before);assert.deepEqual(currentSources(),currentBefore);assert.equal(shaFile(tar),sourceManifest.archiveSha256);assert.equal(shaFile(zip),sourceManifest.zipSha256);for(const driver of sourceManifest.driverInputs)assert.equal(shaFile(driver.path),driver.sha256);fresh(join(evidence,'legacy-source-after.json'),{oldCommit,files:assertArchive(entries),unchanged:true})}catch(cause){preservation=cause;fresh(join(evidence,'preservation-failure.json'),errorFacts(cause))}
  fresh(join(evidence,'summary.json'),{status:primary===null&&preservation===null&&results.length===cases.length?'passed':'failed',oldCommit,oldTree,currentHead,startedAt,completedAt:new Date().toISOString(),sourceFiles:before.length,results,limitations:'Source-isolated cold Store/restore and held actual target read plus queued host insert/source-apply only. Existing DDL27 cannot stop every arbitrary ordinary write executed by already loaded old Store code; production sync gate remains closed.',primary:primary===null?null:errorFacts(primary),preservation:preservation===null?null:errorFacts(preservation)})
  if(primary!==null)throw primary;if(preservation!==null)throw preservation;assert.equal(results.length,2)
  process.stdout.write(JSON.stringify({status:'passed',evidence,oldCommit,cases:2,sourceFiles:before.length})+'\n')
}
main().catch(error=>{try{if(!ownsEvidence){mkdirSync(dirname(evidence),{recursive:true});mkdirSync(evidence);ownsEvidence=true}if(!existsSync(join(evidence,'failure.json')))fresh(join(evidence,'failure.json'),errorFacts(error))}catch{}process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');process.exitCode=1})
