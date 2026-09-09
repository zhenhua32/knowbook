import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareSystemPluginRuntimeLinks } from '../src/main/system-plugin/runtime-links'

test('internal directory links and dependency cycles survive moving the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-runtime-links-'))
  try {
    const source = join(root, 'preparing')
    const target = join(root, 'published')
    const library = join(source, 'node_modules', '.pnpm', 'value')
    await mkdir(library, { recursive: true })
    await writeFile(join(library, 'index.cjs'), 'module.exports = 42')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(library, join(source, 'node_modules', 'value'), type)
    await symlink(join(source, 'node_modules'), join(library, 'node_modules'), type)
    if (process.platform !== 'win32') await symlink('.pnpm/value', join(source, 'node_modules', 'relative-value'), 'dir')
    const verify = await prepareSystemPluginRuntimeLinks(source, target)
    await rename(source, target)
    await verify()
    assert.equal(await readFile(join(target, 'node_modules', 'value', 'index.cjs'), 'utf8'), 'module.exports = 42')
    assert.equal(await realpath(join(target, 'node_modules', 'value', 'node_modules', 'value')), join(target, 'node_modules', '.pnpm', 'value'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime links reject external targets before changing an existing runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-runtime-links-external-'))
  try {
    const source = join(root, 'preparing')
    const target = join(root, 'published')
    const outside = join(root, 'outside')
    for (const path of [source, target, outside]) await mkdir(path)
    await writeFile(join(target, 'active'), 'original runtime')
    await symlink(outside, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(prepareSystemPluginRuntimeLinks(source, target), /outside its runtime root/)
    assert.equal(await readFile(join(target, 'active'), 'utf8'), 'original runtime')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('publication verification rejects a link redirected after preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-runtime-links-changed-'))
  try {
    const source = join(root, 'preparing')
    const target = join(root, 'published')
    for (const path of ['original', 'other']) await mkdir(join(source, path), { recursive: true })
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(source, 'original'), join(source, 'link'), type)
    const verify = await prepareSystemPluginRuntimeLinks(source, target)
    await rename(source, target)
    await rm(join(target, 'link'))
    await symlink(join(target, 'other'), join(target, 'link'), type)
    await assert.rejects(verify(), /changed target/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
