import { expect, test, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { closeElectronApp, evaluateInFreshElectronMain, getElectronLaunchTarget, launchElectronApp, relaunchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'
import { appendCanonicalText, closeEvents, inlineInstance, observeRealEditorClose, openInlineHost } from './helpers/canonical-inline'
import { expectSource, sourceValue } from './helpers/markdown-source'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { createPublicationHttpServer } from '../tests/helpers/synced-publication-http-fixture'

const run = promisify(execFile)

type RestoreDialogProbe = { pid: number; options: { title: string; buttons: string[]; defaultId: number; cancelId: number }[] }
type RestoreDialogGlobals = typeof globalThis & { __v3RestoreDialogProbe?: RestoreDialogProbe }

async function verifyV3RestoreCloseGate(context: ElectronAppContext, profile: string, id: string, info: TestInfo) {
  const { app, page } = context
  const cdp = await page.context().newCDPSession(page)
  const rootState = async () => {
    const db = await lstat(join(profile, 'storage', 'knowbook.db'), { bigint: true })
    if (!db.isFile() || db.isSymbolicLink() || !db.ino) throw new Error('The original live SQLite file is required')
    const rootFiles = await readdir(profile)
    const pointers = ['database-restore-fence.json', 'database-restore-pending.json',
      'database-restore-e2e-preview.json', 'database-restore-result.json'].filter(name => rootFiles.includes(name))
    const recoveryOperations = await readdir(join(profile, 'backups', 'database-restore')).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    })
    return { database: { dev: String(db.dev), ino: String(db.ino) }, pointers, recoveryOperations: recoveryOperations.sort() }
  }
  const readProbe = () => evaluateInFreshElectronMain(app, () => (globalThis as RestoreDialogGlobals).__v3RestoreDialogProbe ?? null)
  const readDoc = () => page.evaluate(docId => window.knowbook.getDocumentDetail(docId), id)
  const restore = (version: string) => page.evaluate(versionId => window.knowbook.restoreBackupVersion(versionId), version)
  try {
    const current = await readDoc()
    if (!current) throw new Error('The retained host must be present in its live Store')
    const version = await page.evaluate(async () => {
      const candidates = (await window.knowbook.listBackupVersions()).filter(item => item.format === 'synced-v3')
      if (candidates.length !== 1) throw new Error('The exact seeded V3 backup is required')
      return candidates[0].id
    })
    const before = await rootState()
    expect(before.pointers).toEqual([])
    expect(before.recoveryOperations).toEqual([])
    await observeRealEditorClose(page)
    const initialEvents = await closeEvents(page)
    expect(initialEvents).toEqual({ requests: [], cancelled: [] })
    await openInlineHost(page, current)
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
    const editor = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码'), exact: true })
    const initial = await sourceValue(editor), working = initial + ' unapplied V3 close guard 中文🙂'
    await editor.press('Control+End')
    await page.keyboard.insertText(' unapplied V3 close guard 中文🙂')
    await expectSource(editor, working)

    // Use the real preload method while Source owns the active editor. The
    // native confirmation fixture supplies the default on its first invocation.
    expect(await restore(version)).toBeNull()
    expect(await closeEvents(page)).toEqual(initialEvents)
    expect(await rootState()).toEqual(before)
    await expectSource(editor, working)

    await cdp.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 })
    await expectSource(editor, working + '候选')
    expect(await restore(version)).toBeNull()
    await expect.poll(async () => (await closeEvents(page)).cancelled.length).toBe(1)
    const events = await closeEvents(page)
    expect(events.requests).toHaveLength(1)
    const request = events.requests[0]
    expect(request).toMatchObject({ requestId: expect.any(String), reason: 'quit' })
    expect(events.cancelled).toEqual([{ ...request,
      message: expect.stringMatching(/Unsaved editor or source changes keep this window open|编辑草稿或源码尚未保存，窗口保持打开/) }])
    expect(await readDoc()).toEqual(current)
    expect(await rootState()).toEqual(before)
    expect(await readProbe()).toMatchObject({ pid: expect.any(Number), options: Array.from({ length: 2 }, () => ({
      title: '确认恢复 V3 备份', buttons: ['重启并预览', '取消'], defaultId: 1, cancelId: 1
    })) })
    await expectSource(editor, working + '候选')
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await expectSource(editor, working)
    await editor.press('Control+End')
    await page.keyboard.insertText(' still editable')
    await expectSource(editor, working + ' still editable')
    await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await readDoc()).toEqual(current)
    expect(await rootState()).toEqual(before)
  } finally {
    const [events, nativeDialog, restorePaths] = await Promise.allSettled([closeEvents(page), readProbe(), rootState()])
    const evidence = { profile, appClosed: page.isClosed(), closeEvents: events.status === 'fulfilled' ? events.value : String(events.reason),
      nativeDialog: nativeDialog.status === 'fulfilled' ? nativeDialog.value : String(nativeDialog.reason),
      restorePaths: restorePaths.status === 'fulfilled' ? restorePaths.value : String(restorePaths.reason) }
    await info.attach('v3-restore-editor-close-gate', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
    await cdp.detach().catch(() => undefined)
  }
}

