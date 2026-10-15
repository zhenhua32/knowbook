import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { selectSource, sourceValue } from './helpers/markdown-source'

async function source(page: Page, name: string) {
  return page.evaluate(async name => {
    const database = await window.knowbook.createDocumentDatabase({ name, description: '' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const record = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: `${name} record`, fieldValues: { [field.id]: 'Original notes' } })
    return { databaseId: database.id, fieldId: field.id, recordId: record.id }
  }, name)
}
async function open(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
const saved = (page: Page, id: string) => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks, id)
async function seed(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks }); return id
  }, { title, blocks })
  await page.reload(); await open(page, title); return id
}
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true }).click()
}

test('source public database slash and picker preserve host identity through local history, fence editing and reload @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'markdown' })
  try {
    const { page } = context, target = await source(page, 'Source public database'), title = 'Source database insertion'
    const id = await seed(page, title, [{ id: 'source-host', type: 'paragraph', content: '', checked: false, depth: 0,
      parentBlockId: null, tags: ['source-host-tag'], highlight: 'blue' }])
    const textarea = page.locator('[data-block-id="source-host"] .block-inline-textarea')
    await textarea.click(); await textarea.pressSequentially('/database')
    const menu = page.locator('.floating-slash-command-panel')
    await expect(menu).toHaveAttribute('aria-busy', 'false')
    await expect(menu.locator('.slash-command-item-active .slash-command-id')).toHaveText('/database')
    await textarea.press('Enter')
    const picker = page.locator('dialog.database-view-picker')
    await expect(picker).toBeVisible()
    await picker.getByLabel(uiText('Source database', '数据库来源'), { exact: true }).selectOption(target.databaseId)
    await expect(picker.getByLabel(uiText('Source saved view', '来源保存视图'), { exact: true })).toBeVisible()
    await picker.getByRole('button', { name: uiText('Insert view', '插入视图'), exact: true }).click()
    await expect(picker).toHaveCount(0)
    const embed = page.locator('[data-block-id="source-host"] .inline-database-view')
    await expect(embed.getByLabel('Notes', { exact: true })).toHaveValue('Original notes')
    await expect.poll(async () => (await saved(page, id))[0].type).toBe('database-view')
    const inserted = await saved(page, id)
    expect(inserted).toHaveLength(1); expect(inserted[0]).toMatchObject({ id: 'source-host', tags: ['source-host-tag'], highlight: 'blue' })
    expect(JSON.parse(inserted[0].content).databaseId).toBe(target.databaseId)
    expect(inserted[0].content).not.toContain('Original notes')

    const query = embed.locator('.dbw-main-search input')
    await query.fill('record')
    await expect.poll(async () => JSON.parse((await saved(page, id))[0].content).config.query).toBe('record')
    await history(page, 'Undo'); await expect(query).toHaveValue('')
    await expect.poll(() => saved(page, id)).toEqual(inserted)
    await history(page, 'Redo'); await expect(query).toHaveValue('record')

    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const dialog = page.locator('.document-markdown-source'), editor = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
    const markdown = await sourceValue(editor)
    expect(markdown).toContain('```knowbook-database-view-v1'); expect(markdown).not.toContain('Original notes')
    const from = markdown.indexOf('"query":"record"')
    expect(from).toBeGreaterThan(0)
    await selectSource(editor, from, from + '"query":"record"'.length)
    await page.keyboard.insertText('"query":"source"')
    await dialog.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(dialog).toHaveCount(0); await expect(query).toHaveValue('source')
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => JSON.parse((await saved(page, id))[0].content).config.query).toBe('source')
    const beforeReload = await saved(page, id)
    expect(beforeReload[0]).toMatchObject({ id: 'source-host', tags: ['source-host-tag'], highlight: 'blue', parentBlockId: null })
    await page.reload(); await open(page, title)
    await expect(query).toHaveValue('source'); await expect(embed.getByLabel('Notes', { exact: true })).toHaveValue('Original notes')
    expect(await saved(page, id)).toEqual(beforeReload)
  } finally { await closeElectronApp(context) }
})

test('two source embeds keep drafts independent, share acknowledged cell updates and render live read-only views @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'markdown' })
  try {
    const { page } = context, target = await source(page, 'Shared live source'), title = 'Source shared database embeds'
    await page.setViewportSize({ width: 1440, height: 1250 })
    const content = serializeDatabaseViewPayload({ version: 1, databaseId: target.databaseId, viewId: null,
      config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, target.fieldId]) })
    const id = await seed(page, title, ['first-embed', 'second-embed'].map(id => ({ id, type: 'database-view', content,
      checked: false, depth: 0, parentBlockId: null })))
    const first = page.locator('[data-block-id="first-embed"] .inline-database-view')
    const second = page.locator('[data-block-id="second-embed"] .inline-database-view')
    const firstNotes = first.getByLabel('Notes', { exact: true }), secondNotes = second.getByLabel('Notes', { exact: true })
    await expect(firstNotes).toHaveValue('Original notes'); await expect(secondNotes).toHaveValue('Original notes')
    const before = await saved(page, id)
    await firstNotes.fill('Unsubmitted independent draft')
    await expect(secondNotes).toHaveValue('Original notes')
    expect(await page.evaluate(async target => (await window.knowbook.getDatabaseEntities(target.databaseId)).find(record => record.id === target.recordId)!.fieldValues[target.fieldId], target)).toBe('Original notes')
    await firstNotes.press('Enter')
    await expect(secondNotes).toHaveValue('Unsubmitted independent draft')
    await expect(firstNotes).not.toHaveAttribute('readonly')
    expect(await saved(page, id)).toEqual(before)
    await second.locator('.dbw-main-search input').fill('record')
    await expect(first.locator('.dbw-main-search input')).toHaveValue('')
    await expect.poll(async () => JSON.parse((await saved(page, id))[1].content).config.query).toBe('record')

    await page.locator('.document-view-toggle').click()
    const reading = page.locator('.inline-database-view')
    await expect(reading).toHaveCount(2)
    await expect(reading.locator('input[aria-label="Notes"]')).toHaveCount(0)
    await expect(reading.nth(0)).toContainText('Unsubmitted independent draft')
    await expect(reading.nth(1)).toContainText('Unsubmitted independent draft')
    await expect(reading.nth(0).locator('.dbw-view-tabs select')).toBeDisabled()
    await page.evaluate(async target => { await window.knowbook.updateDatabaseEntity({ entityId: target.recordId,
      fieldValues: { [target.fieldId]: 'Updated while reading' } }) }, target)
    await expect(reading.nth(0)).toContainText('Updated while reading')
    await expect(reading.nth(1)).toContainText('Updated while reading')
    const stored = await saved(page, id)
    await reading.nth(0).getByRole('button', { name: uiText('Enter editing mode', '进入编辑模式'), exact: true }).click()
    await expect(firstNotes).toHaveValue('Updated while reading'); await expect(secondNotes).toHaveValue('Updated while reading')
    expect(await saved(page, id)).toEqual(stored)
    await page.reload(); await open(page, title)
    await expect(firstNotes).toHaveValue('Updated while reading'); await expect(secondNotes).toHaveValue('Updated while reading')
  } finally { await closeElectronApp(context) }
})
