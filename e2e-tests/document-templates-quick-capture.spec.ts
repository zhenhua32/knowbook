import { expect, test, type Page } from '@playwright/test'
import {
  closeElectronApp, ensureDocumentMetadataEditor, hasBuiltElectronApp,
  launchElectronApp, uiText, withElectronApp
} from './helpers/electron'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const templateDialogName = uiText('From template', '从模板新建')
const templateActionName = uiText('New from template', '从模板新建')
const captureDialogName = uiText('Quick capture', '快速记录')
const templateNameLabel = uiText('Template name', '模板名称')
const titleLabel = /^(?:Document title(?: \(optional\))?|文档标题(?:（可选）)?)$/i
const parentLabel = /Parent folder|父目录/i
const captureBodyLabel = /^(?:Content|正文)/i

async function createSample(page: Page, title: string) {
  return page.evaluate(async (title) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '已保存的摘要', blocks: [
      { id: `${id}-body`, type: 'paragraph', content: '已保存的正文', checked: false, depth: 0 }
    ] })
    return id
  }, title)
}

async function openTemplatePicker(page: Page) {
  await page.getByRole('button', { name: templateActionName, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: templateDialogName })
  await expect(dialog).toBeVisible()
  return dialog
}

async function findDocument(page: Page, title: string) {
  const catalog = await page.evaluate(() => window.knowbook.getDocumentCatalog())
  const document = catalog.find((entry) => entry.title === title)
  expect(document, `Persisted document "${title}"`).toBeDefined()
  return document!
}

async function runCommand(page: Page, name: RegExp) {
  await page.keyboard.press(`${mod}+Shift+p`)
  const palette = page.getByRole('dialog', { name: uiText('Search and commands', '搜索与命令') })
  await expect(palette.getByRole('combobox')).toHaveValue('>')
  await palette.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect(palette).toHaveCount(0)
}

