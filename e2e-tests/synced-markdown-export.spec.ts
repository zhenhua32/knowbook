import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { appendCanonicalText, expectCanonicalRow, inlineInstance, openInlineHost, withCanonicalInlineApp } from './helpers/canonical-inline'
import { ensureDocumentMetadataEditor, evaluateInFreshElectronMain, hasBuiltElectronApp, uiText } from './helpers/electron'

type ExportProbe = { copied: string; defaultPath: string; groupWrites: number; release: () => void }
type ProbeGlobals = typeof globalThis & { __knowbookMarkdownExport?: ExportProbe }
type Invoke = (event: IpcMainInvokeEvent, input: SyncedEditingRequest) => unknown

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before running this acceptance slice')

test('plain Markdown copy and export expand repeated saved and unsaved shared bodies @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async ({ seed, context }) => {
    const { app, page, tempRoot } = context()
    const [origin, other] = seed.hosts
    const path = join(tempRoot, 'expanded-shared-body.md')
    await evaluateInFreshElectronMain(app, ({ app, ipcMain, dialog }, { filePath, tempRoot }) => {
      if (process.env.KNOWBOOK_E2E_BACKGROUND !== '1' || app.getPath('userData') !== tempRoot) throw new Error('The isolated background profile is required')
      const channel = 'knowbook:invoke-synced-editing-session'
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers
      const invoke = handlers.get(channel)
      if (!invoke) throw new Error('The actual Main editing-session handler is required')
      let release!: () => void
      const saves = new Promise<void>(resolve => { release = resolve })
      const probe = { copied: '', defaultPath: '', groupWrites: 0, release }
      ;(globalThis as ProbeGlobals).__knowbookMarkdownExport = probe
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: SyncedEditingRequest) => {
        if (input.method === 'updateSyncedBlockGroup') {
          probe.groupWrites++
          await saves
        } else if (input.method === 'applySyncedHostStructure') {
          await saves
        }
        return invoke(event, input)
      })
      ipcMain.removeHandler('knowbook:write-clipboard-text')
      ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => { probe.copied = text })
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        probe.defaultPath = (args.at(-1) as { defaultPath: string }).defaultPath
        return { canceled: false, filePath }
      }) as typeof dialog.showSaveDialog
    }, { filePath: path, tempRoot })

    const copied = () => evaluateInFreshElectronMain(app, () => (globalThis as ProbeGlobals).__knowbookMarkdownExport!.copied)
    const copy = uiText('Copy MD', '复制 Markdown')
    const treeRow = page.locator('.tree-button', { hasText: origin.title }).first()
    const treeMenu = page.locator('.document-tree-context-menu')
    const occurrences = (body: string, text: string) => body.split(text).length - 1
    let passed = false
    try {
      await openInlineHost(page, other)
      await treeRow.click({ button: 'right' })
      await treeMenu.getByRole('button', { name: copy, exact: true }).click()
      await expect.poll(copied).toContain('# ' + origin.title)
      const savedCopy = await copied()
      expect(occurrences(savedCopy, seed.primaryText)).toBe(2)
      expect(savedCopy).not.toContain(seed.groupId)
      await expect(page.locator('.document-header-title')).toHaveText(other.title)

      await openInlineHost(page, origin)
      const title = 'Latest shared export title', hostText = 'Latest unsaved host text'
      await ensureDocumentMetadataEditor(page)
      await page.locator('.document-summary-card .editor-input').first().fill(title)
      const anchor = origin.blocks.find(block => block.type === 'paragraph')!
      await page.locator(`[data-block-id="${anchor.id}"] textarea`).fill(hostText)
      const suffix = ' with working draft', groupText = seed.primaryText + suffix
      await appendCanonicalText(page, seed.instanceIds[0], seed.primaryId, seed.primaryText, suffix)
      await expectCanonicalRow(inlineInstance(page, seed.instanceIds[1]), seed.primaryId, groupText)
      await expect.poll(() => evaluateInFreshElectronMain(app, () => (globalThis as ProbeGlobals).__knowbookMarkdownExport!.groupWrites)).toBeGreaterThan(0)

      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: copy, exact: true }).click()
      await expect.poll(copied).toContain('# ' + title)
      const workingCopy = await copied()
      expect(workingCopy).toContain(hostText)
      expect(occurrences(workingCopy, groupText)).toBe(2)
      expect(workingCopy).not.toContain(seed.groupId)

      await treeRow.click({ button: 'right' })
      await treeMenu.getByRole('button', { name: uiText('Save MD', '导出 Markdown'), exact: true }).click()
      await expect.poll(() => {
        try { return readFileSync(path, 'utf8') } catch { return '' }
      }).toBe(workingCopy)
      expect(basename(await evaluateInFreshElectronMain(app, () => (globalThis as ProbeGlobals).__knowbookMarkdownExport!.defaultPath))).toBe(title + '.md')
      await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.title, origin.id)).toBe(origin.title)
      const stored = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input),
        { hostDocumentId: origin.id, instanceId: seed.instanceIds[0], groupId: seed.groupId })
      expect(stored.status === 'ready' && stored.snapshot.blocks.find(block => block.id === seed.primaryId)?.content).toBe(seed.primaryText)
      passed = true
    } finally {
      await evaluateInFreshElectronMain(app, () => (globalThis as ProbeGlobals).__knowbookMarkdownExport!.release())
        .catch(error => { if (passed) throw error })
    }
  })
})
