import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { RESTORE_FILES, parseRestoreJson, restoreFail, restoreJson, restoreUuid, type RestoreRawFile } from './restore-safety-model'

export const RESTORE_FENCE = 'database-restore-fence.json'
export const RESTORE_PENDING = 'database-restore-pending.json'
export const RESTORE_SAFE_MODE = 'database-restore-safe-mode.json'
export function restorePaths(root: string, operationId: string) {
  restoreUuid(operationId)
  const storage=join(root,'storage'), recovery=join(root,'backups','database-restore',operationId)
  return {root,storage,recovery,original:join(recovery,'original'),safety:join(recovery,'safety'),inspection:join(recovery,'inspection'),
    stage:join(recovery,'candidate.db'),database:join(storage,'knowbook.db'),intent:join(recovery,'intent.json'),parent:join(recovery,'parent-fence.json'),
    fence:join(root,RESTORE_FENCE),journal:join(root,RESTORE_PENDING),safeMarker:join(root,RESTORE_SAFE_MODE),result:join(recovery,'result.json')}
}
export async function restoreExists(path: string): Promise<boolean> { return (await lstat(path).catch((error:unknown)=>{
  if (error && typeof error==='object' && 'code' in error && error.code==='ENOENT') return null
  throw error
}))!==null }
export async function assertRestorePath(path: string, root?: string): Promise<void> {
  const absolute=resolve(path)
  if(root){const child=relative(resolve(root),absolute);if(child==='..'||child.startsWith('..'+sep)||isAbsolute(child))return restoreFail('路径越过真实profile。')}
  let current=parse(absolute).root
  for(const part of relative(current,absolute).split(sep).filter(Boolean)){
    current=join(current,part)
    const info=await lstat(current).catch((error:unknown)=>{
      if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return null
      throw error
    })
    if(info?.isSymbolicLink())return restoreFail('维护目录指向symlink/junction，已拒绝操作。')
    if(info&&current!==absolute&&!info.isDirectory())return restoreFail('维护路径中间项不是目录。')
  }
}
export async function restoreDirectory(path:string,root:string,exclusive=false):Promise<void>{
  await assertRestorePath(path,root)
  await mkdir(path,{recursive:!exclusive})
  await assertRestorePath(path,root)
  if(!(await lstat(path)).isDirectory())return restoreFail('维护目录身份错误。')
}
function sameFd(a:Stats,b:Stats):boolean{return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs}
function samePath(a:Stats,b:Stats):boolean{return (a.dev===b.dev||process.platform==='win32'&&a.dev===0)&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs}
/** Fixed-size fd reading: growth cannot turn a finite original into an unbounded stream. */
export async function restoreFileDigest(path:string):Promise<{sha256:string;bytes:number}>{
  await assertRestorePath(path)
  const prior=await lstat(path)
  if(!prior.isFile()||prior.isSymbolicLink())return restoreFail('维护原件不是独立普通文件。')
  const fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{
    const before=await fd.stat()
    if(!before.isFile()||!samePath(prior,before)||!Number.isSafeInteger(before.size)||before.size<0)return restoreFail('文件打开身份变化。')
    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024)
    let offset=0
    while(offset<before.size){const count=Math.min(buffer.length,before.size-offset),read=await fd.read(buffer,0,count,offset)
      if(!read.bytesRead)return restoreFail('维护原件读取被截断。')
      hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead}
    const probe=await fd.read(buffer,0,1,offset),after=await fd.stat(),now=await lstat(path)
    if(probe.bytesRead||!sameFd(before,after)||!now.isFile()||now.isSymbolicLink()||!samePath(now,after))return restoreFail('读取期间维护原件变化。')
    return {sha256:hash.digest('hex'),bytes:offset}
  }finally{await fd.close()}
}
export async function restoreInventory(directory:string):Promise<RestoreRawFile[]>{
  const output:RestoreRawFile[]=[]
  for(const name of RESTORE_FILES){const path=join(directory,name)
    if(!await restoreExists(path)){output.push({name,present:false,bytes:0,sha256:null});continue}
    const digest=await restoreFileDigest(path);output.push({name,present:true,...digest})}
  return output
}
export async function assertRestoreInventory(directory:string,expected:RestoreRawFile[]):Promise<void>{
  if(restoreJson(await restoreInventory(directory))!==restoreJson(expected))return restoreFail('真实DB/WAL/SHM与封存原清单不符。')
}
export async function copyRestoreInventory(source:string,destination:string,expected:RestoreRawFile[],root:string):Promise<void>{
  await restoreDirectory(destination,root,true)
  for(const file of expected)if(file.present){const from=join(source,file.name),to=join(destination,file.name)
    await assertRestorePath(from,root);await assertRestorePath(to,root);await copyFile(from,to,constants.COPYFILE_EXCL);await syncRestoreFile(to)}
  await assertRestoreInventory(destination,expected);await assertRestoreInventory(source,expected);await syncRestoreDirectory(destination)
}
export async function syncRestoreFile(path:string):Promise<void>{
  await assertRestorePath(path);const fd=await open(path,constants.O_RDWR|(constants.O_NOFOLLOW??0))
  try{if(!(await fd.stat()).isFile())return restoreFail('file fsync不是普通文件。');await fd.sync()}finally{await fd.close()}
}
function directoryUnsupported(error:unknown):boolean{return process.platform==='win32'&&error!==null&&typeof error==='object'&&'code'in error&&(error.code==='EPERM'||error.code==='EISDIR')}
export async function syncRestoreDirectory(path:string):Promise<void>{
  await assertRestorePath(path);if(!(await lstat(path)).isDirectory())return restoreFail('directory flush目标不是目录。')
  let fd:Awaited<ReturnType<typeof open>>
  try{fd=await open(path,'r')}catch(error){if(directoryUnsupported(error))return;throw error}
  try{if(!(await fd.stat()).isDirectory())return restoreFail('directory flush handle不是目录。')
    try{await fd.sync()}catch(error){if(!directoryUnsupported(error))throw error}
  }finally{await fd.close()}
}
export async function writeRestoreJson(path:string,value:unknown,root:string,exclusive=false):Promise<void>{
  await assertRestorePath(path,root)
  if(exclusive){const fd=await open(path,'wx');try{await fd.writeFile(restoreJson(value));await fd.sync()}finally{await fd.close()}
    await syncRestoreDirectory(dirname(path));return}
  const temp=path+'.'+randomUUID()+'.tmp',fd=await open(temp,'wx')
  try{await fd.writeFile(restoreJson(value));await fd.sync()}finally{await fd.close()}
  try{await assertRestorePath(path,root);await rename(temp,path);await syncRestoreDirectory(dirname(path))}
  catch(error){await rm(temp,{force:true}).catch(()=>undefined);throw error}
}
export async function readRestoreText(path:string):Promise<string>{
  await assertRestorePath(path)
  const info=await lstat(path)
  if(!info.isFile()||info.size>1024*1024)return restoreFail('维护JSON原件过大或不是文件。')
  const fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{const before=await fd.stat();if(!samePath(info,before)||before.size>1024*1024)return restoreFail('维护JSON打开身份变化。')
    const buffer=Buffer.alloc(before.size+1);let offset=0
    while(offset<buffer.length){const got=await fd.read(buffer,offset,buffer.length-offset,offset);if(!got.bytesRead)break;offset+=got.bytesRead}
    const after=await fd.stat(),now=await lstat(path)
    if(offset!==before.size||!sameFd(before,after)||!samePath(now,after)||now.isSymbolicLink())return restoreFail('维护JSON读取变化。')
    return buffer.subarray(0,offset).toString('utf8')
  }finally{await fd.close()}
}
export async function readRestoreJson(path:string):Promise<unknown>{return parseRestoreJson(await readRestoreText(path))}
export async function canonicalRestoreRoot(value:string):Promise<string>{
  await assertRestorePath(value)
  const root=await realpath(resolve(value));await assertRestorePath(root)
  if(!(await lstat(root)).isDirectory())return restoreFail('profile根不是目录。')
  return root
}
async function nonempty(path:string,depth=0):Promise<boolean>{
  await assertRestorePath(path);const info=await lstat(path)
  if(!info.isDirectory())return true
  if(depth>64)return restoreFail('同步私有目录层级不可证明安全。')
  for(const name of await readdir(path))if(await nonempty(join(path,name),depth+1))return true
  return false
}
export async function assertNoRestorePrivateSyncFiles(root:string):Promise<void>{
  const storage=join(root,'storage');if(!await restoreExists(storage))return
  await assertRestorePath(storage,root)
  for(const name of await readdir(storage))if(name.startsWith('synced-')&&await nonempty(join(storage,name)))return restoreFail('原profile仍有同步私有来源／pending文件。')
}

/** Legacy v1 uses its own parser/algorithm; this only chooses the version before dispatch. */
export async function readRestoreJournalVersion(path:string):Promise<unknown>{return (JSON.parse(await readRestoreText(path)) as {version?:unknown})?.version}
