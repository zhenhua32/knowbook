import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import {
  closeElectronApp,
  ensureDocumentMetadataEditor,
  hasBuiltElectronApp,
  launchElectronApp,
  uiText,
  withElectronApp,
  type ElectronAppContext
} from './helpers/electron'

const results = (page: Page) => page.getByTestId('workspace-search-result')
const field = (page: Page, en: string, zh: string) => page.getByLabel(uiText(en, zh), { exact: true })

async function openSearchPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
  await expect(field(page, 'Keywords', '关键词')).toBeVisible()
}

async function openSavedSearchControls(page: Page): Promise<void> {
  await page.locator('.workspace-search-page summary').filter({
    hasText: uiText('Save and load searches', '保存与加载检索')
  }).click()
  await expect(field(page, 'Search name', '检索名称')).toBeVisible()
}

async function searchCount(page: Page, total: number, visible = Math.min(total, 25)): Promise<void> {
  await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', String(total))
  await expect(results(page)).toHaveCount(visible)
  await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
}

async function resultKeys(page: Page): Promise<string[]> {
  return results(page).evaluateAll(elements => elements.map(element => {
    const row = element as HTMLElement
    return `${row.dataset.documentId}:${row.dataset.blockId ?? ''}`
  }))
}

async function setFixtureDates(app: ElectronApplication, ids: string[]): Promise<void> {
  await app.evaluate(({ app }, ids) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { join } = process.getBuiltinModule('node:path')
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'))
    try {
      const update = database.prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
      database.transaction(() => ids.forEach((id, index) => {
        update.run(`2025-01-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`, id)
      }))()
    } finally {
      database.close()
    }
  }, ids)
}

async function checkNarrowDarkLayout(context: ElectronAppContext): Promise<void> {
  const { page, app } = context
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const theme = await page.evaluate(() => window.knowbook.getSetting('appearance.theme'))
  const applyTheme = async (value: string) => {
    await page.evaluate(value => window.knowbook.saveSetting('appearance.theme', value), value)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:workspace-mutated')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', value)
  }
  try {
    await applyTheme('dark')
    for (const width of [800, 640]) {
      await page.setViewportSize({ width, height: 700 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    }
    await searchCount(page, 93)
    await page.screenshot({ path: 'test-results/workspace-search-dark-narrow.png', fullPage: true })
  } finally {
    await page.setViewportSize(viewport)
    await applyTheme(theme === 'dark' ? 'dark' : 'light')
  }
}

async function seedPagedDocuments(context: ElectronAppContext) {
  const fixture = await context.page.evaluate(async () => {
    const createFolder = async (title: string, parentId: string | null) => {
      const { id } = await window.knowbook.createDocument(parentId)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [] })
      return id
    }
    const collection = await createFolder('Search collection', null)
    const nested = await createFolder('Nested collection', collection)
    const other = await createFolder('Other collection', null)
    const documents: string[] = []
    for (let index = 0; index < 31; index++) {
      const { id } = await window.knowbook.createDocument(index < 28 ? nested : other)
      await window.knowbook.updateDocument(id, {
        title: `Atlas entry ${String(index).padStart(2, '0')}`,
        summary: '',
        blocks: [
          { id: `${id}-body`, type: 'paragraph', content: `atlas alpha beta unique-body-${index}`,
            tags: [index % 2 === 0 ? 'research' : 'backlog'], checked: false, depth: 0 },
          { id: `${id}-task`, type: 'todo', content: `atlas follow-up unique-task-${index}`,
            tags: ['follow-up'], checked: false, depth: 0 }
        ]
      })
      documents.push(id)
    }
    return { collection, nested, documents }
  })
  await setFixtureDates(context.app, fixture.documents)
  await context.page.reload()
  return fixture
}

