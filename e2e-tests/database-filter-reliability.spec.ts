import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

async function openDatabase(page: Page) {
  await page.getByTitle('数据库', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText('筛选体验')
}

async function seedDatabase(page: Page, empty = false) {
  const fixture = await page.evaluate(async empty => {
    const database = await window.knowbook.createDocumentDatabase({ name: '筛选体验' })
    const create = (name: string, type: 'text' | 'select' | 'multi-select' | 'date' | 'checkbox', options: string[] = []) =>
      window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name, type, options })
    const owner = await create('Owner', 'text')
    const status = await create('Status', 'select', ['Todo', 'Done'])
    const tags = await create('Tags', 'multi-select', ['UI', 'Core', 'Core, platform', '知识管理与编辑体验改进'.repeat(4)])
    const due = await create('Due', 'date')
    const done = await create('Done', 'checkbox')
    if (!empty) {
      const rows = [
        { title: 'Alpha', status: 'Todo', tags: ['UI', 'Core, platform'], due: '2026-10-01', done: true },
        { title: 'Beta', status: 'Done', tags: ['Core'], due: '2026-10-02', done: false },
        { title: 'Gamma', status: 'Todo', tags: ['UI'], due: '2026-09-30', done: true },
        { title: 'Empty', status: null, tags: [], due: null, done: false }
      ]
      for (const row of rows) await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: row.title,
        fieldValues: { [owner.id]: 'Original owner', [status.id]: row.status, [tags.id]: row.tags, [due.id]: row.due, [done.id]: row.done } })
    }
    const visible = ['__title__', status.id, tags.id, due.id, done.id, owner.id]
    const config = { version: 1 as const, layout: 'table' as const, query: '', filters: { operator: 'and' as const, rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'desc' as const }], groupBy: { fieldId: status.id },
      visibleFieldIds: visible, fieldOrder: [...visible, '__created_at__', '__updated_at__', '__document__'],
      columnWidths: { __title__: 280, [owner.id]: 190 }, cardFieldIds: [status.id, tags.id] }
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: '筛选视图', config })
    await window.knowbook.saveSetting('ui.language', 'zh-CN')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    const first = (await window.knowbook.getDatabaseEntities(database.id))[0]
    const date = first ? new Date(first.createdAt) : new Date()
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return { databaseId: database.id, viewId: view.id, owner: owner.id, status: status.id, tags: tags.id, due: due.id, done: done.id, config, today }
  }, empty)
  await page.reload()
  await openDatabase(page)
  return fixture
}

const titles = (page: Page) => page.locator('.dbw-table .dbw-record-title strong')
const filterRow = (page: Page) => page.getByRole('group', { name: '筛选 1', exact: true })
async function addFilter(page: Page) {
  await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
  await page.getByRole('button', { name: '＋ 添加筛选', exact: true }).click()
  return filterRow(page)
}

async function expectReadable(locator: Locator) {
  await expect(locator).toBeVisible()
  const ratio = await locator.evaluate(element => {
    const rgba = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)))
    const layers: number[][] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor)
      layers.push(color)
      if ((color[3] ?? 1) === 1) break
    }
    if ((layers.at(-1)?.[3] ?? 1) !== 1) throw new Error('Missing opaque background')
    const background = layers.reverse().reduce((back, front) => over(front, back), [255, 255, 255])
    const foreground = over(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]) => color.map(channel => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((total, value, i) => total + value * [.2126, .7152, .0722][i], 0)
    const a = luminance(foreground), b = luminance(background)
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
  })
  expect(ratio).toBeGreaterThanOrEqual(4.5)
}

test('field-specific filters match their displayed condition, preserve option values, and persist after reload @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 900 })
    const fixture = await seedDatabase(page)
    const row = await addFilter(page)
    const field = row.getByLabel('筛选字段 1', { exact: true })
    const condition = row.getByLabel('条件 1', { exact: true })
    await field.selectOption(fixture.done)
    await expect(condition).toHaveValue('is-checked')
    await expect(row.locator('input')).toHaveCount(0)
    await expect(titles(page)).toHaveText(['Gamma', 'Alpha'])
    await condition.selectOption('is-not-checked')
    await expect(titles(page)).toHaveText(['Empty', 'Beta'])
    await field.selectOption(fixture.status)
    await expect(condition).toHaveValue('equals')
    await row.getByLabel('值 1', { exact: true }).selectOption('Todo')
    await expect(titles(page)).toHaveText(['Gamma', 'Alpha'])
    await field.selectOption(fixture.due)
    await expect(row.getByLabel('值 1', { exact: true })).toHaveAttribute('type', 'date')
    await row.getByLabel('值 1', { exact: true }).fill('2026-10-01')
    await expect(titles(page)).toHaveText(['Alpha'])
    await condition.selectOption('before')
    await expect(titles(page)).toHaveText(['Gamma'])
    await field.selectOption('__created_at__')
    await row.getByLabel('值 1', { exact: true }).fill(fixture.today)
    await expect(titles(page)).toHaveCount(4)
    await field.selectOption(fixture.tags)
    await expect(condition).toHaveValue('contains-any')
    await row.getByRole('checkbox', { name: 'UI', exact: true }).check()
    await expect(titles(page)).toHaveText(['Gamma', 'Alpha'])
    await row.getByRole('checkbox', { name: 'Core, platform', exact: true }).check()
    await condition.selectOption('contains-all')
    await expect(titles(page)).toHaveText(['Alpha'])
    const popover = page.locator('.dbw-filter-popover')
    const box = await row.getByRole('checkbox', { name: 'UI', exact: true }).boundingBox()
    expect(box!.height).toBe(16)
    expect(await popover.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    await expectReadable(row.locator('.dbw-filter-options label').first().locator('span'))
    await popover.screenshot({ path: testInfo.outputPath('filter-options-light.png') })
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect.poll(() => page.evaluate(async ({ databaseId, viewId }) => (await window.knowbook.getDatabaseSavedViews(databaseId)).find(view => view.id === viewId)?.config.filters.rules, fixture)).toEqual([
      { id: expect.any(String), fieldId: fixture.tags, operator: 'contains-all', value: ['UI', 'Core, platform'] }
    ])
    await page.reload()
    await openDatabase(page)
    await expect(titles(page)).toHaveText(['Alpha'])
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await expect(row.getByRole('checkbox', { name: 'UI', exact: true })).toBeChecked()
    await expect(row.getByRole('checkbox', { name: 'Core, platform', exact: true })).toBeChecked()
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await page.evaluate(() => window.knowbook.saveSetting('appearance.theme', 'dark'))
    await page.reload()
    await openDatabase(page)
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await expectReadable(row.locator('.dbw-filter-options label').first().locator('span'))
    await popover.screenshot({ path: testInfo.outputPath('filter-options-dark.png') })
  })
})

