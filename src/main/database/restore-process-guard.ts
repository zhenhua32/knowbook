import { execFile } from 'node:child_process'
import { readFile, readdir, readlink, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveSystemPluginPhysicalPath } from '../system-plugin/managed-paths'
import { WINDOWS_RESTORE_PROCESS_JSON_SOURCE } from './restore-process-json'

export interface RestoreProcessIdentity {
  pid: number
  executable: string
  startToken: string
  serviceEntry: string
}
export interface RestoreObservedProcess {
  pid: number
  name?: string
  executable: string | null
  startToken: string
  argv: string[] | null
}

/** A bounded diagnostic codec, never raw execFile stderr or process data. */
export function parseRestoreProcessQueryTrace(stderr: unknown): {
  phases: string[]; timings: Array<{ phase: string; elapsedMs: number }>
} {
  const phases: string[] = [], timings: Array<{ phase: string; elapsedMs: number }> = []
  if (typeof stderr !== 'string') return { phases, timings }
  for (const line of stderr.split(/\r?\n/)) {
    if (/^knowbook-restore-process:(started|assembly-ready|module-ready|type-ready|signatures-ready|argv-ready|reading-processes|processes-started|processes-read|encoder-defined|fixture-ready|encoding-result|encoded-result|complete)$/.test(line)) phases.push(line)
    const match = /^knowbook-restore-timing:(started|assembly-ready|module-ready|type-ready|signatures-ready|argv-ready|reading-processes|processes-started|processes-read|encoder-defined|fixture-ready|encoding-result|encoded-result|complete):([0-9]{1,6})$/.exec(line)
    if (match && Number(match[2]) <= 120_000) timings.push({ phase: match[1], elapsedMs: Number(match[2]) })
  }
  return { phases: phases.slice(-5), timings: timings.slice(-5) }
}

