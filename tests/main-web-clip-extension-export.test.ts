import assert from 'node:assert/strict'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getWebClipExtensionSourceDirectory, WebClipExtensionExportService } from '../src/main/web-clip-extension-export.ts'

const files = ['manifest.json', 'popup.html', 'popup.js', 'page-collector.js', 'README.md']
const repositoryBundle = fileURLToPath(new URL('../web-clip-extension', import.meta.url))
const folderName = 'KnowBook Web Clipper'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(run: (context: { root: string; source: string; parent: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'knowbook-extension-export-'))
  const source = join(root, 'resources', 'web-clip-extension')
  const parent = join(root, '中文 导出位置')
  try {
    await mkdir(source, { recursive: true })
    await mkdir(parent)
    await Promise.all(files.map(name => copyFile(join(repositoryBundle, name), join(source, name))))
    await run({ root, source, parent })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('offline export writes exact bundled files at the manifest root and opens only its saved directory', () => fixture(async ({ source, parent }) => {
  const opened: string[] = []
  await writeFile(join(source, 'private-token.txt'), 'must not be exported')
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async path => { opened.push(path); return '' } })
  const result = await service.export(async () => parent)
  assert.ok(result)
  assert.equal(result.directory, join(await realpath(parent), folderName))
  assert.equal(result.version, JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')).version)
  assert.deepEqual((await readdir(result.directory)).sort(), [...files].sort())
  for (const name of files) assert.deepEqual(await readFile(join(result.directory, name)), await readFile(join(source, name)), name)
  assert.equal(opened.length, 0, 'export does not launch a file manager')
  const actualDirectory = result.directory
  result.directory = join(parent, 'not an exported folder')
  await service.openDirectory()
  assert.deepEqual(opened, [actualDirectory], 'renderer changes to the returned result cannot redirect opening')
  assert.deepEqual(await readdir(parent), [folderName], 'temporary export files are removed')
}))

test('cancel writes nothing and preserves the previous successful export', () => fixture(async ({ root, source, parent }) => {
  const opened: string[] = []
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async path => { opened.push(path); return '' } })
  assert.equal(await service.export(async () => null), null)
  assert.deepEqual(await readdir(parent), [])
  const result = await service.export(async () => parent)
  const elsewhere = join(root, 'another parent')
  await mkdir(elsewhere)
  assert.equal(await service.export(async () => null), null)
  assert.deepEqual(await readdir(elsewhere), [])
  await service.openDirectory()
  assert.deepEqual(opened, [result!.directory])
}))

test('existing empty directories, files, user folders and directory links are never overwritten', async t => {
  for (const kind of ['empty', 'file', 'user-folder', 'link'] as const) {
    await t.test(kind, () => fixture(async ({ root, source, parent }) => {
      const target = join(parent, folderName)
      if (kind === 'file') await writeFile(target, 'original file')
      else if (kind === 'link') {
        const external = join(root, 'linked user folder')
        await mkdir(external)
        await writeFile(join(external, 'user-data.txt'), 'preserve linked data')
        await symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        await mkdir(target)
        if (kind === 'user-folder') await writeFile(join(target, 'popup.html'), 'user-authored content')
      }
      let writes = 0
      const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => '',
        writeFile: async (handle, contents) => { writes++; await handle.writeFile(contents) } })
      await assert.rejects(service.export(async () => parent), /already exists.*another parent folder/)
      assert.equal(writes, 0)
      assert.deepEqual(await readdir(parent), [folderName])
      if (kind === 'empty') assert.deepEqual(await readdir(target), [])
      else if (kind === 'file') assert.equal(await readFile(target, 'utf8'), 'original file')
      else if (kind === 'user-folder') assert.equal(await readFile(join(target, 'popup.html'), 'utf8'), 'user-authored content')
      else {
        assert.equal((await lstat(target)).isSymbolicLink(), true)
        assert.equal(await readFile(join(target, 'user-data.txt'), 'utf8'), 'preserve linked data')
      }
    }))
  }
})

