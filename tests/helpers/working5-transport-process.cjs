// Genuine independent cold readers; Electron runs as Node with hidden windows.
;(async()=>{
 const assert=require('node:assert/strict'),path=require('node:path'),url=require('node:url'),module=require('node:module')
 const input=JSON.parse(process.argv[2]),native=require('node:fs'),promises=require('node:fs/promises'),undo=[],accesses=[],created=[]
 const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value)
 assert.ok(Array.isArray(input.forbiddenOriginRoots)&&input.forbiddenOriginRoots.length>0)
 const forbidden=[...new Set(input.forbiddenOriginRoots.map(value=>{assert.equal(typeof value,'string');assert.ok(path.isAbsolute(value));return key(value)}))]
 const check=(value,method)=>{
  if(value instanceof URL&&value.protocol==='file:')value=url.fileURLToPath(value)
  if(Buffer.isBuffer(value))value=value.toString()
  if(typeof value!=='string')return
  if(forbidden.some(root=>key(value)===root||key(value).startsWith(root+path.sep))){accesses.push({method,path:value});throw Error('Retired source/spool must never be probed')}
 }
 try{
  for(const [object,names]of[[native,['openSync','lstatSync','statSync','readFileSync','realpathSync','existsSync','accessSync','readdirSync','opendirSync','copyFileSync','open','lstat','stat','readFile','realpath','access','readdir','opendir']],
   [promises,['open','lstat','stat','readFile','realpath','access','opendir','readdir','mkdir','copyFile']]])for(const name of names){
   const original=object[name],wrapped=function(...args){check(args[0],name);if(name.toLowerCase().includes('copyfile'))check(args[1],name+'-destination')
    const result=Reflect.apply(original,this,args)
    return name!=='mkdir'?result:result.then(value=>{if(typeof args[0]==='string')created.push(path.resolve(args[0]));return value})}
   Object.assign(wrapped,original)
   if(typeof original.native==='function')wrapped.native=function(...args){check(args[0],name+'.native');return Reflect.apply(original.native,this,args)}
   undo.push({object,name,original});object[name]=wrapped
  }
  module.syncBuiltinESMExports()
  const {captureReopenedPreparedMixedOriginBundle}=await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const {captureReopenedQualifiedOriginalBundle,readCompleteOriginalContentPair3}=await import('../../src/main/database/restore-knowledge-qualified-originals.ts')
  const {capsuleBytesHash}=await import('../../src/main/database/restore-knowledge-capsule-model.ts')
  const {capsule2SourceManifestHash}=await import('../../src/main/database/restore-knowledge-capsule2-source-seal-model.ts')
  const {parseWorkingOriginals5}=await import('../../src/main/database/restore-knowledge-capsule5-working-model.ts')
  assert.ok(input.mode==='mixed'||input.mode==='qualified')
  const captured=input.mode==='mixed'?await captureReopenedPreparedMixedOriginBundle(input.locator):await captureReopenedQualifiedOriginalBundle(input.locator)
  const actual=await readCompleteOriginalContentPair3(captured.bundle),source=actual.source,current=actual.current,archive=source.assetArchive
  assert.equal(archive.version,5);assert.equal(current.assetArchive.version,2)
  const sourceAssets=`catalog/backups/database-restore/${source.operationId}/knowledge-complete-assets-v2/${source.capsuleId}`
  const ownFile=name=>{const file=actual.originalPackage.files.find(file=>!file.frame.length&&file.path===sourceAssets+'/'+name);assert.ok(file);return file}
  const index=ownFile('contexts/manifest.json'),raw=await promises.readFile(index.sourcePath)
  assert.equal(raw.length,archive.workingOriginals.manifestFile.bytes);assert.equal(capsuleBytesHash(raw),archive.workingOriginals.manifestFile.sha256)
  const working=parseWorkingOriginals5(raw.toString('utf8'),archive.workingOriginals)
  assert.equal(working.sourceContentHash,archive.sourceContentHash);assert.ok(working.captures.length>0);assert.ok(working.files.length>0)
  for(const expected of working.files){const file=ownFile('contexts/files/'+expected.sha256),bytes=await promises.readFile(file.sourcePath)
   assert.equal(file.bytes,expected.bytes);assert.equal(file.sha256,expected.sha256);assert.equal(bytes.length,expected.bytes);assert.equal(capsuleBytesHash(bytes),expected.sha256)}
  const base=ownFile('base-provenance.json'),baseBytes=await promises.readFile(base.sourcePath)
  assert.equal(baseBytes.length,archive.baseProjection.baseManifestFile.bytes);assert.equal(capsuleBytesHash(baseBytes),archive.baseProjection.baseManifestFile.sha256)
  const currentAssets=`catalog/backups/database-restore/${current.operationId}/knowledge-complete-assets-v2/${current.capsuleId}`
  assert.ok(actual.originalPackage.directories.some(dir=>!dir.frame.length&&dir.path===currentAssets+'/files'))
  assert.equal(actual.originalPackage.directories.some(dir=>!dir.frame.length&&dir.path===currentAssets+'/contexts'),false)
  const suffix=path.join('backups','database-restore',current.operationId,'knowledge-complete-assets-v2',current.capsuleId,'files')
  // suffix is relative: compare native normalized separators/case without
  // path.resolve injecting the child cwd into the component suffix.
  const normalizedSuffix=process.platform==='win32'?suffix.toLowerCase():suffix
  const recreated=[...new Set(created.filter(value=>(process.platform==='win32'?value.toLowerCase():value).endsWith(path.sep+normalizedSuffix)))]
  assert.ok(recreated.length>0);for(const directory of recreated)assert.deepEqual(await promises.readdir(directory),[])
  const sourceSuffix=path.join('backups','database-restore',source.operationId,'knowledge-complete-assets-v2',source.capsuleId,'contexts')
  const sourceSuffixKey=process.platform==='win32'?sourceSuffix.toLowerCase():sourceSuffix
  const sourceDirectories=[...new Set(created.filter(value=>(process.platform==='win32'?value.toLowerCase():value).endsWith(path.sep+sourceSuffixKey)))]
  assert.ok(sourceDirectories.length>0)
  for(const directory of sourceDirectories){assert.deepEqual((await promises.readdir(directory)).sort(),['files','manifest.json']);assert.deepEqual((await promises.readdir(path.join(directory,'files'))).sort(),working.files.map(file=>file.sha256))}
  const sourceManifestPath=`catalog/backups/database-restore/${source.operationId}/knowledge-source-capsules-v2/${source.capsuleId}/manifest.json`
  const sourceManifest=actual.originalPackage.files.find(file=>!file.frame.length&&file.path===sourceManifestPath);assert.ok(sourceManifest)
  assert.equal(actual.originalPackage.original.managedOriginalBytes,captured.value.managedOriginalBytes)
  assert.deepEqual(accesses,[]);assert.equal(archive.coverage.installPermit,false)
  process.stdout.write(JSON.stringify({mode:input.mode,pid:process.pid,forbiddenOriginAccesses:accesses,forbiddenOriginRootCount:forbidden.length,
   sourceManifestHash:capsule2SourceManifestHash(JSON.parse(await promises.readFile(sourceManifest.sourcePath,'utf8'))),sourceMaterialHash:source.materialHash,sourceArchiveHash:source.assetArchiveHash,
   currentMaterialHash:current.materialHash,currentArchiveVersion:current.assetArchive.version,workingManifestHash:archive.workingOriginals.manifestHash,workingFileCount:working.files.length,
   supplementalObservationHash:archive.assetScopeSupplement.observationHash,baseManifestHash:archive.baseProjection.baseManifestHash,baseManifestRawHash:capsuleBytesHash(baseBytes),
   settledPortableBindingsHash:archive.assetScopeSupplement.settledPortableBindingsHash,managedOriginalBytes:captured.value.managedOriginalBytes,currentFilesDirectoryEmpty:true,
   acceptedCoverage:captured.value.acceptedCoverage,permit:captured.value.permit}))
 }finally{for(const item of undo.reverse())item.object[item.name]=item.original;module.syncBuiltinESMExports()}
})().catch(error=>{console.error(error);process.exitCode=1})
