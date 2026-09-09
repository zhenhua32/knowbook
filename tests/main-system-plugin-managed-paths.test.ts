import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isSystemPluginManagedPath, resolveSystemPluginPhysicalPath } from '../src/main/system-plugin/managed-paths'

test('managed paths accept canonical children of an aliased userData root and repeat cleanup', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'knowbook-managed-path-'))
  try {
    const physical = join(folder, 'physical')
    const alias = join(folder, 'alias')
    await mkdir(join(physical, 'staging', 'request'), { recursive: true })
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const root = join(alias, 'staging')
    const candidate = join(physical, 'staging', 'request')
    assert.equal(await isSystemPluginManagedPath(candidate, root, 'request'), true)
    assert.equal(await isSystemPluginManagedPath(candidate, root, 'another-request'), false)
    await rm(candidate, { recursive: true })
    assert.equal(await isSystemPluginManagedPath(candidate, root, 'request'), true)
    assert.equal(await resolveSystemPluginPhysicalPath(join(alias, 'missing', 'revision')), join(physical, 'missing', 'revision'))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('managed paths reject roots, siblings and nested links escaping the physical root', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'knowbook-managed-path-'))
  try {
    const root = join(folder, 'managed')
    const outside = join(folder, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await isSystemPluginManagedPath(root, root), false)
    assert.equal(await isSystemPluginManagedPath(outside, root), false)
    assert.equal(await isSystemPluginManagedPath(join(root, 'escape', 'file'), root), false)
    assert.equal(await isSystemPluginManagedPath(join(root, 'escape'), root, 'escape'), false)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('managed paths bind the real directory entry to its exact plugin and revision', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'knowbook-managed-entry-'))
  try {
    const root = join(folder, 'managed')
    const outside = join(folder, 'outside')
    await mkdir(join(root, 'request'), { recursive: true })
    await mkdir(join(root, 'another-plugin', 'hash'), { recursive: true })
    await mkdir(outside)
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(root, 'request'), join(outside, 'alias'), kind)
    await symlink(join(root, 'request'), join(root, 'other-request'), kind)
    await symlink(join(root, 'another-plugin'), join(root, 'plugin'), kind)
    assert.equal(await isSystemPluginManagedPath(join(outside, 'alias'), root, 'request'), false)
    assert.equal(await isSystemPluginManagedPath(join(root, 'other-request'), root, 'request'), false)
    assert.equal(await isSystemPluginManagedPath(join(root, 'plugin', 'hash'), root, join('plugin', 'hash')), false)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
