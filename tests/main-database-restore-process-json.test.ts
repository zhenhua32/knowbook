import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'
import { WINDOWS_RESTORE_PROCESS_JSON_SOURCE } from '../src/main/database/restore-process-json'

const windowsOnly = { skip: process.platform !== 'win32' }
// Pure scalar codec controls, not a fabricated CIM snapshot or an identity
// passed to the restore guard. Run the exact production encoder in Windows
// PowerShell with its original hidden20s/4MiB transport limits.
async function encode(fixture: string) {
  const source = `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${WINDOWS_RESTORE_PROCESS_JSON_SOURCE}\n${fixture}\n[Console]::WriteLine((ConvertTo-KnowBookProcessJson -Rows ([object[]]$rows)))`
  return promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
}
const row = String.raw`
$row=[Collections.Generic.Dictionary[string,object]]::new()
$row['pid']=[int]37
$row['name']=''
$row['executable']=$null
$row['startToken']='windows:123456789012345678'
$row['argv']=[object[]]@('', 'two words', '\\server\share\', '$(not a command); & literal', [string][char]0)
$rows=[object[]]@($row)`

test('native process JSON keeps the exact empty root and nullable scalar/argv shape', windowsOnly, async () => {
  assert.deepEqual(JSON.parse((await encode('$rows=[object[]]@()')).stdout), [])
  assert.deepEqual(JSON.parse((await encode(row)).stdout), [{ pid: 37, name: '', executable: null, startToken: 'windows:123456789012345678',
    argv: ['', 'two words', '\\\\server\\share\\', '$(not a command); & literal', '\0'] }])
  assert.deepEqual(JSON.parse((await encode(row + "\n$row['name']=$null\n$row['argv']=$null")).stdout),
    [{ pid: 37, name: null, executable: null, startToken: 'windows:123456789012345678', argv: null }])
  assert.deepEqual(JSON.parse((await encode(row + "\n$row['argv']=[object[]]@()")).stdout),
    [{ pid: 37, name: '', executable: null, startToken: 'windows:123456789012345678', argv: [] }])
})

test('native process JSON preserves every UTF16 code unit including isolated surrogates and JSON controls', windowsOnly, async () => {
  const actual = await encode(row + String.raw`
$units=[char[]]::new(65536)
for($index=0;$index -lt $units.Length;$index++) { $units[$index]=[char]$index }
$row['name']=[string]::new($units)
$row['argv']=[object[]]@([string]::new([char[]]@(34,92,8,9,10,12,13,8232,8233,55357,56832,55296,56320)))`)
  const decoded = JSON.parse(actual.stdout) as Array<{ name: string; argv: string[] }>
  const all = Array.from({ length: 65536 }, (_, index) => String.fromCharCode(index)).join('')
  assert.equal(decoded[0].name.length, all.length)
  let firstMismatch = -1
  for (let index = 0; index < all.length; index++) if (decoded[0].name.charCodeAt(index) !== all.charCodeAt(index)) { firstMismatch = index; break }
  assert.equal(firstMismatch, -1, 'Every original UTF16 code unit survives JSON and stdout encoding')
  assert.deepEqual(decoded[0].argv, [String.fromCharCode(34, 92, 8, 9, 10, 12, 13, 8232, 8233, 55357, 56832, 55296, 56320)])
})

test('native process JSON rejects an oversized ASCII snapshot before emitting any partial data', windowsOnly, async () => {
  await assert.rejects(encode(row + "\n$row['name']='x'*(4*1024*1024)"), error => {
    assert.equal((error as Error & { stdout: string }).stdout.length, 0)
    return true
  })
})

test('native process JSON enforces the original UTF8 byte budget before emitting a multibyte snapshot', windowsOnly, async () => {
  const astral = await encode(row + "\n$row['name']=([string]::new([char[]]@(55357,56832)))*(512*1024)")
  assert.ok((JSON.parse(astral.stdout) as Array<{ name: string }>)[0].name === '😀'.repeat(512 * 1024), 'A valid2MiB astral string retains its compact UTF8 representation')
  const controls = await encode(row + "\n$row['name']=([string][char]10)*(1024*1024)")
  assert.ok((JSON.parse(controls.stdout) as Array<{ name: string }>)[0].name === '\n'.repeat(1024 * 1024), 'Standard short JSON escapes preserve a previously readable2MiB representation')
  await assert.rejects(encode(row + "\n$row['name']=([string][char]27721)*(2*1024*1024)"), error => {
    assert.equal((error as Error & { stdout: string }).stdout.length, 0)
    return true
  })
})

test('native process JSON includes the actual stdout newline in its exact4MiB byte boundary', windowsOnly, async () => {
  const empty = (await encode(row)).stdout
  assert.ok(empty.endsWith('\r\n'))
  const width = 4 * 1024 * 1024 - Buffer.byteLength(empty)
  const exact = await encode(row + "\n$row['name']='x'*" + width)
  assert.equal(Buffer.byteLength(exact.stdout), 4 * 1024 * 1024)
  assert.equal((JSON.parse(exact.stdout) as Array<{ name: string }>)[0].name.length, width)
  await assert.rejects(encode(row + "\n$row['name']='x'*" + (width + 1)), error => {
    assert.equal((error as Error & { stdout: string }).stdout.length, 0)
    return true
  })
})