test('packaged exports require resources even when a usable developer source exists', () => fixture(async ({ root, source, parent }) => {
  const appPath = join(root, 'developer app')
  await mkdir(join(appPath, 'web-clip-extension'), { recursive: true })
  await Promise.all(files.map(name => copyFile(join(source, name), join(appPath, 'web-clip-extension', name))))
  const resourcesPath = join(root, 'missing installed resources')
  const service = new WebClipExtensionExportService({ sourceDirectory: getWebClipExtensionSourceDirectory({ isPackaged: true, appPath, resourcesPath }), openDirectory: async () => '' })
  await assert.rejects(service.export(async () => parent), /bundled browser extension is incomplete or unavailable/)
  assert.deepEqual(await readdir(parent), [])
  await mkdir(join(resourcesPath, 'web-clip-extension'), { recursive: true })
  await Promise.all(files.map(name => copyFile(join(source, name), join(resourcesPath, 'web-clip-extension', name))))
  const result = await service.export(async () => parent)
  assert.ok(result)
  const developerParent = join(root, 'developer output')
  await mkdir(developerParent)
  const developer = new WebClipExtensionExportService({ sourceDirectory: getWebClipExtensionSourceDirectory({ isPackaged: false, appPath, resourcesPath: join(root, 'unavailable resources') }), openDirectory: async () => '' })
  assert.ok(await developer.export(async () => developerParent))
}))

test('missing resources and an invalid manifest are fully rejected before any output is created', async t => {
  for (const kind of ['missing-file', 'invalid-manifest'] as const) {
    await t.test(kind, () => fixture(async ({ source, parent }) => {
      if (kind === 'missing-file') await rm(join(source, 'README.md'))
      else await writeFile(join(source, 'manifest.json'), '{broken-json')
      const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => '' })
      await assert.rejects(service.export(async () => parent), /bundled browser extension is incomplete or unavailable/)
      assert.deepEqual(await readdir(parent), [])
    }))
  }
})

test('partial staging and publication failures remove only this export and can be retried', async t => {
  for (const failureAt of [2, 7]) {
    await t.test(`write ${failureAt}`, () => fixture(async ({ source, parent }) => {
      let writes = 0
      let fail = true
      const writer = async (handle: FileHandle, contents: Buffer) => {
        writes++
        if (fail && writes === failureAt) {
          await handle.writeFile(contents.subarray(0, 2))
          throw new Error('controlled interrupted write')
        }
        await handle.writeFile(contents)
      }
      const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => '', writeFile: writer })
      await assert.rejects(service.export(async () => parent), /Choose a writable folder/)
      assert.deepEqual(await readdir(parent), [], 'neither a partial install folder nor staging files survive')
      fail = false
      const result = await service.export(async () => parent)
      assert.deepEqual((await readdir(result!.directory)).sort(), [...files].sort())
    }))
  }
})

test('failed publication preserves foreign files and the earlier successful open target', () => fixture(async ({ root, source, parent }) => {
  const failedParent = join(root, 'failed output')
  await mkdir(failedParent)
  let failing = false
  let writes = 0
  const opened: string[] = []
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async path => { opened.push(path); return '' },
    writeFile: async (handle, contents) => {
      writes++
      if (failing && writes === 7) {
        await handle.writeFile(contents.subarray(0, 2))
        await writeFile(join(failedParent, folderName, 'user-data.txt'), 'added independently during export')
        throw new Error('controlled publication failure')
      }
      await handle.writeFile(contents)
    } })
  const first = await service.export(async () => parent)
  writes = 0
  failing = true
  await assert.rejects(service.export(async () => failedParent), /Failed to export/)
  assert.deepEqual(await readdir(failedParent), [folderName])
  assert.deepEqual(await readdir(join(failedParent, folderName)), ['user-data.txt'])
  assert.equal(await readFile(join(failedParent, folderName, 'user-data.txt'), 'utf8'), 'added independently during export')
  await service.openDirectory()
  assert.deepEqual(opened, [first!.directory])
}))

test('a same-name directory created during staging is retained rather than replaced at publication', () => fixture(async ({ source, parent }) => {
  let writes = 0
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => '',
    writeFile: async (handle, contents) => {
      await handle.writeFile(contents)
      if (++writes === 1) await mkdir(join(parent, folderName))
    } })
  await assert.rejects(service.export(async () => parent), /already exists/)
  assert.deepEqual(await readdir(parent), [folderName])
  assert.deepEqual(await readdir(join(parent, folderName)), [])
}))

