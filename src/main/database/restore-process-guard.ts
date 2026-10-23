import { execFile } from 'node:child_process'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveSystemPluginPhysicalPath } from '../system-plugin/managed-paths'

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
    if (/^knowbook-restore-process:(started|argv-ready|reading-processes|encoding-result|complete)$/.test(line)) phases.push(line)
    const match = /^knowbook-restore-timing:(started|argv-ready|reading-processes|encoding-result|complete):([0-9]{1,6})$/.exec(line)
    if (match && Number(match[2]) <= 120_000) timings.push({ phase: match[1], elapsedMs: Number(match[2]) })
  }
  return { phases: phases.slice(-5), timings: timings.slice(-5) }
}

/** Enumerates argv as data; never executes any discovered command. */
export async function listWindowsRestoreProcesses(): Promise<RestoreObservedProcess[]> {
  if (process.platform !== 'win32') throw new Error('数据库维护恢复目前仅支持 Windows。')
  // Run-only P/Invoke bindings keep the native argv/free signatures without
  // starting a C# compiler for each fresh snapshot.
  const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$queryClock=[Diagnostics.Stopwatch]::StartNew()
function Write-KnowBookRestorePhase([string]$phase) {
 [Console]::Error.WriteLine('knowbook-restore-process:'+$phase)
 [Console]::Error.WriteLine('knowbook-restore-timing:'+$phase+':'+$queryClock.ElapsedMilliseconds)
}
Write-KnowBookRestorePhase 'started'
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('KnowBookRestoreInterop'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('Native')
$type=$module.DefineType('KnowBookRestoreArgv',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$attributes=[Reflection.MethodAttributes]'Public,Static,PinvokeImpl'
$method=$type.DefinePInvokeMethod('CommandLineToArgvW','shell32.dll','CommandLineToArgvW',$attributes,[Reflection.CallingConventions]::Standard,[IntPtr],[Type[]]@([string],([int]).MakeByRefType()),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
$method=$type.DefinePInvokeMethod('LocalFree','kernel32.dll','LocalFree',$attributes,[Reflection.CallingConventions]::Standard,[IntPtr],[Type[]]@([IntPtr]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
$native=$type.CreateType()
Write-KnowBookRestorePhase 'argv-ready'
$result=[System.Collections.Generic.List[object]]::new()
Write-KnowBookRestorePhase 'reading-processes'
foreach($item in Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,CreationDate,CommandLine) {
 if ($item.Name -notmatch '(?i)knowbook|electron|node' -and $item.CommandLine -notlike '*knowbookService*') { continue }
 $parts=$null
 if ($item.CommandLine) {
  $count=0; $memory=$native::CommandLineToArgvW($item.CommandLine,[ref]$count)
  if($memory -eq [IntPtr]::Zero) { throw 'Cannot inspect process arguments.' }
  try { $parts=@(for($i=0;$i -lt $count;$i++) { [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory,$i*[IntPtr]::Size)) }) }
  finally { [void]$native::LocalFree($memory) }
 }
 $result.Add([pscustomobject]@{pid=[int]$item.ProcessId; name=$item.Name; executable=$item.ExecutablePath; startToken=('windows:'+$item.CreationDate.ToUniversalTime().Ticks.ToString()); argv=$parts})
}
Write-KnowBookRestorePhase 'encoding-result'
ConvertTo-Json -InputObject $result.ToArray() -Depth 4 -Compress
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

function matches(expected: RestoreProcessIdentity, actual: RestoreObservedProcess): boolean {
  return expected.pid === actual.pid && expected.startToken === actual.startToken
    && actual.executable !== null && resolve(expected.executable).toLowerCase() === resolve(actual.executable).toLowerCase()
    && Boolean(actual.argv?.some((arg) => isAbsolute(arg) && resolve(arg).toLowerCase() === resolve(expected.serviceEntry).toLowerCase()))
}

/** Stops only persisted identities. A live unidentifiable profile service blocks replacement. */
export async function stopDatabaseRestoreProcesses(input: {
  userDataRoot: string
  identities: RestoreProcessIdentity[]
  list?: () => Promise<RestoreObservedProcess[]>
  terminate?: (pid: number) => void
}): Promise<number[]> {
  const list = input.list ?? listWindowsRestoreProcesses
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
      const expected = input.identities.find((identity) => identity.pid === observed.pid)
      if (!observed.argv && (expected || /knowbook|electron/i.test(basename(observed.executable ?? observed.name ?? '')))) {
        // Windows can return a final process row with null command line while
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
      const sameIdentity = expected && matches(expected, observed)
      let profileEntry = false
      for (const arg of observed.argv ?? []) if (await isProfileEntry(arg)) { profileEntry = true; break }
      if (!sameIdentity && !profileEntry) continue
      if (!expected || !matches(expected, observed) || !await isProfileEntry(expected.serviceEntry)) {
        throw new Error(`发现工作区后台进程 PID ${observed.pid}，但持久化身份无法核验；已拒绝替换数据库。请退出该进程或重启系统后重试。`)
      }
      owned.push(observed)
    }
    return owned
  }
  const initial = await inspect()
  const stopped: number[] = []
  for (const observed of initial) {
    if (terminating.has(observed.pid)) continue
    const current = (await inspect()).find((item) => item.pid === observed.pid)
    if (!current) continue
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
