import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export interface WindowsLoginItemRegistryValues { user: string | null; machine: string | null }

/** Electron joins login-item args verbatim. Encode argv using Windows CRT rules. */
export function quoteWindowsLoginArgument(argument: string): string {
  if (argument && !/[\s"]/.test(argument)) return argument
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

export function formatWindowsLoginCommand(command: { executable: string; args: readonly string[] }): string {
  return [command.executable, ...command.args].map(quoteWindowsLoginArgument).join(' ')
}

/** Read only this service id. Electron launchItems.args omits Chromium switches. */
export async function readWindowsLoginItemRegistryValues(serviceId: string): Promise<WindowsLoginItemRegistryValues> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(serviceId)) throw new Error('Invalid Windows login service id.')
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Read-RunValue($hive) {
  $key = $hive.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
  $value = $null
  try {
    if ($key) {
      $value = $key.GetValue('${serviceId}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -ne $value -and $value -isnot [string]) { throw 'Login item is not a string value.' }
    }
    return @{ value = $value }
  } finally { if ($key) { $key.Dispose() } }
}
@{ user = (Read-RunValue ([Microsoft.Win32.Registry]::CurrentUser)).value; machine = (Read-RunValue ([Microsoft.Win32.Registry]::LocalMachine)).value } | ConvertTo-Json -Compress`
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024 })
  const values = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as WindowsLoginItemRegistryValues
  if (!values || !['user', 'machine'].every((key) => values[key as keyof typeof values] === null || typeof values[key as keyof typeof values] === 'string')) {
    throw new Error('Could not read exact Windows login item registry values.')
  }
  return values
}