async function seedModeDocuments(context: ElectronAppContext): Promise<string[]> {
  const ids = await context.page.evaluate(async () => {
    const contents = ['amber bridge', 'amber solo', 'bridge solo', 'bridge amber']
    const ids: string[] = []
    for (let index = 0; index < contents.length; index++) {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, {
        title: `Mode note ${index}`, summary: '',
        blocks: [{ id: `${id}-body`, type: 'paragraph', content: contents[index],
          tags: ['research'], checked: false, depth: 0 }]
      })
      ids.push(id)
    }
    return ids
  })
  await setFixtureDates(context.app, ids)
  await context.page.reload()
  return ids
}

test.describe('Complete workspace search @electron', () => {
  test.beforeEach(() => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  })

  test('pages every document and block without omissions, then combines folder, tag, type and date filters', async () => {
    test.setTimeout(120_000)
    await withElectronApp(async context => {
      const { page } = context
      const fixture = await seedPagedDocuments(context)
      await openSearchPage(page)
      await field(page, 'Keywords', '关键词').fill('atlas')
      await field(page, 'Sort', '排序').selectOption('updated-asc')
      await searchCount(page, 93)
      await page.screenshot({ path: 'test-results/workspace-search.png', fullPage: true })
      await checkNarrowDarkLayout(context)

      const keys: string[] = []
      for (let number = 1; number <= 3; number++) {
        const current = await resultKeys(page)
        keys.push(...current)
        const next = page.getByRole('button', { name: uiText('Next page', '下一页'), exact: true })
        await expect(next).toBeEnabled()
        await next.click()
        await expect.poll(async () => (await resultKeys(page))[0]).not.toBe(current[0])
        await searchCount(page, 93, number === 3 ? 18 : 25)
      }
      keys.push(...await resultKeys(page))
      const expected = fixture.documents.flatMap(id => [`${id}:`, `${id}:${id}-body`, `${id}:${id}-task`])
      expect(keys).toHaveLength(93)
      expect(new Set(keys).size).toBe(93)
      expect([...keys].sort()).toEqual(expected.sort())
      await expect(page.getByRole('button', { name: uiText('Next page', '下一页'), exact: true })).toBeDisabled()

      const lastPageKeys = await resultKeys(page)
      await page.locator(`[data-testid="workspace-search-result"][data-block-id="${fixture.documents[30]}-body"]`)
        .getByRole('button', { name: uiText('Go to block', '定位内容块'), exact: true }).click()
      await expect(page.locator('.document-header-title')).toHaveText('Atlas entry 30')
      await openSearchPage(page)
      await expect(field(page, 'Keywords', '关键词')).toHaveValue('atlas')
      await expect(field(page, 'Sort', '排序')).toHaveValue('updated-asc')
      await searchCount(page, 93, 18)
      expect(await resultKeys(page)).toEqual(lastPageKeys)

      await field(page, 'Search scope', '搜索范围').selectOption('documents')
      await searchCount(page, 31)
      await expect(results(page).first()).toHaveAttribute('data-document-id', fixture.documents[0])
      await field(page, 'Sort', '排序').selectOption('updated-desc')
      await expect(results(page).first()).toHaveAttribute('data-document-id', fixture.documents[30])
      await field(page, 'Search scope', '搜索范围').selectOption('blocks')
      await searchCount(page, 62)

      // Selecting the parent includes the nested directory, while excluding its sibling.
      await field(page, 'Folder', '目录').selectOption(fixture.collection)
      await field(page, 'Tag', '标签').selectOption('research')
      await field(page, 'Block type', '内容类型').selectOption('paragraph')
      await field(page, 'Updated from', '更新开始日期').fill('2025-01-10')
      await field(page, 'Updated to', '更新结束日期').fill('2025-01-20')
      await searchCount(page, 5)
      expect((await resultKeys(page)).sort()).toEqual([10, 12, 14, 16, 18]
        .map(index => `${fixture.documents[index]}:${fixture.documents[index]}-body`).sort())
      await page.getByRole('button', { name: uiText('Clear filters', '清空筛选'), exact: true }).click()
      await expect(field(page, 'Folder', '目录')).toHaveValue('')
      await expect(field(page, 'Tag', '标签')).toHaveValue('')
      await expect(field(page, 'Updated from', '更新开始日期')).toHaveValue('')
    })
  })

  test('distinguishes all, any and phrase matching and opens the exact matching block', async () => {
    await withElectronApp(async context => {
      const { page } = context
      const ids = await seedModeDocuments(context)
      await page.keyboard.press('Control+Shift+f')
      await expect(field(page, 'Keywords', '关键词')).toBeFocused()
      await field(page, 'Search scope', '搜索范围').selectOption('blocks')
      await field(page, 'Keywords', '关键词').fill('amber bridge')
      await searchCount(page, 2)
      expect((await resultKeys(page)).sort()).toEqual([0, 3].map(index => `${ids[index]}:${ids[index]}-body`).sort())
      await field(page, 'Match mode', '匹配方式').selectOption('phrase')
      await searchCount(page, 1)
      await expect(results(page).first()).toHaveAttribute('data-block-id', `${ids[0]}-body`)
      await field(page, 'Match mode', '匹配方式').selectOption('any')
      await field(page, 'Sort', '排序').selectOption('updated-desc')
      await searchCount(page, 4)
      await expect(results(page).first()).toHaveAttribute('data-block-id', `${ids[3]}-body`)
      await results(page).first().getByRole('button', { name: uiText('Go to block', '定位内容块'), exact: true }).click()
      await expect(page.locator('.document-header-title')).toHaveText('Mode note 3')
      const block = page.locator(`.preview-panel [data-block-id="${ids[3]}-body"]`)
      await expect(block).toBeInViewport()
      await expect(block).toHaveClass(/block-editor-row-highlighted/)
    })
  })

  test('saves and updates a search, restores its conditions after restart and deletes it', async () => {
    test.setTimeout(120_000)
    let context: ElectronAppContext | null = await launchElectronApp()
    try {
      await seedModeDocuments(context)
      let page = context.page
      await openSearchPage(page)
      await field(page, 'Search scope', '搜索范围').selectOption('blocks')
      await field(page, 'Keywords', '关键词').fill('amber bridge')
      await field(page, 'Match mode', '匹配方式').selectOption('any')
      await field(page, 'Tag', '标签').selectOption('research')
      await searchCount(page, 4)
      await openSavedSearchControls(page)
      await field(page, 'Search name', '检索名称').fill('Research at dawn')
      await page.getByRole('button', { name: uiText('Save search', '保存检索'), exact: true }).click()
      await expect.poll(async () => (await page.evaluate(() => window.knowbook.listSavedSearches()))
        .some(item => item.name === 'Research at dawn')).toBe(true)
      const saved = (await page.evaluate(() => window.knowbook.listSavedSearches())).find(item => item.name === 'Research at dawn')!
      await field(page, 'Saved searches', '已保存检索').selectOption(saved.id)
      await field(page, 'Sort', '排序').selectOption('updated-asc')
      await field(page, 'Search name', '检索名称').fill('Research in order')
      await page.getByRole('button', { name: uiText('Update search', '更新检索'), exact: true }).click()
      await expect.poll(async () => (await page.evaluate(() => window.knowbook.listSavedSearches()))
        .find(item => item.id === saved.id)?.name).toBe('Research in order')

      const tempRoot = context.tempRoot
      await closeElectronApp(context, { preserveUserData: true })
      context = null
      context = await launchElectronApp({}, { userDataRoot: tempRoot })
      page = context.page
      await openSearchPage(page)
      await openSavedSearchControls(page)
      await expect(field(page, 'Saved searches', '已保存检索').locator('option', { hasText: 'Research in order' })).toHaveCount(1)
      await field(page, 'Keywords', '关键词').fill('no-match-example')
      await field(page, 'Saved searches', '已保存检索').selectOption(saved.id)
      await page.getByRole('button', { name: uiText('Load search', '加载检索'), exact: true }).click()
      await expect(field(page, 'Keywords', '关键词')).toHaveValue('amber bridge')
      await expect(field(page, 'Match mode', '匹配方式')).toHaveValue('any')
      await expect(field(page, 'Search scope', '搜索范围')).toHaveValue('blocks')
      await expect(field(page, 'Tag', '标签')).toHaveValue('research')
      await expect(field(page, 'Sort', '排序')).toHaveValue('updated-asc')
      await searchCount(page, 4)
      await page.getByRole('button', { name: uiText('Delete search', '删除检索'), exact: true }).click()
      await expect(field(page, 'Saved searches', '已保存检索').locator('option', { hasText: 'Research in order' })).toHaveCount(0)
      expect((await page.evaluate(() => window.knowbook.listSavedSearches())).some(item => item.id === saved.id)).toBe(false)
    } finally {
      await closeElectronApp(context)
    }
  })

  test('opens the full results from Ctrl+K and preserves a failed document draft when a result cannot open', async () => {
    await withElectronApp(async context => {
      const { page, app } = context
      const ids = await seedModeDocuments(context)
      await page.keyboard.press('Control+k')
      await page.locator('.global-search-input').fill('amber')
      await expect(page.locator('.global-search-result')).toHaveCount(3)
      await page.getByRole('button', { name: uiText('View all results', '查看全部结果'), exact: true }).click()
      await expect(page.locator('.global-search-modal')).toHaveCount(0)
      await expect(field(page, 'Keywords', '关键词')).toHaveValue('amber')
      await searchCount(page, 3)

      await results(page).filter({ has: page.locator('h4', { hasText: 'Mode note 0' }) })
        .getByRole('button', { name: uiText('Open document', '打开文档'), exact: true }).click()
      await expect(page.locator('.document-header-title')).toHaveText('Mode note 0')
      await app.evaluate(({ ipcMain }) => {
        process.env.KNOWBOOK_WORKSPACE_SEARCH_SAVE_ATTEMPTS = '0'
        ipcMain.removeHandler('knowbook:update-document')
        ipcMain.handle('knowbook:update-document', () => {
          process.env.KNOWBOOK_WORKSPACE_SEARCH_SAVE_ATTEMPTS = String(Number(process.env.KNOWBOOK_WORKSPACE_SEARCH_SAVE_ATTEMPTS) + 1)
          throw new Error('Workspace search draft save blocked')
        })
      })
      await ensureDocumentMetadataEditor(page)
      await page.locator('.document-summary-card .editor-input').first().fill('Preserve this full search draft')
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await openSearchPage(page)
      await field(page, 'Keywords', '关键词').fill('bridge solo')
      await searchCount(page, 1)
      const target = results(page).filter({ has: page.locator('h4', { hasText: 'Mode note 2' }) })
      await target.getByRole('button', { name: uiText('Go to block', '定位内容块'), exact: true }).click()
      await expect(field(page, 'Keywords', '关键词')).toHaveValue('bridge solo')
      await expect(page.locator('.app-notifications')).toContainText('Workspace search draft save blocked')
      const firstAttempts = await app.evaluate(() => Number(process.env.KNOWBOOK_WORKSPACE_SEARCH_SAVE_ATTEMPTS))
      await target.getByRole('button', { name: uiText('Go to block', '定位内容块'), exact: true }).click()
      await expect.poll(() => app.evaluate(() => Number(process.env.KNOWBOOK_WORKSPACE_SEARCH_SAVE_ATTEMPTS))).toBeGreaterThan(firstAttempts)
      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      await ensureDocumentMetadataEditor(page)
      await expect(page.locator('.document-summary-card .editor-input').first()).toHaveValue('Preserve this full search draft')
      const current = await page.evaluate(id => window.knowbook.getDocumentDetail(id), ids[0])
      expect(current?.title).toBe('Mode note 0')
    })
  })
})