test.describe('Document templates and quick capture @electron', () => {
  test.beforeEach(() => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  })

  test('creates a built-in meeting note under a selected parent and expands date variables', async ({}, testInfo) => {
    await withElectronApp(async ({ page }) => {
      const parentTitle = '模板父目录'
      const parentId = await createSample(page, parentTitle)
      await page.reload()
      const dialog = await openTemplatePicker(page)
      const meeting = dialog.getByRole('button', { name: /Meeting notes|会议纪要/ })
      await expect(meeting).toBeVisible()
      await meeting.click()
      await expect(meeting).toHaveAttribute('aria-pressed', 'true')
      await expect(dialog.getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true })).toHaveCount(0)
      await dialog.screenshot({ path: testInfo.outputPath('document-template-picker.png') })
      await dialog.getByLabel(titleLabel, { exact: true }).fill('迭代计划会议')
      await dialog.getByLabel(parentLabel, { exact: true }).selectOption(parentId)
      await dialog.getByRole('button', { name: uiText('Create document', '创建文档'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText('迭代计划会议')

      const created = await findDocument(page, '迭代计划会议')
      expect(created.parentId).toBe(parentId)
      expect(created.path).toBe(`${parentTitle}/迭代计划会议`)
      const detail = await page.evaluate((id) => window.knowbook.getDocumentDetail(id), created.id)
      expect(detail).not.toBeNull()
      const content = detail!.blocks.map((block) => block.content).join('\n')
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(content).not.toContain('{{date}}')
      expect(content).not.toContain('{{title}}')
      expect(detail!.blocks.length).toBeGreaterThan(1)

      await page.reload()
      expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), created.id))?.blocks).toEqual(detail!.blocks)
    })
  })

  test('saves the latest unsaved draft as a template and creates independent persistent copies', async () => {
    test.setTimeout(120_000)
    let context = await launchElectronApp()
    try {
      let { page } = context
      const sourceTitle = '模板来源文档'
      const sourceId = await createSample(page, sourceTitle)
      await page.reload()
      await page.locator('.tree-button', { hasText: sourceTitle }).first().click()
      // Fail automatic saves so a template cannot accidentally pass by reading persisted content.
      await context.app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('knowbook:update-document')
        ipcMain.handle('knowbook:update-document', () => { throw new Error('Template draft save blocked') })
      })
      await ensureDocumentMetadataEditor(page)
      await page.locator('.document-summary-card .editor-input').first().fill('尚未保存的模板标题')
      await page.locator('.document-summary-card .editor-textarea').first().fill('尚未保存的模板摘要')
      await page.locator(`[data-block-id="${sourceId}-body"] textarea`).fill('草稿正文 {{title}}，记录日期 {{date}}')
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true }).click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save as template', '保存为模板'), exact: true }).click()
      const saveDialog = page.getByRole('dialog', { name: uiText('Save as template', '保存为模板') })
      await saveDialog.getByLabel(templateNameLabel, { exact: true }).fill('我的草稿模板')
      await saveDialog.getByRole('button', { name: uiText('Save template', '保存模板'), exact: true }).click()
      await expect(saveDialog).toHaveCount(0)
      expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), sourceId))?.title).toBe(sourceTitle)

      const { tempRoot } = context
      await closeElectronApp(context, { preserveUserData: true })
      context = await launchElectronApp({}, { userDataRoot: tempRoot })
      page = context.page
      const copies = []
      for (const title of ['草稿模板副本 A', '草稿模板副本 B']) {
        const dialog = await openTemplatePicker(page)
        await dialog.getByRole('button', { name: /我的草稿模板/ }).click()
        await dialog.getByLabel(titleLabel, { exact: true }).fill(title)
        await dialog.getByLabel(parentLabel, { exact: true }).selectOption('')
        await dialog.getByRole('button', { name: uiText('Create document', '创建文档'), exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.locator('.document-header-title')).toHaveText(title)
        const document = await findDocument(page, title)
        const detail = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), document.id))!
        expect(detail.summary).toBe('尚未保存的模板摘要')
        expect(detail.blocks[0].content).toContain(`草稿正文 ${title}`)
        expect(detail.blocks[0].content).toMatch(/记录日期 \d{4}-\d{2}-\d{2}/)
        expect(detail.blocks[0].id).not.toBe(`${sourceId}-body`)
        copies.push(detail)
      }
      expect(copies[0].id).not.toBe(copies[1].id)
      expect(copies[0].blocks[0].id).not.toBe(copies[1].blocks[0].id)
      await page.evaluate(async (copy) => {
        await window.knowbook.updateDocument(copy.id, { title: copy.title, summary: copy.summary,
          blocks: copy.blocks.map((block) => ({ ...block, content: '只修改第一份副本' })) })
      }, copies[0])
      const unchanged = await page.evaluate(async ({ sourceId, copyId }) => ({
        source: await window.knowbook.getDocumentDetail(sourceId),
        copy: await window.knowbook.getDocumentDetail(copyId)
      }), { sourceId, copyId: copies[1].id })
      expect(unchanged.source?.title).toBe(sourceTitle)
      expect(unchanged.source?.blocks[0].content).toBe('已保存的正文')
      expect(unchanged.copy?.blocks[0].content).toBe(copies[1].blocks[0].content)

      const dialog = await openTemplatePicker(page)
      await dialog.getByRole('button', { name: /我的草稿模板/ }).click()
      await dialog.getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: uiText('Delete template', '删除模板'), exact: true }).click()
      await expect(dialog.getByRole('button', { name: /我的草稿模板/ })).toHaveCount(0)
      const templates = await page.evaluate(() => window.knowbook.listDocumentTemplates())
      expect(templates.some((template) => template.name === '我的草稿模板')).toBe(false)
      expect(templates.filter((template) => template.builtIn)).toHaveLength(3)
      expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), copies[1].id))?.blocks[0].content).toBe(copies[1].blocks[0].content)
    } finally {
      await closeElectronApp(context)
    }
  })

  test('quick capture cancels without creating a document and saves Markdown through the keyboard', async ({}, testInfo) => {
    test.setTimeout(120_000)
    let context = await launchElectronApp()
    try {
      let { page } = context
      const count = await page.evaluate(async () => (await window.knowbook.getDocumentCatalog()).length)
      await page.getByRole('button', { name: uiText('Collapse sidebar', '收起左侧栏'), exact: true }).click()
      const rail = page.locator('.brand-mini')
      await expect(rail.getByRole('button', { name: templateActionName, exact: true })).toBeVisible()
      await expect(rail.getByRole('button', { name: captureDialogName, exact: true })).toBeVisible()
      await rail.getByRole('button', { name: templateActionName, exact: true }).click()
      const picker = page.getByRole('dialog', { name: templateDialogName })
      await expect(picker).toBeVisible()
      await picker.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(picker).toHaveCount(0)
      await rail.getByRole('button', { name: captureDialogName, exact: true }).click()
      let dialog = page.getByRole('dialog', { name: captureDialogName })
      await expect(dialog.getByRole('button', { name: uiText('Save note', '保存记录'), exact: true })).toBeDisabled()
      await dialog.getByLabel(captureBodyLabel).fill('这条记录被取消')
      await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      expect(await page.evaluate(async () => (await window.knowbook.getDocumentCatalog()).length)).toBe(count)

      await page.getByRole('button', { name: uiText('Expand sidebar', '展开左侧栏'), exact: true }).click()
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.keyboard.press(`${mod}+Shift+n`)
      dialog = page.getByRole('dialog', { name: captureDialogName })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel(titleLabel, { exact: true }).fill('快速捕获想法')
      const body = dialog.getByLabel(captureBodyLabel)
      const markdown = '# 灵感\n\n立即保存的正文\n\n- [ ] 下一步行动'
      await body.fill(markdown)
      await dialog.screenshot({ path: testInfo.outputPath('quick-capture-filled.png') })
      await body.dispatchEvent('compositionstart', { data: '中文候选' })
      await body.dispatchEvent('keydown', { key: 'Enter', ctrlKey: mod === 'Control', metaKey: mod === 'Meta', isComposing: true })
      await expect(dialog).toBeVisible()
      expect(await page.evaluate(async () => (await window.knowbook.getDocumentCatalog()).length)).toBe(count)
      await body.dispatchEvent('compositionend', { data: '中文候选' })

      // A real validation failure keeps both fields intact and does not leave a partial document.
      await dialog.getByLabel(titleLabel, { exact: true }).fill('无效/标题')
      await body.press(`${mod}+Enter`)
      await expect(dialog.getByRole('alert')).toContainText(/path separators|路径/)
      await expect(dialog.getByLabel(titleLabel, { exact: true })).toHaveValue('无效/标题')
      await expect(body).toHaveValue(markdown)
      expect(await page.evaluate(async () => (await window.knowbook.getDocumentCatalog()).length)).toBe(count)
      await dialog.getByLabel(titleLabel, { exact: true }).fill('快速捕获想法')
      await body.press(`${mod}+Enter`)
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText('快速捕获想法')
      const created = await findDocument(page, '快速捕获想法')
      expect(created.parentId).toBeNull()
      const detail = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), created.id))!
      expect(detail.blocks.some((block) => block.type === 'heading-1' && block.content === '灵感')).toBe(true)
      expect(detail.blocks.some((block) => block.type === 'paragraph' && block.content === '立即保存的正文')).toBe(true)
      expect(detail.blocks.some((block) => block.type === 'todo' && block.content === '下一步行动' && !block.checked)).toBe(true)
      expect(await page.evaluate(async () => (await window.knowbook.getDocumentCatalog()).length)).toBe(count + 1)

      const { tempRoot } = context
      await closeElectronApp(context, { preserveUserData: true })
      context = await launchElectronApp({}, { userDataRoot: tempRoot })
      page = context.page
      expect((await page.evaluate((id) => window.knowbook.getDocumentDetail(id), created.id))?.blocks).toEqual(detail.blocks)
    } finally {
      await closeElectronApp(context)
    }
  })

  test('the command palette exposes all three creation actions', async () => {
    await withElectronApp(async ({ page }) => {
      const sourceTitle = '命令面板模板来源'
      await createSample(page, sourceTitle)
      await page.reload()
      await page.locator('.tree-button', { hasText: sourceTitle }).first().click()
      for (const [commandName, dialogName] of [
        [templateActionName, templateDialogName],
        [captureDialogName, captureDialogName],
        [uiText('Save as template', '保存为模板'), uiText('Save as template', '保存为模板')]
      ]) {
        await runCommand(page, commandName)
        const dialog = page.getByRole('dialog', { name: dialogName })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
        await expect(dialog).toHaveCount(0)
      }
    })
  })
})
