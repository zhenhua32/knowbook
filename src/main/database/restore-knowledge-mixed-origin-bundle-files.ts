import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagUuid } from './restore-knowledge-dag-model'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { canonicalOriginCatalogRoot as canonical, assertOriginCatalogDirectory as directory, originCatalogLocalPath as local,
  readOriginCatalogFile as readFile, copyOriginCatalogFile as copyFile, settleOriginCatalogBatch as batch,
  syncOriginCatalogAncestors as syncAncestors } from './restore-knowledge-origin-bundle-files'
import { originBundleInvalid as bad } from './restore-knowledge-origin-bundle-model'
import { mixedOriginBundleFiles, mixedOriginBundleDirectories, mixedOriginBundleHash, parseMixedOriginBundleDescriptor,
  MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES, type MixedOriginBundleDescriptor } from './restore-knowledge-mixed-origin-bundle-model'
import { readActualFirstMixedOriginSource, type ActualFirstRequiredSqlDag } from './restore-knowledge-mixed-required-dag-read'

export interface MixedOriginBundleOriginal { readonly directory:string; readonly descriptor:MixedOriginBundleDescriptor; readonly descriptorHash:string }
async function exactTree(root:string,descriptor:MixedOriginBundleDescriptor) {
  const files=mixedOriginBundleFiles(descriptor),dirs=mixedOriginBundleDirectories(descriptor)
  const plans=['',...dirs].map(key=>({key,path:key?local(root,key):root,depth:key?key.split('/').length:0,children:new Map<string,'file'|'directory'>()}))
  const byKey=new Map(plans.map(p=>[p.key,p])),snapshots=new Map<string,{stat:Awaited<ReturnType<typeof directory>>;names:string[]}>()
  const add=(key:string,kind:'file'|'directory')=>{const slash=key.lastIndexOf('/'),parent=slash<0?'':key.slice(0,slash),name=key.slice(slash+1),plan=byKey.get(parent)
    if(!plan||plan.children.has(name))return bad('mixed完整catalog重复路径或缺父目录');plan.children.set(name,kind)}
  for(const key of dirs)add(key,'directory');for(const file of files)add(file.path,'file');add('descriptor.json','file')
  const levels=[...new Set(plans.map(p=>p.depth))].sort((a,b)=>a-b)
  for(const level of levels)await batch(plans.filter(p=>p.depth===level),async p=>{
    const stat=await directory(p.path,root),names=(await readdir(p.path)).sort()
    if(capsuleJson(names)!==capsuleJson([...p.children.keys()].sort()))return bad('mixed catalog有额外/缺失项，scratch不属于原件')
    for(const name of names){const info=await lstat(join(p.path,name),{bigint:true}),kind=p.children.get(name)
      if(info.isSymbolicLink()||(kind==='directory'?!info.isDirectory():!info.isFile()))return bad('mixed catalog有链接或错类型项')}
    snapshots.set(p.key,{stat,names})
  })
  await batch(files,async file=>{await readFile(local(root,file.path),root,file)})
  await readCapsule2AssetManifest(join(root,'descriptor.json'),root,MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES)
  for(const level of [...levels].reverse())await batch(plans.filter(p=>p.depth===level),async p=>{
    const before=snapshots.get(p.key)!,after=await directory(p.path,root)
    if(before.stat.dev!==after.dev||before.stat.ino!==after.ino||before.stat.mtimeNs!==after.mtimeNs||before.stat.ctimeNs!==after.ctimeNs
      ||capsuleJson(before.names)!==capsuleJson((await readdir(p.path)).sort()))return bad('mixed完整catalog读取期间目录变化')
  })
}
export async function readMixedOriginBundleOriginal(input:string,expectedHash?:string):Promise<MixedOriginBundleOriginal> {
  const root=await canonical(input),path=join(root,'descriptor.json'),first=await readCapsule2AssetManifest(path,root,MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES)
  const descriptor=parseMixedOriginBundleDescriptor(first),descriptorHash=mixedOriginBundleHash(descriptor)
  if(expectedHash!==undefined&&descriptorHash!==expectedHash)return bad('mixed原descriptor准确hash变化')
  await exactTree(root,descriptor)
  if(first!==await readCapsule2AssetManifest(path,root,MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES))return bad('mixed descriptor读取期间变化')
  return freezeCapsuleValue({directory:root,descriptor,descriptorHash})
}
async function makeTree(root:string,descriptor:MixedOriginBundleDescriptor){for(const path of mixedOriginBundleDirectories(descriptor))await restoreDirectory(local(root,path),root)}
async function finish(root:string,descriptor:MixedOriginBundleDescriptor){
  await writeCapsule2AssetCopy(join(root,'descriptor.json'),Buffer.from(capsuleJson(descriptor)+'\n'),root)
  for(const path of [...mixedOriginBundleDirectories(descriptor)].reverse())await syncRestoreDirectory(local(root,path))
  await syncRestoreDirectory(root)
}
export async function writeMixedOriginBundle(source:ActualFirstRequiredSqlDag,operationId:string,bundleId:string) {
  const first=await readActualFirstMixedOriginSource(source),root=await canonical(first.profileRoot)
  const operation=join(root,'backups','database-restore',durableSqlDagUuid(operationId)),collection=join(operation,'mixed-origin-bundle-exports'),target=join(collection,durableSqlDagUuid(bundleId))
  await restoreDirectory(operation,root);await restoreDirectory(collection,root);await restoreDirectory(target,root,true);await makeTree(target,first.descriptor)
  await batch(first.files,file=>copyFile(file.sourcePath,root,local(target,file.path),target,file))
  const last=await readActualFirstMixedOriginSource(source)
  if(first.descriptorHash!==last.descriptorHash||capsuleJson(first.files)!==capsuleJson(last.files))return bad('mixed真实原件全集复制期间变化')
  await finish(target,first.descriptor);await syncAncestors(collection,root)
  return readMixedOriginBundleOriginal(target,first.descriptorHash)
}
export async function importMixedOriginBundleOriginal(profile:string,operationId:string,sourceDirectory:string) {
  const source=await readMixedOriginBundleOriginal(sourceDirectory),profileRoot=await canonical(profile),op=durableSqlDagUuid(operationId),mountId=randomUUID()
  const operation=join(profileRoot,'backups','database-restore',op),collection=join(operation,'mixed-origin-bundle-mounts'),mount=join(collection,mountId),target=join(mount,'original')
  await restoreDirectory(operation,profileRoot);await restoreDirectory(collection,profileRoot);await restoreDirectory(mount,profileRoot,true);await restoreDirectory(target,profileRoot,true)
  await makeTree(target,source.descriptor)
  await batch(mixedOriginBundleFiles(source.descriptor),file=>copyFile(local(source.directory,file.path),source.directory,local(target,file.path),target,file))
  await readMixedOriginBundleOriginal(source.directory,source.descriptorHash);await finish(target,source.descriptor);await syncAncestors(mount,profileRoot)
  return {profileRoot,operationId:op,mountId,original:await readMixedOriginBundleOriginal(target,source.descriptorHash)}
}
export async function readMountedMixedOriginBundle(profile:string,operationId:string,mountId:string,expectedHash:string) {
  const profileRoot=await canonical(profile),op=durableSqlDagUuid(operationId),mount=durableSqlDagUuid(mountId)
  const location=join(profileRoot,'backups','database-restore',op,'mixed-origin-bundle-mounts',mount)
  await directory(location,profileRoot);const names=await readdir(location)
  if(!names.includes('original')||names.some(n=>!['original','verification-profiles'].includes(n)))return bad('mixed mount顶层闭集变化')
  return {profileRoot,operationId:op,mountId:mount,original:await readMixedOriginBundleOriginal(join(location,'original'),expectedHash)}
}
export async function createMixedOriginVerificationProfile(input:Awaited<ReturnType<typeof readMountedMixedOriginBundle>>) {
  const actual=await readMountedMixedOriginBundle(input.profileRoot,input.operationId,input.mountId,input.original.descriptorHash)
  const collection=join(dirname(actual.original.directory),'verification-profiles'),profile=join(collection,randomUUID()),descriptor=actual.original.descriptor
  await restoreDirectory(collection,input.profileRoot);await restoreDirectory(profile,input.profileRoot,true)
  for(const path of mixedOriginBundleDirectories(descriptor))if(path!=='catalog')await restoreDirectory(local(profile,path.slice('catalog/'.length)),profile)
  await batch(mixedOriginBundleFiles(descriptor),file=>copyFile(local(actual.original.directory,file.path),actual.original.directory,local(profile,file.path.slice('catalog/'.length)),profile,file))
  await readMixedOriginBundleOriginal(actual.original.directory,actual.original.descriptorHash)
  for(const path of [...mixedOriginBundleDirectories(descriptor)].reverse())if(path!=='catalog')await syncRestoreDirectory(local(profile,path.slice('catalog/'.length)))
  await syncRestoreDirectory(profile);await syncAncestors(collection,input.profileRoot);return canonical(profile)
}