test('failed publication keeps a replacement file while removing its own partial files', () => fixture(async ({ root, source, parent }) => {
  const replacement = join(root, 'external manifest.json')
  const movedOriginal = join(root, 'moved original manifest.json')
  const target = join(parent, folderName)
  let writes = 0
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => '',
    writeFile: async (handle, contents) => {
      if (++writes === 7) {
        // Allocate the replacement while the original still exists so it has a
        // distinct native identity, then replace the already closed manifest.
        await writeFile(replacement, 'independently replaced manifest')
        await rename(join(target, 'manifest.json'), movedOriginal)
        await rename(replacement, join(target, 'manifest.json'))
        await handle.writeFile(contents.subarray(0, 2))
        throw new Error('controlled publication failure after replacement')
      }
      await handle.writeFile(contents)
    } })
  await assert.rejects(service.export(async () => parent), /Failed to export/)
  assert.deepEqual(await readdir(parent), [folderName], 'staging is removed despite publication failure')
  assert.deepEqual(await readdir(target), ['manifest.json'], 'own partial popup is removed, external replacement is retained')
  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), 'independently replaced manifest')
  assert.deepEqual(await readFile(movedOriginal), await readFile(join(source, 'manifest.json')), 'moved original is not removed through its new path')
}))

test('export immediately excludes duplicate export and open requests and releases its lock after cancellation', () => fixture(async ({ source, parent }) => {
  const selection = deferred<string | null>()
  let dialogs = 0
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => '' })
  const first = service.export(() => { dialogs++; return selection.promise })
  await assert.rejects(service.export(async () => { dialogs++; return parent }), /already in progress/)
  await assert.rejects(service.openDirectory(), /already in progress/)
  assert.equal(dialogs, 1)
  selection.resolve(null)
  assert.equal(await first, null)
  assert.ok(await service.export(async () => parent))
}))

test('opening excludes both actions and a rejected native open remains retryable without re-export', () => fixture(async ({ source, parent }) => {
  const opening = deferred<string>()
  const started = deferred<void>()
  let calls = 0
  const service = new WebClipExtensionExportService({ sourceDirectory: source,
    openDirectory: async () => { calls++; if (calls === 1) { started.resolve(); return opening.promise }; return '' } })
  const result = await service.export(async () => parent)
  const first = service.openDirectory()
  const rejected = assert.rejects(first, /controlled native open failure/)
  await started.promise
  let dialogs = 0
  await assert.rejects(service.export(async () => { dialogs++; return parent }), /already in progress/)
  await assert.rejects(service.openDirectory(), /already in progress/)
  assert.equal(dialogs, 0)
  opening.reject(new Error('controlled native open failure'))
  await rejected
  await service.openDirectory()
  assert.equal(calls, 2)
  assert.deepEqual((await readdir(result!.directory)).sort(), [...files].sort())
}))

test('a nonempty shell result reports failure while preserving the directory for open retry', () => fixture(async ({ source, parent }) => {
  const opened: string[] = []
  const service = new WebClipExtensionExportService({ sourceDirectory: source,
    openDirectory: async path => { opened.push(path); return opened.length === 1 ? 'File manager is unavailable.' : '' } })
  const result = await service.export(async () => parent)
  await assert.rejects(service.openDirectory(), /File manager is unavailable/)
  await service.openDirectory()
  assert.deepEqual(opened, [result!.directory, result!.directory])
}))

test('open requires a completed export and reports a subsequently removed directory without calling the shell', () => fixture(async ({ source, parent }) => {
  let calls = 0
  const service = new WebClipExtensionExportService({ sourceDirectory: source, openDirectory: async () => { calls++; return '' } })
  await assert.rejects(service.openDirectory(), /Export.*before opening/)
  const result = await service.export(async () => parent)
  await rm(result!.directory, { recursive: true })
  await assert.rejects(service.openDirectory(), /folder is missing or unavailable/)
  assert.equal(calls, 0)
  assert.ok(await service.export(async () => parent), 'missing export can be recreated explicitly')
}))