/** Enumerates argv as data; never executes any discovered command. */
export async function listWindowsRestoreProcesses(): Promise<RestoreObservedProcess[]> {
  if (process.platform !== 'win32') throw new Error('数据库维护恢复目前仅支持 Windows。')
  // Run-only P/Invoke bindings keep the native argv/free signatures without
  // starting a C# compiler for each fresh snapshot.
  // Encode the fixed scalar/argv dictionaries with already loaded primitives,
  // avoiding serializer assembly loading and PSObject reflection traversal.
  const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$queryClock=[Diagnostics.Stopwatch]::StartNew()
function Write-KnowBookRestorePhase([string]$phase) {
 [Console]::Error.WriteLine('knowbook-restore-process:'+$phase)
 [Console]::Error.WriteLine('knowbook-restore-timing:'+$phase+':'+$queryClock.ElapsedMilliseconds)
}
Write-KnowBookRestorePhase 'started'
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('KnowBookRestoreInterop'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
Write-KnowBookRestorePhase 'assembly-ready'
$module=$assembly.DefineDynamicModule('Native')
Write-KnowBookRestorePhase 'module-ready'
$type=$module.DefineType('KnowBookRestoreArgv',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
Write-KnowBookRestorePhase 'type-ready'
$attributes=[Reflection.MethodAttributes]'Public,Static,PinvokeImpl'
$method=$type.DefinePInvokeMethod('CommandLineToArgvW','shell32.dll','CommandLineToArgvW',$attributes,[Reflection.CallingConventions]::Standard,[IntPtr],[Type[]]@([string],([int]).MakeByRefType()),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
$method=$type.DefinePInvokeMethod('LocalFree','kernel32.dll','LocalFree',$attributes,[Reflection.CallingConventions]::Standard,[IntPtr],[Type[]]@([IntPtr]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
Write-KnowBookRestorePhase 'signatures-ready'
$native=$type.CreateType()
Write-KnowBookRestorePhase 'argv-ready'
$result=[System.Collections.Generic.List[object]]::new()
Write-KnowBookRestorePhase 'reading-processes'
$sawProcess=$false
foreach($item in Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,CreationDate,CommandLine) {
 if(-not $sawProcess) { Write-KnowBookRestorePhase 'processes-started'; $sawProcess=$true }
 if ($item.Name -notmatch '(?i)knowbook|electron|node' -and $item.CommandLine -notlike '*knowbookService*') { continue }
 $parts=$null
 if ($item.CommandLine) {
  $count=0; $memory=$native::CommandLineToArgvW($item.CommandLine,[ref]$count)
  if($memory -eq [IntPtr]::Zero) { throw 'Cannot inspect process arguments.' }
  try { $parts=@(for($i=0;$i -lt $count;$i++) { [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory,$i*[IntPtr]::Size)) }) }
  finally { [void]$native::LocalFree($memory) }
 }
 $row=[System.Collections.Generic.Dictionary[string,object]]::new()
 $row['pid']=[int]$item.ProcessId
 $row['name']=$item.Name
 $row['executable']=$item.ExecutablePath
 $row['startToken']='windows:'+$item.CreationDate.ToUniversalTime().Ticks.ToString()
 $row['argv']=$parts
 $result.Add($row)
}
Write-KnowBookRestorePhase 'processes-read'
Write-KnowBookRestorePhase 'encoding-result'
${WINDOWS_RESTORE_PROCESS_JSON_SOURCE}
Write-KnowBookRestorePhase 'encoder-defined'
$json=ConvertTo-KnowBookProcessJson -Rows ($result.ToArray())
Write-KnowBookRestorePhase 'encoded-result'
[Console]::WriteLine($json)
Write-KnowBookRestorePhase 'complete'`
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], { windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }))
  } catch (error) {
    throw new Error('无法读取 Windows 后台进程列表，数据库未替换。请确认当前用户有权查询本机进程后重试。', { cause: error })
  }
  const result: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''))
  if (!Array.isArray(result) || result.some((row) => !row || !Number.isSafeInteger(row.pid)
    || typeof row.startToken !== 'string' || (row.executable !== null && typeof row.executable !== 'string')
    || (row.argv !== null && (!Array.isArray(row.argv) || !row.argv.every((arg: unknown) => typeof arg === 'string'))))) {
    throw new Error('无法验证 Windows 后台进程列表，已拒绝恢复。')
  }
  return result
}

function isGone(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ESRCH')
}

function isAccessDenied(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error.code === 'EACCES' || error.code === 'EPERM')
}

async function readLinuxRestoreProcess(pid: number, known: boolean): Promise<RestoreObservedProcess | null> {
  const directory = `/proc/${pid}`, statFile = `${directory}/stat`
  const readStat = async () => {
    const raw = await readFile(statFile, 'utf8')
    const end = raw.lastIndexOf(')')
    const fields = raw.slice(end + 2).trim().split(/\s+/)
    if (!raw.startsWith(`${pid} (`) || end < 0 || !/^\d+$/.test(fields[17] ?? '') || !/^\d+$/.test(fields[19] ?? '')) {
      throw new Error(`无法验证 Linux 后台进程 PID ${pid} 的启动身份。`)
    }
    const stopped = (fields[0] === 'Z' || fields[0] === 'X') && fields[17] === '1'
    return { name: raw.slice(String(pid).length + 2, end), stopped, startToken: `linux:${fields[19]}` }
  }
  try {
    const before = await readStat()
    // The leader can exit before other threads that still hold database files.
    if (before.stopped) return null
    const readOptional = async <T>(read: Promise<T>) => read.catch(error => {
      if (isGone(error) || isAccessDenied(error)) return null
      throw error
    })
    const [executable, command] = await Promise.all([
      readOptional(readlink(`${directory}/exe`)),
      readOptional(readFile(`${directory}/cmdline`))
    ])
    const after = await readStat()
    if (before.startToken !== after.startToken || after.stopped) return null
    let argv: string[] | null = null
    if (command?.length && command.at(-1) === 0) {
      try { argv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(command).slice(0, -1).split('\0') }
      catch { /* An undecodable command line cannot prove ownership. */ }
    }
    if (!argv && !known) {
      // Unrelated kernel threads and processes owned by other users cannot
      // be identified as this user's managed detached services.
      if (executable === null && command?.length === 0) return null
      if ((await stat(directory)).uid !== process.getuid?.()) return null
    }
    const physicalExecutable = executable && isAbsolute(executable)
      ? await resolveSystemPluginPhysicalPath(executable) : null
    return { pid, name: after.name, startToken: after.startToken, executable: physicalExecutable, argv }
  } catch (error) {
    if (isGone(error)) {
      // A known PID may be hidden by a restricted procfs mount. A live
      // process must still block when its original identity cannot be read.
      if (!known) return null
      try { process.kill(pid, 0) }
      catch (probeError) { if (isGone(probeError)) return null }
    }
    if (isAccessDenied(error) && !known) {
      const owner = await stat(directory).catch(statError => { if (isGone(statError)) return null; throw statError })
      if (owner === null || owner.uid !== process.getuid?.()) return null
    }
    throw error
  }
}

export async function listLinuxRestoreProcesses(identities: readonly RestoreProcessIdentity[]): Promise<RestoreObservedProcess[]> {
  if (process.platform !== 'linux') throw new Error('Linux 恢复进程检查需要本机 procfs。')
  const known = new Set(identities.map(identity => identity.pid))
  if ([...known].some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff)) {
    throw new Error('已记录的 Linux 后台进程 PID 无效。')
  }
  if (await readlink('/proc/self') !== String(process.pid)) throw new Error('无法验证当前 Linux 恢复进程的 procfs。')
  // Include recorded PIDs even if procfs does not list them.
  const pids = new Set([...known, ...(await readdir('/proc')).filter(name => /^[1-9]\d*$/.test(name)).map(Number)])
  if (!pids.has(process.pid)) throw new Error('无法验证当前 Linux 恢复进程的 procfs。')
  const processes: RestoreObservedProcess[] = []
  for (const pid of pids) {
    if (pid === process.pid) continue
    const row = await readLinuxRestoreProcess(pid, known.has(pid))
    if (row) processes.push(row)
  }
  return processes
}

function matches(expected: RestoreProcessIdentity, actual: RestoreObservedProcess): boolean {
  const normalize = (path: string) => actual.startToken.startsWith('windows:') ? resolve(path).toLowerCase() : resolve(path)
  return expected.pid === actual.pid && expected.startToken === actual.startToken
    && actual.executable !== null && normalize(expected.executable) === normalize(actual.executable)
    && Boolean(actual.argv?.some((arg) => isAbsolute(arg) && normalize(arg) === normalize(expected.serviceEntry)))
}

/** Stops only persisted identities. A live unidentifiable profile service blocks replacement. */
export async function stopDatabaseRestoreProcesses(input: {
  userDataRoot: string
  identities: RestoreProcessIdentity[]
  list?: () => Promise<RestoreObservedProcess[]>
  terminate?: (pid: number) => void
}): Promise<number[]> {
  const list = input.list ?? (process.platform === 'linux'
    ? () => listLinuxRestoreProcesses(input.identities)
    : listWindowsRestoreProcesses)
  const terminating = new Map<number, string>()
  const root = await resolveSystemPluginPhysicalPath(resolve(input.userDataRoot, 'system-plugins'))
  const isProfileEntry = async (arg: string) => {
    if (!isAbsolute(arg)) return false
    const physical = await resolveSystemPluginPhysicalPath(arg)
    const location = relative(root, physical)
    return Boolean(location && location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location))
  }
  const inspect = async () => {
    const all = await list()
    const owned: RestoreObservedProcess[] = []
    for (const snapshot of all) {
      let observed = snapshot
      if (observed.pid === process.pid) continue
      // After an authorized termination, any remaining row for that original
      // creation is still present, even if its argv became unreadable or
      // changed. Only a fresh absence can release this wait; this map never
      // authorizes another termination or replacement.
      const token = terminating.get(observed.pid)
      if (token !== undefined && observed.startToken === token) { owned.push(observed); continue }
      const recorded = input.identities.filter(identity => identity.pid === observed.pid)
      if (!observed.argv && (recorded.length || /knowbook|electron/i.test(basename(observed.executable ?? observed.name ?? '')))) {
        // The OS can return a final process row with null command line while
        // that process is exiting. Only a fresh absence proves it is gone;
        // a still-live unreadable host must continue to block replacement.
        const refreshed = (await list()).find((item) => item.pid === observed.pid)
        if (!refreshed) continue
        observed = refreshed
        if (!observed.argv) {
          throw new Error(`无法读取后台进程 PID ${observed.pid} 的命令，不能确保数据库已停止使用。请退出相关进程或重启系统后重试。`)
        }
      }
      // Metadata PID reuse alone is not ownership; never terminate the replacement process.
      const expected = recorded.find(identity => identity.startToken === observed.startToken)
      const sameIdentity = expected && matches(expected, observed)
      let profileEntry = false
      for (const arg of observed.argv ?? []) if (await isProfileEntry(arg)) { profileEntry = true; break }
      if (expected && observed.startToken.startsWith('linux:') && !sameIdentity) {
        throw new Error(`工作区后台进程 PID ${observed.pid} 仍在运行，但可执行文件或入口已经变化；已拒绝替换数据库。`)
      }
      if (!sameIdentity && !profileEntry) continue
      if (!expected || !sameIdentity || !await isProfileEntry(expected.serviceEntry)) {
        throw new Error(`发现工作区后台进程 PID ${observed.pid}，但持久化身份无法核验；已拒绝替换数据库。请退出该进程或重启系统后重试。`)
      }
      owned.push(observed)
    }
    return owned
  }
  const initial = await inspect()
  // On Linux a numeric PID can be reused between inspection and sending a
  // signal. A live, matched service blocks replacement until it exits.
  const runningLinuxService = initial.find(observed => observed.startToken.startsWith('linux:'))
  if (runningLinuxService) {
    throw new Error(`工作区后台进程 PID ${runningLinuxService.pid} 仍在运行；请退出该进程后重试，数据库未替换。`)
  }
  const stopped: number[] = []
  for (const observed of initial) {
    if (terminating.has(observed.pid)) continue
    const current = (await inspect()).find((item) => item.pid === observed.pid)
    if (!current || current.startToken !== observed.startToken) continue
    ;(input.terminate ?? ((pid) => process.kill(pid, 'SIGTERM')))(current.pid)
    terminating.set(current.pid, current.startToken)
    stopped.push(current.pid)
  }
  const deadline = Date.now() + 10_000
  while ((await inspect()).length) {
    if (Date.now() >= deadline) throw new Error('已核验的后台进程尚未退出，数据库未替换。请退出进程后重试。')
    await delay(100)
  }
  return stopped
}
