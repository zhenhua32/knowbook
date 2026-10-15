import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { setRichTextDomSelection } from './helpers/rich-text-selection'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
const editor = (page: Page) => page.locator('.knowbook-rich-text-editor')
const atom = (page: Page, id: string) => editor(page).locator(`.rich-database-view[data-block-id="${id}"]`)
async function source(page: Page, name: string) {
  return page.evaluate(async name => {
    const database = await window.knowbook.createDocumentDatabase({ name, description: '' })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    const record = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: `${name} record`, fieldValues: { [field.id]: 'Original notes' } })
    return { databaseId: database.id, fieldId: field.id, recordId: record.id }
  }, name)
}
function databaseBlock(id: string, target: Awaited<ReturnType<typeof source>>): DocumentBlockDraft {
  return { ...paragraph(id, serializeDatabaseViewPayload({ version: 1, databaseId: target.databaseId, viewId: null,
    config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, target.fieldId]) })), type: 'database-view' }
}
async function open(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function seed(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks }); return id
  }, { title, blocks })
  await page.reload(); await open(page, title)
  return id
}
const saved = (page: Page, id: string) => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks, id)
const notes = (page: Page, target: Awaited<ReturnType<typeof source>>) => page.evaluate(async target => {
  const row = (await window.knowbook.getDatabaseEntities(target.databaseId)).find(row => row.id === target.recordId)!
  return row.fieldValues[target.fieldId]
}, target)

test('nested rich database portals keep real field IME writes independent of host Delete, Undo and reload @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context
    await page.setViewportSize({ width: 1500, height: 1100 })
    const first = await source(page, 'Inline left'), second = await source(page, 'Inline right'), title = 'Rich live database columns'
    const blocks: DocumentBlockDraft[] = [
      { ...paragraph('group', ''), type: 'columns' },
      { ...paragraph('left', ''), type: 'column', depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 5000 } },
      { ...databaseBlock('left-database', first), depth: 2, parentBlockId: 'left' },
      { ...paragraph('right', ''), type: 'column', depth: 1, parentBlockId: 'group', markdownFormat: { columnWeight: 5000 } },
      { ...databaseBlock('right-database', second), depth: 2, parentBlockId: 'right' },
      paragraph('tail', 'Host text remains independent')
    ]
    const id = await seed(page, title, blocks), before = await saved(page, id)
    await expect(editor(page)).toHaveCount(1)
    await expect(atom(page, 'left-database').locator('.dbw-shell')).toBeVisible()
    await expect(atom(page, 'right-database').locator('.dbw-shell')).toBeVisible()
    const field = atom(page, 'left-database').getByLabel('Notes', { exact: true })
    await field.fill(''); await field.focus()
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Input.imeSetComposition', { text: '数据库中文😀', selectionStart: 7, selectionEnd: 7 })
      await expect(field).toHaveValue('数据库中文😀')
      await cdp.send('Input.insertText', { text: '数据库中文😀' })
    } finally { await cdp.detach() }
    await field.press('Enter')
    await expect.poll(() => notes(page, first)).toBe('数据库中文😀')
    await expect(field).not.toHaveAttribute('readonly')
    expect(await notes(page, second)).toBe('Original notes')
    expect(await saved(page, id)).toEqual(before)

    // Native database history and document shortcuts cannot operate the host.
    await field.focus(); await field.press('Control+z'); await field.press('Control+y')
    expect(await saved(page, id)).toEqual(before)
    await atom(page, 'left-database').getByRole('button', { name: uiText('Select database view block', '选择数据库视图块'), exact: true }).click()
    await editor(page).press('Delete')
    await expect(atom(page, 'left-database')).toHaveCount(0)
    await expect.poll(async () => (await saved(page, id)).some(block => block.id === 'left-database')).toBe(false)
    expect(await notes(page, first)).toBe('数据库中文😀')
    await editor(page).press('Control+z')
    await expect(atom(page, 'left-database').locator('.dbw-shell')).toBeVisible()
    await expect.poll(() => saved(page, id)).toEqual(before)
    await expect(atom(page, 'left-database')).toHaveClass(/ProseMirror-selectednode/)
    await expect(atom(page, 'left-database').getByLabel('Notes', { exact: true })).toHaveValue('数据库中文😀')
    await page.locator('.document-header-save-button').click()
    await page.reload(); await open(page, title)
    await expect(atom(page, 'left-database').getByLabel('Notes', { exact: true })).toHaveValue('数据库中文😀')
    expect(await saved(page, id)).toEqual(before)
  } finally { await closeElectronApp(context) }
})

