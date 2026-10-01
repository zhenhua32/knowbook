import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openDatabase(page: Page) {
  await page.getByTitle(uiText('Database', '数据库')).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText('展示体验')
}

async function seedDatabase(page: Page, language = 'zh-CN', theme = 'light') {
  const fixture = await page.evaluate(async ({ language, theme }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: '展示体验' })
    const groups = ['知识管理产品体验优化计划'.repeat(5) + ' · 内测', '知识管理产品体验优化计划'.repeat(5) + ' · 发布']
    const titles = ['跨团队知识整理与产品体验改进方案'.repeat(5) + ' · 内测记录', '跨团队知识整理与产品体验改进方案'.repeat(5) + ' · 发布记录']
    const notesName = '跨团队审核与交付说明'.repeat(4)
    const notesValue = 'very-long-unbroken-note-'.repeat(12)
    const status = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Stage', type: 'select', options: groups })
    const due = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Due', type: 'date' })
    const notes = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: notesName, type: 'text' })
    const document = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(document.id, { title: '客户研究与界面规范说明'.repeat(6) + ' · 关联文档', summary: '', blocks: [] })
    const documentPath = (await window.knowbook.getDocumentCatalog()).find(item => item.id === document.id)!.path
    const records = []
    for (let index = 0; index < 2; index++) records.push(await window.knowbook.createDatabaseEntity({
      databaseId: database.id, title: titles[index], documentId: index === 0 ? document.id : undefined,
      fieldValues: { [status.id]: groups[index], [due.id]: '2026-10-01', [notes.id]: notesValue }
    }))
    const fields = ['__title__', due.id, '__created_at__', '__updated_at__', notes.id, status.id, '__document__']
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: '完整内容', config: {
      version: 1, layout: 'cards', query: '', filters: { operator: 'and', rules: [] }, sorts: [],
      groupBy: { fieldId: status.id }, visibleFieldIds: fields, fieldOrder: fields, columnWidths: {},
      cardFieldIds: [due.id, '__created_at__', '__updated_at__', notes.id]
    } })
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', theme)
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { database: database.id, titles, groups, notesName, notesValue, documentPath, records, due: due.id, status: status.id }
  }, { language, theme })
  await page.reload()
  await openDatabase(page)
  return fixture
}

async function expectFullyVisibleText(locator: Locator) {
  const box = await locator.evaluate(element => {
    const text = element.firstChild as Text
    const range = document.createRange()
    range.setStart(text, Math.max(0, text.length - 2))
    range.setEnd(text, text.length)
    const suffix = range.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    const container = element.closest('.dbw-record-card, .dbw-board-card, header')!.getBoundingClientRect()
    return { scrollWidth: element.scrollWidth, width: element.clientWidth,
      scrollHeight: element.scrollHeight, height: element.clientHeight, bottom: bounds.bottom,
      suffixBottom: suffix.bottom, suffixRight: suffix.right, right: bounds.right, containerBottom: container.bottom, containerRight: container.right }
  })
  expect(box.scrollWidth).toBeLessThanOrEqual(box.width + 1)
  expect(box.scrollHeight).toBeLessThanOrEqual(box.height + 1)
  expect(box.suffixBottom).toBeLessThanOrEqual(box.bottom + 1)
  expect(box.suffixRight).toBeLessThanOrEqual(box.right + 1)
  expect(box.suffixBottom).toBeLessThanOrEqual(box.containerBottom + 1)
  expect(box.suffixRight).toBeLessThanOrEqual(box.containerRight + 1)
}

async function expectReadable(locator: Locator) {
  const contrast = await locator.evaluate(element => {
    const rgba = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((value, index) => value * (front[3] ?? 1) + back[index] * (1 - (front[3] ?? 1)))
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
    }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0)
    const a = luminance(foreground), b = luminance(background)
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
  })
  expect(contrast).toBeGreaterThanOrEqual(4.5)
}

