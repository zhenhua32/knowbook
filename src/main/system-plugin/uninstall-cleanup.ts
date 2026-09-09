import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { KnowbookStore } from '../database/store'
import { recoverInterruptedDatabaseRestore } from '../database/restore-maintenance'
import { SystemPluginManager } from './manager'
import { createFullTrustOsPersistenceAdapter, type FullTrustElectronLoginItemApplication } from './os-persistence'
import { resolveKnowbookUserDataOverride } from './startup-command'

export const SYSTEM_PLUGIN_UNINSTALL_ARGUMENT = '--knowbook-uninstall-cleanup'

export function isSystemPluginUninstallCleanup(argv: readonly string[]): boolean {
  const options = argv.filter((argument) => argument.startsWith(SYSTEM_PLUGIN_UNINSTALL_ARGUMENT))
  if (options.length > 1 || options.some((argument) => argument !== SYSTEM_PLUGIN_UNINSTALL_ARGUMENT)) {
    throw new Error('Invalid KnowBook uninstall cleanup argument.')
  }
  return options.length === 1
}

/** Parse only host-issued startup commands for this exact executable. */
export function collectWindowsStartupProfiles(executable: string, commands: unknown): string[] {
  if (!Array.isArray(commands)) throw new Error('Windows startup command discovery returned invalid data.')
  const profiles = new Set<string>()
  for (const command of commands) {
    if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) {
      throw new Error('Windows startup command discovery returned invalid argv.')
    }
    if (!isAbsolute(command[0] ?? '') || resolve(command[0]).toLowerCase() !== resolve(executable).toLowerCase()) continue
    const args = command.slice(1) as string[]
    if (!args.some((argument) => argument.startsWith('--knowbook-system-plugin-os-startup='))) continue
    const profile = resolveKnowbookUserDataOverride(args)
    if (!profile) throw new Error('Host-managed startup command is missing its absolute profile directory.')
    profiles.add(profile)
  }
  return [...profiles]
}

async function discoverWindowsStartupProfiles(executable: string): Promise<string[]> {
  // No command is executed. Windows parses quoting, then TypeScript checks the
  // complete executable path before accepting the profile argument.
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KnowBookUninstallArgv {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string command, out int argc);
 [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
}
'@
$commands = [System.Collections.Generic.List[object]]::new()
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try {
 if ($key) { foreach ($name in $key.GetValueNames()) {
  $command = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($command -isnot [string]) { continue }
  $argc = 0
  $memory = [KnowBookUninstallArgv]::CommandLineToArgvW($command, [ref]$argc)
  if ($memory -eq [IntPtr]::Zero) { throw 'Unable to parse Windows startup command.' }
  try {
   $parts = [System.Collections.Generic.List[string]]::new()
   for ($index = 0; $index -lt $argc; $index++) {
    $parts.Add([Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, $index * [IntPtr]::Size)))
   }
   $commands.Add($parts.ToArray())
  } finally { [void][KnowBookUninstallArgv]::LocalFree($memory) }
 } }
} finally { if ($key) { $key.Dispose() } }
ConvertTo-Json -InputObject $commands.ToArray() -Depth 4 -Compress`
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
  return collectWindowsStartupProfiles(executable, JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
}

/** Uses persisted host metadata only: no discover/activate/deactivate or scripts. */
export async function cleanupSystemPluginsForApplicationUninstall(input: {
  userDataRoot: string
  executable: string
  app: FullTrustElectronLoginItemApplication
  discoverProfiles?: () => Promise<string[]>
}): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Installer cleanup currently targets Windows.')
  const profiles = [...new Set([
    resolve(input.userDataRoot),
    ...await (input.discoverProfiles ?? (() => discoverWindowsStartupProfiles(input.executable)))()
  ])]
  const failures: Error[] = []
  for (const profile of profiles) {
    const database = join(profile, 'storage', 'knowbook.db')
    if (!existsSync(database) && !existsSync(join(profile, 'database-restore-pending.json'))) continue
    let store: KnowbookStore | undefined
    let manager: SystemPluginManager | undefined
    let failure: unknown
    try {
      await recoverInterruptedDatabaseRestore(profile)
      if (!existsSync(database)) continue
      store = new KnowbookStore(database)
      const pluginRoot = join(profile, 'system-plugins')
      manager = new SystemPluginManager({
        repository: store.pluginPlatform,
        stagingRoot: join(pluginRoot, 'staging'), artifactRoot: join(pluginRoot, 'artifacts'),
        runtimeRoot: join(pluginRoot, 'runtime'), dataRoot: join(pluginRoot, 'data'),
        logRoot: join(pluginRoot, 'logs'), backupRoot: join(profile, 'backups', 'system-plugins'),
        backupDatabase: () => { throw new Error('Uninstall cleanup cannot run plugin backups or activation.') },
        osPersistenceAdapter: createFullTrustOsPersistenceAdapter({ platform: 'win32', electronApp: input.app })
      })
      await manager.cleanupForApplicationUninstall()
    } catch (error) {
      failure = error
      failures.push(new Error(`Uninstall cleanup failed for ${profile}`, { cause: error }))
    } finally {
      await manager?.destroy()
      store?.destroy()
      await writeFile(join(profile, 'system-plugin-uninstall-cleanup.json'), JSON.stringify({
        completedAt: new Date().toISOString(), executable: input.executable,
        status: failure ? 'failed' : 'passed', retainsUserData: true,
        failure: failure instanceof AggregateError ? [failure.message, ...failure.errors.map(String)].join('\n') : failure ? String(failure) : null
      }, null, 2)).catch((error) => failures.push(error))
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Unable to clean all host-managed plugin startup items and detached processes.')
}