test('confirmed V3 restore restarts into maintenance and opens in a new background renderer @electron', async ({}, info) => {
  test.setTimeout(150_000)
  const directory = await mkdtemp(join(tmpdir(), 'knowbook-e2e-v3-'))
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
  expect(relative(tmpdir(), directory)).toMatch(/^knowbook-e2e-v3-[^\\/]+$/)
  const incoming = join(directory, 'incoming'), profile = join(directory, 'target')
  const electron = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  const executable = join(electron, 'dist', (await readFile(join(electron, 'path.txt'), 'utf8')).trim())
  const target = getElectronLaunchTarget()
  const script = `
    import { createV3Fixture, addV3Assets, applySyncedHostCommand, createRequest, created, freshBlock, randomUUID } from './tests/helpers/synced-backup-v3-fixture.ts'
    import { KnowbookStore } from './src/main/database/store.ts'
    import { writeSyncedBackupV3 } from './src/main/backup/v3-export.ts'
    import { mkdirSync } from 'node:fs'
    import { dirname, join } from 'node:path'
    const [incoming, target] = process.argv.slice(1)
    const source = createV3Fixture(incoming)
    const receiver = KnowbookStore.createEmptySyncedReceiver(join(target, 'storage', 'knowbook.db'))
    try {
      const retained = receiver.createDocument(null)
      receiver.updateDocument(retained, { title: 'V3 retained document', summary: 'Retained original summary', blocks: [] })
      await addV3Assets(source)
      const editableId = randomUUID()
      const request = createRequest(source.db, { documentId: source.hostId, selectedRootIds: [editableId], dirty(host) {
        host.blocks.push(freshBlock(editableId, 'Restored shared paragraph'))
      } })
      created(applySyncedHostCommand(source.db, request))
      const snapshotId = randomUUID(), archive = join(target, 'backups', 'markdown-history', snapshotId)
      mkdirSync(dirname(archive), { recursive: true })
      writeSyncedBackupV3(source.db, { userDataRoot: source.userDataRoot, destination: archive, snapshotId })
      process.stdout.write(JSON.stringify({ archive, retained, source: source.hostId, sourceCount: source.sourceDocumentIds.length }))
    } finally { receiver.destroy(); source.close() }
  `
  let context: ElectronAppContext | null = null, complete = false
  try {
    await mkdir(profile)
    const seeded = await run(executable, ['--import', 'tsx', '--input-type=module', '-e', script, incoming, profile], {
      cwd: target.cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000
    })
    const data = JSON.parse(seeded.stdout)
    context = await launchElectronApp({ KNOWBOOK_E2E_V3_RESTORE_CONSENT: '1' }, { userDataRoot: profile })
    const original = context
    await evaluateInFreshElectronMain(original.app, ({ app, dialog }) => {
      const probe: RestoreDialogProbe = { pid: process.pid, options: [] }
      ;(globalThis as RestoreDialogGlobals).__v3RestoreDialogProbe = probe
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async (_owner: unknown, options: RestoreDialogProbe['options'][number]) => {
        if (options.title !== '确认恢复 V3 备份') throw new Error('Unexpected native confirmation')
        probe.options.push({ title: options.title, buttons: [...options.buttons], defaultId: options.defaultId, cancelId: options.cancelId })
        if (options.defaultId !== 1 || options.cancelId !== 1) throw new Error('V3 restore must require an explicit restart choice')
        return { response: probe.options.length === 1 ? options.defaultId : 0 }
      } })
      return app.isReady()
    })
    const page = original.page
    await verifyV3RestoreCloseGate(original, profile, data.retained, info)
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('Storage & recovery', '存储与恢复'), exact: true }).click()
    await page.getByRole('button', { name: uiText('View backup versions', '查看备份版本'), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Backup versions', '备份版本') })
    await dialog.getByRole('button', { name: /Complete V3 backup|完整 V3 备份/ }).click()
    await expect(dialog).toContainText(/restarts to prepare a restore plan|重启并生成恢复计划/)
    const restore = dialog.getByRole('button', { name: uiText('Restore selected backup', '恢复所选备份') })
    let rendererFailure: string | undefined
    const rendererAction = restore.click().catch(error => {
      if (!/Target page, context or browser has been closed|Execution context was destroyed/.test(String(error))) rendererFailure = String(error)
    })
    const previewPath = join(profile, 'database-restore-e2e-preview.json')
    const resultPath = join(profile, 'database-restore-result.json')
    let preview: { operationId: string; intentHash: string; documents: { incoming: number; replaced: number; retained: number }; conflicts: number } | undefined
    await expect.poll(async () => {
      if (rendererFailure) throw new Error(rendererFailure)
      try {
        const terminal = JSON.parse(await readFile(resultPath, 'utf8')) as { status: string; error?: string }
        if (terminal.status === 'failed' || terminal.status === 'cancelled') {
          throw new Error(`V3 restore ended before preview (${terminal.status}): ${terminal.error ?? 'no maintenance error'}`)
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      try { preview = JSON.parse(await readFile(previewPath, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return preview
    }, { timeout: 90_000 }).toMatchObject({ operationId: expect.any(String), intentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      documents: { incoming: data.sourceCount, replaced: 0, retained: 1 }, conflicts: 0 })
    expect(preview).toBeDefined()
    await expect(readFile(join(profile, 'database-restore-pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const consent = join(profile, 'database-restore-e2e-consent.json')
    await writeFile(consent + '.pending', JSON.stringify({ operationId: preview!.operationId, intentHash: preview!.intentHash, confirmed: true }), { flag: 'wx' })
    await rename(consent + '.pending', consent)
    let result: { status: string; error?: string } | undefined
    await expect.poll(async () => {
      try { result = JSON.parse(await readFile(resultPath, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return result
    }, { timeout: 90_000 }).toMatchObject({ status: 'restored' })
    await rendererAction
    expect(rendererFailure).toBeUndefined()
    expect(result).toMatchObject({ status: 'restored', operationId: preview!.operationId, requestId: preview!.operationId })
    await closeElectronApp(original, { preserveUserData: true })
    context = null
    await rename(data.archive, data.archive + '-retired')
    context = await relaunchElectronApp({ userDataRoot: profile })
    const reopened = context.page
    const current = await reopened.evaluate(async ({ retained, source }) => ({
      retained: (await window.knowbook.getDocumentDetail(retained))?.summary,
      source: await window.knowbook.getDocumentDetail(source)
    }), data)
    expect(current.retained).toBe('Retained original summary')
    expect(current.source?.summary).toMatch(/file:.*attachments/)
    expect(current.source).toBeTruthy()
    await openInlineHost(reopened, current.source!)
    const addresses = current.source!.blocks.filter(block => block.type === 'synced-block').map(block => ({
      hostDocumentId: data.source, instanceId: block.id, groupId: parseSyncedBlockPayload(block.content).groupId
    }))
    const restored = await reopened.evaluate(async inputs => Promise.all(inputs.map(input => window.knowbook.resolveSyncedInlineInstance(input))), addresses)
    const index = restored.findIndex(result => result.status === 'ready' && result.snapshot.blocks[0]?.content === 'Restored shared paragraph')
    expect(index).toBeGreaterThanOrEqual(0)
    const address = addresses[index]
    const resolveInstance = () => reopened.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), address)
    const group = await resolveInstance()
    expect(group.status).toBe('ready')
    if (group.status !== 'ready') throw new Error('Restored shared group did not open')
    const block = group.snapshot.blocks[0], suffix = ' edited after restore'
    const instance = inlineInstance(reopened, address.instanceId)
    expect(block.content).toBe('Restored shared paragraph')
    await appendCanonicalText(reopened, address.instanceId, block.id, block.content, suffix)
    await instance.getByRole('button', { name: uiText('Save / retry', '保存／重试'), exact: true }).click()
    await expect.poll(async () => {
      const result = await resolveInstance()
      return result.status === 'ready' ? result.snapshot.blocks.find(item => item.id === block.id)?.content : undefined
    }).toBe(block.content + suffix)
    complete = true
  } finally {
    await closeElectronApp(context, { preserveUserData: true })
    if (complete) await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    else console.error('Retained isolated V3 Electron profile:', directory)
  }
})

test('restored WebDAV receiver cancels then confirms reconnection in Settings and downloads the independent remote edit @electron', async () => {
  test.skip(Boolean(process.env.KNOWBOOK_E2E_EXECUTABLE), 'This isolated native dialog fixture requires the local unpackaged Electron build.')
  test.setTimeout(150_000)
  const directory = await mkdtemp(join(tmpdir(), 'knowbook-e2e-v3-'))
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
  expect(relative(tmpdir(), directory)).toMatch(/^knowbook-e2e-v3-[^\\/]+$/)
  const profile = join(directory, 'target'), server = await createPublicationHttpServer()
  const electron = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  const executable = join(electron, 'dist', (await readFile(join(electron, 'path.txt'), 'utf8')).trim())
  const script = `
    import assert from 'node:assert/strict'
    import { createV3Fixture, randomUUID } from './tests/helpers/synced-backup-v3-fixture.ts'
    import { KnowbookStore } from './src/main/database/store.ts'
    import { createEphemeralCredentialStorage } from './src/main/credential-storage.ts'
    import { runProtocol5WebDav } from './src/main/sync/protocol5-service.ts'
    import { WebDavSyncService } from './src/main/sync/service.ts'
    import { writeSyncedBackupV3 } from './src/main/backup/v3-export.ts'
    import { restoreControlledBackupV3 } from './src/main/database/restore-safety.ts'
    import { mkdir, rename } from 'node:fs/promises'
    import { join } from 'node:path'
    const [directory, profile, url] = process.argv.slice(1)
    const route = { enabled: false, url, username: 'test', directory: 'Rejoin', intervalMinutes: 5, allowInsecureHttp: true }
    const credentials = { password: 'app-secret' }
    const source = createV3Fixture(join(directory, 'source')), documentId = source.targetId
    source.close()
    const A = KnowbookStore.openCanonicalRuntime(source.file)
    try {
      const initial = await runProtocol5WebDav(A, source.userDataRoot, route, credentials)
      assert.ok(initial.uploaded > 0)
      const B = KnowbookStore.createEmptySyncedReceiver(join(profile, 'storage', 'knowbook.db'))
      try {
        const service = new WebDavSyncService(B, profile, createEphemeralCredentialStorage(randomUUID))
        service.saveConfig({ ...route, ...credentials })
        assert.ok((await runProtocol5WebDav(B, profile, route, credentials)).downloaded > 0)
        const detail = B.getDocumentDetail(documentId)
        assert.ok(detail)
        // Acquire the actual settled baseline by publishing an independent receiver edit.
        const host = B.getDocumentDetail(source.hostId)
        assert.ok(host)
        const localId = B.createDocument(null)
        B.updateDocument(localId, { title: 'Restored rejoin local original', summary: '', blocks: [] })
        assert.ok((await runProtocol5WebDav(B, profile, route, credentials)).uploaded > 0)
      } finally { B.destroy() }
      await runProtocol5WebDav(A, source.userDataRoot, route, credentials)
      const other = A.createDocument(null), remote = 'Independent remote edit after the common version'
      A.updateDocument(other, { title: 'WebDAV rejoin remote addition', summary: '', blocks: [
        { id: randomUUID(), type: 'paragraph', content: remote, checked: false, depth: 0, parentBlockId: null }
      ] })
      assert.ok((await runProtocol5WebDav(A, source.userDataRoot, route, credentials)).uploaded > 0)
      const donorRoot = join(directory, 'donor'), archive = join(directory, 'restore-donor')
      await mkdir(donorRoot)
      const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
      try {
        donor.updateDocument(donor.createDocument(null), { title: 'V3 rejoin donor', summary: 'Restored donor proof', blocks: [] })
        writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: archive, snapshotId: randomUUID() })
      } finally { donor.destroy() }
      const install = await restoreControlledBackupV3({ userDataRoot: profile, backupDirectory: archive, stopProcesses: async () => [] },
        { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy restore') } })
      await rename(archive, archive + '-retired')
      process.stdout.write(JSON.stringify({ operationId: install.operationId, other, remote }))
    } finally { A.destroy() }
  `
  let context: ElectronAppContext | null = null, complete = false
  try {
    await mkdir(profile)
    const seed = await run(executable, ['--import', 'tsx', '--input-type=module', '-e', script, directory, profile, server.url],
      { cwd: getElectronLaunchTarget().cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 110_000 })
    const data = JSON.parse(seed.stdout) as { operationId: string; other: string; remote: string }
    const manifest = '/Rejoin/manifest.json', advanced = Buffer.from(server.files.get(manifest)!)
    expect(data.operationId).toMatch(/^[a-f0-9-]{36}$/)
    expect(JSON.parse(advanced.toString()).entries['doc:' + data.other]).toMatch(/^[a-f0-9]{64}$/)
    context = await launchElectronApp({ KNOWBOOK_E2E_V3_WEB_DAV_REJOIN: '1' }, { userDataRoot: profile })
    const { app, page } = context
    const decisions = (response: number) => evaluateInFreshElectronMain(app, ({ dialog }, response) => {
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async (_parent: unknown, options: {
        title: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number
      }) => {
        if (options.title !== '恢复后续接 WebDAV' || !/已核对 [1-9]\d* 项原共同版本。远端有后续修改。/.test(options.detail ?? '')
          || options.buttons?.join('/') !== '续接/取消' || options.defaultId !== 1 || options.cancelId !== 1) throw new Error('Unexpected native reconnection confirmation')
        return { response }
      } })
      return true
    }, response)
    const content = () => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks[0]?.content ?? null, data.other)
    expect(await content()).toBeNull()
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    const settings = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
    await expect(settings.getByRole('textbox', { name: uiText('Remote sync folder', '远端同步目录') })).toHaveValue('Rejoin')
    await settings.getByLabel(uiText('App password', '应用密码'), { exact: true }).fill('app-secret')
    await settings.getByRole('button', { name: uiText('Save sync settings', '保存同步设置'), exact: true }).click()
    const rejoin = settings.getByRole('button', { name: uiText('Reconnect to sync folder', '续接原同步目录'), exact: true })
    const sync = settings.getByRole('button', { name: uiText('Sync now', '立即同步'), exact: true })
    await expect(rejoin).toBeEnabled()
    const readOnly = (start: number) => {
      const requests = server.requests.slice(start)
      expect(requests.some(request => request.method === 'GET' && request.path === manifest)).toBe(true)
      expect(requests.every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method))).toBe(true)
      expect(server.files.get(manifest)).toEqual(advanced)
    }
    await decisions(1)
    const beforeCancel = server.requests.length
    await rejoin.click()
    await expect(settings.getByText('已取消续接，工作区保持暂停。', { exact: true })).toBeVisible()
    await expect(rejoin).toBeEnabled(); await expect(sync).toHaveCount(0)
    readOnly(beforeCancel)
    expect(await content()).toBeNull()
    await decisions(0)
    const beforeConfirm = server.requests.length
    await rejoin.click()
    await expect(settings.getByText('已续接原同步目录，可以开始同步。', { exact: true })).toBeVisible()
    await expect(sync).toBeEnabled()
    readOnly(beforeConfirm)
    expect(await content()).toBeNull()
    await sync.click()
    await expect.poll(content).toBe(data.remote)
    server.assertNoHookErrors()
    complete = true
  } finally {
    await closeElectronApp(context, { preserveUserData: true })
    await server.close()
    if (complete) await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    else console.error('Retained isolated WebDAV V3 Electron profile:', directory)
  }
})
