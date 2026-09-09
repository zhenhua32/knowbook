import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { SystemPluginManager, type SystemPluginDetachedProcessInspector, type SystemPluginManagerOptions } from '../src/main/system-plugin/manager'

test('Windows process identity preserves Unicode paths through a real PowerShell stdout pipe', {
  skip: process.platform !== 'win32'
}, async (context) => {
  const executable = 'C:\\安装目录\\KnowBook 验收\\KnowBook.exe'
  const encodedPath = Buffer.from(executable, 'utf8').toString('base64')
  const nativeExecFile = childProcess.execFile
  const probe = context.mock.method(childProcess, 'execFile', ((
    file: string,
    args: string[],
    options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void
  ) => {
    assert.equal(file, 'powershell.exe')
    assert.equal(options.encoding, 'utf8')
    assert.equal(options.timeout, 15_000)
    assert.equal(options.maxBuffer, 128 * 1024)
    // Supply deterministic CIM data without machine inventory access. The real
    // shell starts with a non-UTF8 codepage, as Windows PowerShell normally does.
    const prelude = `[Console]::OutputEncoding = [System.Text.ASCIIEncoding]::new(); function Get-CimInstance { [pscustomobject]@{ ExecutablePath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); CreationDate = [DateTime]::Parse('2026-09-09T10:00:00Z').ToUniversalTime() } }; `
    return nativeExecFile(file, [...args.slice(0, -1), prelude + args.at(-1)], options, callback)
  }) as typeof childProcess.execFile)
  syncBuiltinESMExports()
  try {
    const manager = new SystemPluginManager({
      repository: {} as SystemPluginManagerOptions['repository'],
      stagingRoot: resolve('unused-staging'), artifactRoot: resolve('unused-artifacts'),
      dataRoot: resolve('unused-data'), backupRoot: resolve('unused-backups'),
      backupDatabase: () => { throw new Error('Identity inspection must not create a backup.') }
    })
    // Exercise the default OS inspector installed by the manager constructor.
    const inspect = (manager as unknown as { inspectDetachedProcess: SystemPluginDetachedProcessInspector }).inspectDetachedProcess
    const result = await inspect(12345)
    assert.deepEqual(result, { pid: 12345, executable, startToken: 'windows:639245448000000000' })
  } finally {
    probe.mock.restore()
    syncBuiltinESMExports()
  }
})