for (const [language, timezone] of [['zh-CN', 'Asia/Shanghai'], ['en-US', 'America/Los_Angeles']]) {
  test(`card and table dates use ${language} and preserve date properties in ${timezone} @electron`, async () => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page }) => {
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setTimezoneOverride', { timezoneId: timezone })
      const fixture = await seedDatabase(page, language)
      const card = page.locator('.dbw-record-card').filter({ has: page.locator('strong').filter({ hasText: fixture.titles[0] }) })
      const expected = await page.evaluate(({ record, language }) => ({
        created: new Date(record.createdAt).toLocaleDateString(language),
        updated: new Date(record.updatedAt).toLocaleDateString(language),
        due: new Date(2026, 9, 1).toLocaleDateString(language)
      }), { record: fixture.records[0], language })
      const values = card.locator('dd')
      await expect(values).toHaveText([expected.due, expected.created, expected.updated, fixture.notesValue])
      await expect(values.nth(0)).toHaveAttribute('title', expected.due)
      await expect(values.nth(1)).toHaveAttribute('title', expected.created)
      await expect(card.locator('small')).toHaveAttribute('title', fixture.documentPath)
      await expect(card.locator('dt').last()).toHaveAttribute('title', fixture.notesName)
      await expect(values.last()).toHaveAttribute('title', fixture.notesValue)
      await page.getByRole('button', { name: uiText('Table', '表格'), exact: true }).click()
      const row = page.locator('.dbw-table tbody tr').filter({ has: page.locator('.dbw-record-title strong').filter({ hasText: fixture.titles[0] }) })
      await expect(row.locator('input[type=date]')).toHaveValue('2026-10-01')
      await expect(row.locator('td.is-system span')).toHaveText([expected.created, expected.updated])
      await page.getByRole('button', { name: uiText('Cards', '卡片'), exact: true }).click()
      await expect(values).toHaveText([expected.due, expected.created, expected.updated, fixture.notesValue])
      const stored = (await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database)).find(record => record.id === fixture.records[0].id)!
      expect(stored.createdAt).toBe(fixture.records[0].createdAt)
      expect(stored.updatedAt).toBe(fixture.records[0].updatedAt)
      expect(stored.fieldValues[fixture.due]).toBe('2026-10-01')
      await session.detach()
    })
  })
}

for (const theme of ['light', 'dark']) {
  test(`long card and board content remains readable with keyboard focus in ${theme} theme @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 800 })
      const fixture = await seedDatabase(page, 'zh-CN', theme)
      const card = page.locator('.dbw-record-card').filter({ has: page.locator('strong').filter({ hasText: fixture.titles[0] }) })
      const body = card.locator('.dbw-card-body')
      const title = body.locator('strong')
      await expect(title).toHaveAttribute('title', fixture.titles[0])
      const compactHeight = await title.evaluate(element => element.clientHeight)
      await card.locator('.dbw-card-checkbox').focus()
      await page.keyboard.press('Tab')
      await expect(body).toBeFocused()
      await expect.poll(() => title.evaluate(element => element.clientHeight)).toBeGreaterThan(compactHeight)
      await expectFullyVisibleText(title)
      const iconPositions = await page.locator('.dbw-card-icon').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
      expect(Math.abs(iconPositions[0] - iconPositions[1])).toBeLessThanOrEqual(1)
      await page.locator('.dbw-card-grid').screenshot({ path: testInfo.outputPath(`card-keyboard-${theme}.png`) })
      await expectReadable(body.locator('dt').first())
      await expectReadable(body.locator('small'))
      await page.keyboard.press('Enter')
      const drawer = page.getByRole('dialog', { name: '记录详情', exact: true })
      await expect(drawer.getByLabel('标题', { exact: true })).toHaveValue(fixture.titles[0])
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await card.locator('.dbw-card-checkbox').check()
      await expect(card).toHaveClass(/is-selected/)
      await card.locator('.dbw-card-checkbox').uncheck()
      await page.getByRole('button', { name: '看板', exact: true }).click()
      const columns = page.locator('.dbw-board-column')
      await expect(columns).toHaveCount(2)
      await expect.poll(async () => (await columns.locator('header strong').allTextContents()).sort()).toEqual([...fixture.groups].sort())
      for (const group of fixture.groups) {
        const header = columns.locator('header strong').filter({ hasText: group })
        await expectFullyVisibleText(header)
        await expect(header).toHaveAttribute('title', group)
      }
      const boardCard = page.locator('.dbw-board-card').filter({ has: page.locator('strong').filter({ hasText: fixture.titles[0] }) })
      const button = boardCard.getByRole('button')
      await expect(boardCard).toHaveAttribute('draggable', 'true')
      await expect(boardCard.locator('small')).toHaveAttribute('title', `Stage · ${fixture.groups[0]}`)
      await page.getByRole('button', { name: '看板', exact: true }).focus()
      await page.keyboard.press('Tab')
      await button.focus()
      await expect(button).toBeFocused()
      await expectFullyVisibleText(button.locator('strong'))
      expect(await page.locator('.dbw-shell').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await page.locator('.dbw-board').screenshot({ path: testInfo.outputPath(`board-keyboard-${theme}.png`) })
      await expectReadable(button.locator('small'))
      await expectReadable(columns.locator('header b').first())
      await page.keyboard.press('Enter')
      await expect(drawer.getByLabel('标题', { exact: true })).toHaveValue(fixture.titles[0])
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      expect((await page.evaluate(id => window.knowbook.getDatabaseEntities(id), fixture.database)).map(record => record.fieldValues[fixture.status]).sort()).toEqual([...fixture.groups].sort())
    })
  })
}
