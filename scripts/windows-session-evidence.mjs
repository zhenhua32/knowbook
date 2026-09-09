import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

// Observation only. This script never logs out/reboots, starts KnowBook, replays
// a Run command, registers a task, or changes Windows account/VM settings.
if (process.platform !== 'win32') throw new Error('Windows session evidence requires Windows.')
const [operation, checkpointPath, mode] = process.argv.slice(2)
if (!['capture', 'verify'].includes(operation) || !checkpointPath || (operation === 'verify' && !['login', 'reboot'].includes(mode))) {
  throw new Error('Usage: node scripts/windows-session-evidence.mjs capture <checkpoint.json> | verify <checkpoint.json> <login|reboot>')
}
const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
if (checkpoint.kind !== 'knowbook-windows-session-acceptance' || !/^[a-z0-9][a-z0-9.-]{0,100}$/i.test(checkpoint.pluginId)
  || !isAbsolute(checkpoint.executable ?? '') || !isAbsolute(checkpoint.profile ?? '')) {
  throw new Error('Checkpoint must identify an absolute executable/profile and a controlled plugin id.')
}
const executable = resolve(checkpoint.executable)
const profile = resolve(checkpoint.profile)
const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$os = Get-CimInstance Win32_OperatingSystem
$machine = Get-CimInstance Win32_ComputerSystemProduct
$identity = & whoami.exe /logonid
if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain current Windows logon identity.' }
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object {
 @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; executable = $_.ExecutablePath; commandLine = $_.CommandLine; startedAt = $_.CreationDate.ToUniversalTime().ToString('o') }
})
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try { $command = if ($key) { $key.GetValue('knowbook.${checkpoint.pluginId}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null } }
finally { if ($key) { $key.Dispose() } }
@{ machine = $machine.UUID; boot = $os.LastBootUpTime.ToUniversalTime().ToString('o'); logon = ($identity -join '\n'); processes = $processes; command = $command } | ConvertTo-Json -Depth 5 -Compress`
const { stdout } = await promisify(execFile)('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
const observed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
const digest = (value) => createHash('sha256').update(value).digest('hex')
const service = JSON.parse(await readFile(join(profile, 'system-plugins', 'data', checkpoint.pluginId, 'service-state.json'), 'utf8'))
const expected = [executable, `--knowbook-user-data-dir=${profile}`, `--knowbook-system-plugin-os-startup=${checkpoint.pluginId}`].map(quote).join(' ')
if (observed.command !== expected) throw new Error('The exact controlled startup command is not registered.')
const processes = observed.processes.filter((item) => resolve(item.executable).toLowerCase() === executable.toLowerCase())
const current = {
  capturedAt: new Date().toISOString(), machineHash: digest(observed.machine), boot: observed.boot,
  logonHash: digest(observed.logon), startupCommand: observed.command,
  processes, service
}
if (operation === 'capture') {
  if (checkpoint.before) throw new Error('Refusing to replace an existing pre-transition observation; use a new checkpoint.')
  if (!processes.some((item) => item.pid === service.pid)) throw new Error('The controlled service is not running in the expected executable.')
  await writeFile(checkpointPath, JSON.stringify({ ...checkpoint, before: current }, null, 2))
  console.log('Recorded pre-transition state. Perform the requested session transition only inside the disposable Windows VM, then verify there.')
} else {
  const before = checkpoint.before
  if (!before || before.machineHash !== current.machineHash) throw new Error('Capture a pre-transition checkpoint on this same VM first.')
  if (mode === 'reboot' && before.boot === current.boot) throw new Error('Windows boot time did not change; command replay is not a reboot.')
  if (mode === 'login' && (before.logonHash === current.logonHash || before.boot !== current.boot)) {
    throw new Error('A new logon on the same OS boot is required for the login case.')
  }
  const startup = processes.filter((item) => item.commandLine?.includes(`--knowbook-system-plugin-os-startup=${checkpoint.pluginId}`)
    && item.commandLine.includes(`--knowbook-user-data-dir=${profile}`))
  if (!startup.length || !startup.some((item) => Date.parse(item.startedAt) > Date.parse(before.capturedAt))) {
    throw new Error('No newly started host with the registered plugin/profile startup arguments was observed.')
  }
  if (!processes.some((item) => item.pid === service.pid) || service.paths?.userData !== profile
    || !Number.isFinite(service.lastRpcAt) || Date.now() - service.lastRpcAt > 10_000) {
    throw new Error('A live controlled service with fresh successful RPC to the correct profile is required.')
  }
  const evidencePath = `${checkpointPath}.${mode}-evidence.json`
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, JSON.stringify({
    scenario: `real-windows-${mode}-observation`, status: 'passed', before, after: current,
    scope: 'Observed OS/logon transition, newly started registered host command and live plugin RPC. This script does not cause transitions or launch/replay the host; the VM operator must not manually launch the host between capture and verify.'
  }, null, 2))
  console.log(`Verified Windows ${mode} transition and fresh controlled startup/RPC: ${evidencePath}`)
}

function quote(argument) {
  if (argument && !/[\s"]/.test(argument)) return argument
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}