test('whole rich database atom copy, cut and paste retain its real source and create one independent host identity @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page, app } = context, target = await source(page, 'Clipboard source'), title = 'Rich finite database clipboard'
    const id = await seed(page, title, [paragraph('before', 'Before'), databaseBlock('original-embed', target), paragraph('after', 'After')])
    await expect(atom(page, 'original-embed').locator('.dbw-shell')).toBeVisible()
    await atom(page, 'original-embed').getByRole('button', { name: uiText('Select database view block', '选择数据库视图块'), exact: true }).click()
    await editor(page).press('Control+c')
    const clipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    expect(clipboard.text).toContain('```knowbook-database-view-v1')
    expect(clipboard.text).toContain(target.databaseId)
    expect(clipboard.text).not.toContain('Original notes')
    expect(clipboard.html).toContain('data-knowbook-markdown-source="true"')
    await editor(page).press('Control+x')
    await expect(atom(page, 'original-embed')).toHaveCount(0)
    await expect.poll(async () => (await saved(page, id)).some(block => block.id === 'original-embed')).toBe(false)
    await editor(page).evaluate(setRichTextDomSelection, { from: { blockId: 'after', offset: 5 } })
    await editor(page).press('Control+v')
    await expect(editor(page).locator('.rich-database-view .dbw-shell')).toHaveCount(1)
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'database-view').length).toBe(1)
    await expect.poll(async () => {
      const atoms = (await saved(page, id)).filter(block => block.type === 'database-view')
      return atoms.length === 1 && atoms[0].id !== 'original-embed' && JSON.parse(atoms[0].content).databaseId === target.databaseId
    }).toBe(true)
    const stored = await saved(page, id), pasted = stored.find(block => block.type === 'database-view')!
    expect(pasted.id).not.toBe('original-embed')
    expect(JSON.parse(pasted.content).databaseId).toBe(target.databaseId)
    expect(stored.filter(block => block.type !== 'database-view').map(block => [block.id, block.content])).toEqual([['before', 'Before'], ['after', 'After']])
    expect(await notes(page, target)).toBe('Original notes')
    await page.locator('.document-header-save-button').click()
    await page.reload(); await open(page, title)
    await expect(atom(page, pasted.id).locator('.dbw-shell')).toBeVisible()
    expect(await saved(page, id)).toEqual(stored)
  } finally { await closeElectronApp(context) }
})

test('rich public picker inserts a real database into its empty linked host with one undo and redo @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, target = await source(page, 'Public picker source'), title = 'Rich database picker insertion'
    const id = await seed(page, title, [{ ...paragraph('linked-host', ''), tags: ['keep'], highlight: 'yellow' }])
    const before = await saved(page, id)
    await editor(page).evaluate(setRichTextDomSelection, { from: { blockId: 'linked-host', offset: 0 } })
    const insert = page.locator('.rich-text-toolbar').getByRole('button', { name: uiText('Insert database view', '插入数据库视图'), exact: true })
    await insert.click()
    let picker = page.locator('dialog.database-view-picker')
    await expect(picker).toBeVisible()
    await picker.getByLabel(uiText('Source database', '数据库来源'), { exact: true }).selectOption(target.databaseId)
    await expect(picker.getByLabel(uiText('Source saved view', '来源保存视图'), { exact: true })).toBeVisible()
    await picker.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    expect(await saved(page, id)).toEqual(before)
    await insert.click(); picker = page.locator('dialog.database-view-picker')
    await picker.getByLabel(uiText('Source database', '数据库来源'), { exact: true }).selectOption(target.databaseId)
    await picker.getByRole('button', { name: uiText('Insert view', '插入视图'), exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expect(atom(page, 'linked-host').locator('.dbw-shell')).toBeVisible()
    await expect(editor(page)).toBeFocused()
    await expect.poll(async () => (await saved(page, id))[0].type).toBe('database-view')
    const inserted = await saved(page, id)
    expect(inserted).toHaveLength(1); expect(inserted[0].id).toBe('linked-host')
    expect(inserted[0].tags).toEqual(['keep']); expect(inserted[0].highlight).toBe('yellow')
    expect(JSON.parse(inserted[0].content).databaseId).toBe(target.databaseId)
    await editor(page).press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(before)
    await editor(page).press('Control+y')
    await expect.poll(() => saved(page, id)).toEqual(inserted)
    await expect(atom(page, 'linked-host')).toHaveClass(/ProseMirror-selectednode/)
    await page.reload(); await open(page, title)
    await expect(atom(page, 'linked-host').locator('.dbw-shell')).toBeVisible()
    expect(await saved(page, id)).toEqual(inserted)
  } finally { await closeElectronApp(context) }
})
