import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { collectWindowsStartupProfiles, isSystemPluginUninstallCleanup } from '../src/main/system-plugin/uninstall-cleanup'

test('uninstall maintenance accepts only one exact explicit command', () => {
  assert.equal(isSystemPluginUninstallCleanup(['KnowBook']), false)
  assert.equal(isSystemPluginUninstallCleanup(['KnowBook', '--knowbook-uninstall-cleanup']), true)
  assert.throws(() => isSystemPluginUninstallCleanup(['--knowbook-uninstall-cleanup=1']), /Invalid/)
  assert.throws(() => isSystemPluginUninstallCleanup(['--knowbook-uninstall-cleanup', '--knowbook-uninstall-cleanup']), /Invalid/)
})

test('uninstall discovers exact host startup profiles and rejects malformed owned commands', () => {
  const executable = resolve('fixture', 'KnowBook.exe')
  const profile = resolve('fixture', 'profile 空格')
  const args = [executable, `--knowbook-user-data-dir=${profile}`, '--knowbook-system-plugin-os-startup=fixture']
  assert.deepEqual(collectWindowsStartupProfiles(executable, [args, args,
    [resolve('another', 'KnowBook.exe'), ...args.slice(1)], [executable, '--unrelated']]), [profile])
  assert.throws(() => collectWindowsStartupProfiles(executable, [[executable, '--knowbook-system-plugin-os-startup=fixture']]), /missing/)
  assert.throws(() => collectWindowsStartupProfiles(executable, [[executable, '--knowbook-user-data-dir=relative', args[2]]]), /absolute/)
  assert.throws(() => collectWindowsStartupProfiles(executable, [null]), /invalid argv/)
  assert.throws(() => collectWindowsStartupProfiles(executable, {}), /invalid data/)
})