test('no-match recovery clears search and filters while preserving layout, sorting, grouping and field preferences @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const fixture = await seedDatabase(page)
    const row = await addFilter(page)
    await row.getByLabel('筛选字段 1', { exact: true }).selectOption(fixture.tags)
    await row.getByRole('checkbox', { name: 'UI', exact: true }).check()
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await page.getByRole('button', { name: '卡片', exact: true }).click()
    await page.getByLabel('搜索记录…', { exact: true }).fill('no such record')
    const empty = page.locator('.dbw-empty-state')
    await expect(empty.locator('h3')).toHaveText('没有匹配的记录')
    await expect(empty.getByRole('button', { name: '清除搜索和筛选', exact: true })).toBeVisible()
    await expectReadable(empty.locator('p'))
    await empty.screenshot({ path: testInfo.outputPath('no-matching-records-light.png') })
    await empty.getByRole('button', { name: '清除搜索和筛选', exact: true }).click()
    await expect(page.getByLabel('搜索记录…', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('搜索记录…', { exact: true })).toBeFocused()
    await expect(page.locator('.dbw-card-body > strong')).toHaveCount(4)
    await expect(page.getByRole('button', { name: '卡片', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect.poll(() => page.evaluate(async ({ databaseId, viewId }) => (await window.knowbook.getDatabaseSavedViews(databaseId)).find(view => view.id === viewId)?.config, fixture)).toEqual({
      ...fixture.config, layout: 'cards', query: '', filters: { operator: 'and', rules: [] }
    })
    expect((await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.databaseId)).length).toBe(4)
    await page.evaluate(() => window.knowbook.saveSetting('appearance.theme', 'dark'))
    await page.reload()
    await openDatabase(page)
    await page.getByLabel('搜索记录…', { exact: true }).fill('no such record')
    await expectReadable(empty.locator('p'))
    await expectReadable(empty.getByRole('button', { name: '清除搜索和筛选', exact: true }))
    await empty.screenshot({ path: testInfo.outputPath('no-matching-records-dark.png') })
    await empty.getByRole('button', { name: '清除搜索和筛选', exact: true }).click()
    await expect(page.locator('.dbw-card-body > strong')).toHaveCount(4)
  })
})

test('genuine empty databases retain creation and IME field naming preserves the drawer and its focus @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const fixture = await seedDatabase(page, true)
    const empty = page.locator('.dbw-empty-state')
    await expect(empty.locator('h3')).toHaveText('数据库还没有记录')
    await expect(empty.getByRole('button', { name: '＋ 新建记录', exact: true })).toBeVisible()
    await empty.getByRole('button', { name: '＋ 新建记录', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '新建记录', exact: true })).toBeVisible()
    await page.getByRole('dialog', { name: '新建记录', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: /^字段/ }).click()
    const drawer = page.getByRole('dialog', { name: '字段管理', exact: true })
    await drawer.getByRole('button', { name: 'Owner', exact: true }).click()
    const input = drawer.locator('.dbw-field-copy input:not(.dbw-field-options)')
    await input.fill('zho')
    await input.dispatchEvent('compositionstart')
    await input.dispatchEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await input.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('zho')
    await input.dispatchEvent('compositionend')
    await input.dispatchEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, keyCode: 229 })
    expect((await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), fixture.databaseId)).find(column => column.id === fixture.owner)?.name).toBe('Owner')
    await input.press('Escape')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('button', { name: 'Owner', exact: true })).toBeFocused()
    await drawer.getByRole('button', { name: 'Owner', exact: true }).click()
    await input.fill('负责人')
    await input.press('Enter')
    await expect(drawer.getByRole('button', { name: '负责人', exact: true })).toBeFocused()
    await expect.poll(() => page.evaluate(async ({ databaseId, owner }) => (await window.knowbook.getDocumentDatabaseColumns(databaseId)).find(column => column.id === owner)?.name, fixture)).toBe('负责人')
  })
})
