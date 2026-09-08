import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createSystemPluginStartupCommand, resolveKnowbookUserDataOverride } from '../src/main/system-plugin/startup-command'

test('OS startup preserves the exact profile independently of cwd and environment', () => {
  const userDataRoot = resolve('fixtures', '工作区 with spaces')
  const command = createSystemPluginStartupCommand({
    executable: process.execPath, appPath: resolve('out'), isPackaged: true,
    userDataRoot, pluginId: 'system.startup-test'
  })
  assert.equal(command.executable, process.execPath)
  assert.equal(command.args.length, 2)
  assert.equal(resolveKnowbookUserDataOverride(command.args), userDataRoot)
  assert.equal(resolveKnowbookUserDataOverride(command.args, resolve('another-profile')), userDataRoot)
  assert.equal(command.args[1], '--knowbook-system-plugin-os-startup=system.startup-test')
})

test('development OS startup includes the absolute application entry', () => {
  const appPath = resolve('development app')
  const command = createSystemPluginStartupCommand({
    executable: process.execPath, appPath, isPackaged: false,
    userDataRoot: resolve('user data'), pluginId: 'system.startup-test'
  })
  assert.equal(command.args[0], appPath)
  assert.equal(command.args.length, 3)
})

test('startup rejects ambiguous or relative CLI profiles and retains the environment fallback', () => {
  for (const value of ['', 'relative-profile', 'bad\0path']) {
    assert.throws(() => resolveKnowbookUserDataOverride([`--knowbook-user-data-dir=${value}`]))
  }
  const argument = `--knowbook-user-data-dir=${resolve('profile')}`
  assert.throws(() => resolveKnowbookUserDataOverride([argument, argument]))
  assert.equal(resolveKnowbookUserDataOverride([], '  relative-profile  '), resolve('relative-profile'))
  assert.equal(resolveKnowbookUserDataOverride([], '  '), undefined)
})
