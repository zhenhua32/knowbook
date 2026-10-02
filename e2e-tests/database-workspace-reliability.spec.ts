import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openDatabase(page: Page, name: string) {
  await page.getByTitle('数据库', { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(name)
}

async function seedCustomDatabase(page: Page, count = 1) {
  const ids = await page.evaluate(async count => {
    const database = await window.knowbook.createDocumentDatabase({ name: '操作可靠性' })
    const owner = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Owner', type: 'text' })
    for (let index = 0; index < count; index++) {
      await window.knowbook.createDatabaseEntity({ databaseId: database.id,
        title: `${index < 5 ? 'Match entry' : 'Record'} ${String(index).padStart(4, '0')}`,
        fieldValues: { [owner.id]: 'Original owner' } })
    }
    const fields = ['__title__', owner.id, '__document__', '__created_at__', '__updated_at__']
    const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: '操作视图', config: {
      version: 1, layout: 'table', query: '', filters: { operator: 'and', rules: [] },
      sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
      visibleFieldIds: fields, fieldOrder: fields, columnWidths: { __title__: 300, [owner.id]: 220 }, cardFieldIds: [owner.id]
    } })
    await window.knowbook.saveSetting('ui.language', 'zh-CN')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
    return { database: database.id, owner: owner.id }
  }, count)
  await page.reload()
  await openDatabase(page, '操作可靠性')
  return ids
}

test('deep table scrolling can filter to five results and clear search without a blank viewport @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 })
    const ids = await seedCustomDatabase(page, 1000)
    const scroll = page.locator('.dbw-table-scroll')
    const titles = page.locator('.dbw-table .dbw-record-title strong')
    await scroll.hover()
    await page.mouse.wheel(0, 14000)
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(5000)
    expect(await titles.count()).toBeLessThan(40)
    await page.mouse.wheel(240, 0)
    await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
    const left = await scroll.evaluate(node => node.scrollLeft)
    const search = page.getByLabel('搜索记录…', { exact: true })
    await search.fill('Match entry')
    await expect(titles).toHaveText(Array.from({ length: 5 }, (_, index) => `Match entry ${String(index).padStart(4, '0')}`))
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0)
    expect(await scroll.evaluate(node => node.scrollLeft)).toBe(left)
    await scroll.screenshot({ path: testInfo.outputPath('filtered-table.png') })
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('')
    await expect(titles.first()).toHaveText('Match entry 0000')
    expect(await titles.count()).toBeGreaterThan(5)
    expect(await titles.count()).toBeLessThan(40)
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(0)
    expect((await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).length).toBe(1000)
  })
})

test('numeric conditions retain native numeric input and saved number semantics after clearing @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const ids = await page.evaluate(async () => {
      for (const [name, count] of [['Low', 3], ['Medium', 999], ['High', 1001]] as const) {
        const document = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(document.id, { title: `Numeric boundary ${name}`, summary: '',
          blocks: Array.from({ length: count }, (_, index) => ({ type: 'paragraph', content: `Block ${index}`, checked: false, depth: 0 })) })
      }
      const database = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')!
      const fields = ['__title__', '__block_count__']
      const view = await window.knowbook.createDatabaseSavedView({ databaseId: database.id, name: '数值边界', config: {
        version: 1, layout: 'table', query: 'Numeric boundary', filters: { operator: 'and', rules: [
          { id: 'numeric-boundary', fieldId: '__block_count__', operator: 'greater-than', value: 5 }
        ] }, sorts: [{ fieldId: '__title__', direction: 'asc' }], groupBy: { fieldId: null },
        visibleFieldIds: fields, fieldOrder: fields, columnWidths: {}, cardFieldIds: []
      } })
      await window.knowbook.saveSetting('ui.language', 'zh-CN')
      window.localStorage.setItem('knowbook.database.last-source', database.id)
      window.localStorage.setItem(`knowbook.database.last-view.${database.id}`, view.id)
      return { database: database.id, view: view.id }
    })
    await page.reload()
    await page.getByTitle('数据库', { exact: true }).click()
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    const value = page.getByRole('group', { name: '筛选 1', exact: true }).getByLabel('值 1', { exact: true })
    await expect(value).toHaveAttribute('type', 'number')
    await value.press('ControlOrMeta+A')
    await value.press('Backspace')
    await expect(value).toHaveAttribute('type', 'number')
    await value.pressSequentially('1e3')
    await expect(value).toHaveValue('1000')
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Numeric boundary High'])
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect.poll(() => page.evaluate(async ids => {
      const rule = (await window.knowbook.getDatabaseSavedViews(ids.database)).find(view => view.id === ids.view)?.config.filters.rules[0]
      return rule && !('rules' in rule) ? rule.value : undefined
    }, ids)).toBe(1000)
    await page.reload()
    await page.getByTitle('数据库', { exact: true }).click()
    await expect(page.locator('.dbw-table .dbw-record-title strong')).toHaveText(['Numeric boundary High'])
    await page.locator('.dbw-toolbar-menu').first().locator('summary').click()
    await expect(value).toHaveAttribute('type', 'number')
    await expect(value).toHaveValue('1000')
  })
})

for (const theme of ['light', 'dark']) {
  test(`field submission retains failed drafts and treats persisted changes as success in ${theme} theme @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seedCustomDatabase(page)
      await page.evaluate(theme => window.knowbook.saveSetting('appearance.theme', theme), theme)
      await page.reload()
      await openDatabase(page, '操作可靠性')
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: unknown, input: unknown) => unknown
        type Pending = { event: unknown; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        const create = handlers.get('knowbook:create-document-database-column')!
        const read = handlers.get('knowbook:get-database-entities')!
        const pending: Pending[] = []
        let failNextRefresh = false
        process.env.KNOWBOOK_FIELD_REQUEST_COUNT = '0'
        ipcMain.removeHandler('knowbook:create-document-database-column')
        ipcMain.handle('knowbook:create-document-database-column', (event, input) => new Promise((resolve, reject) => {
          pending.push({ event, input, resolve, reject })
          process.env.KNOWBOOK_FIELD_REQUEST_COUNT = String(pending.length)
        }))
        ipcMain.on('knowbook:test-field-settle', (_event, result: { index: number; fail: boolean }) => {
          const request = pending[result.index]
          if (result.fail) request.reject(new Error('The isolated field save failed.'))
          else Promise.resolve(create(request.event, request.input)).then(value => {
            failNextRefresh = true
            request.resolve(value)
          }, request.reject)
        })
        ipcMain.removeHandler('knowbook:get-database-entities')
        ipcMain.handle('knowbook:get-database-entities', (event, input) => {
          if (failNextRefresh) { failNextRefresh = false; throw new Error('The isolated field list refresh failed.') }
          return read(event, input)
        })
      })
      const requestCount = () => app.evaluate(() => Number(process.env.KNOWBOOK_FIELD_REQUEST_COUNT))
      const settle = (index: number, fail: boolean) => app.evaluate(({ ipcMain }, result) => {
        ipcMain.emit('knowbook:test-field-settle', null, result)
      }, { index, fail })
      await page.getByRole('button', { name: /^字段/ }).click()
      const drawer = page.getByRole('dialog', { name: '字段管理', exact: true })
      await drawer.getByRole('button', { name: '＋ 新增字段', exact: true }).click()
      const name = drawer.getByLabel('名称', { exact: true })
      const type = drawer.getByLabel('字段类型', { exact: true })
      await name.fill('Stage')
      await type.selectOption('select')
      const options = drawer.getByLabel('选项（逗号分隔）', { exact: true })
      await options.fill('Low, High')
      await drawer.getByRole('button', { name: '创建', exact: true }).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click() })
      await expect.poll(requestCount).toBe(1)
      await expect(drawer).toHaveAttribute('aria-busy', 'true')
      await expect(name).toBeDisabled()
      await expect(drawer.getByRole('status')).toHaveText('正在创建…')
      await expect(drawer.getByRole('button', { name: '关闭', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(drawer).toBeVisible()
      await settle(0, true)
      await expect(drawer.getByRole('alert')).toHaveText('操作失败，请重试。')
      await expect(name).toHaveValue('Stage')
      await expect(name).toBeEnabled()
      await expect(type).toHaveValue('select')
      await expect(type.locator('option:checked')).toHaveText('单选')
      await expect(options).toHaveValue('Low, High')
      await drawer.screenshot({ path: testInfo.outputPath(`field-failure-${theme}.png`) })
      await drawer.getByRole('button', { name: '创建', exact: true }).click()
      await expect.poll(requestCount).toBe(2)
      await settle(1, false)
      await expect(drawer.locator('.dbw-field-create-form')).toHaveCount(0)
      await expect(page.locator('.app-notifications')).toContainText('字段已保存，但列表刷新失败，请刷新数据库。')
      expect((await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), ids.database)).filter(field => field.name === 'Stage')).toHaveLength(1)
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.reload()
      await openDatabase(page, '操作可靠性')
      await page.getByRole('button', { name: /^字段/ }).click()
      await expect(drawer.getByRole('button', { name: 'Stage', exact: true })).toBeVisible()
      await expect(drawer.getByLabel('选项（逗号分隔） · Stage', { exact: true })).toHaveValue('Low, High')
      expect(await requestCount()).toBe(2)
      expect(errors).toEqual([])
    })
  })
}

async function recordFieldGuidance(page: Page, app: ElectronApplication, testInfo: TestInfo, form: Locator, phase: string, requireAllVisible = true) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const geometry = await form.evaluate(element => {
    const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    const items = Array.from(element.querySelectorAll<HTMLElement>('.dbw-field-create-label, input, select, button, .dbw-inline-actions, [id]')).map(node => {
      const rect = node.getBoundingClientRect()
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        const bounds = ancestor.getBoundingClientRect()
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, bounds.left + ancestor.clientLeft)
          clip.right = Math.min(clip.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth)
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, bounds.top + ancestor.clientTop)
          clip.bottom = Math.min(clip.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight)
        }
        if (style.position === 'fixed') break
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { tag: node.tagName, label: node.getAttribute('aria-label'), text: node.tagName === 'INPUT' ? null : node.textContent,
        focused: document.activeElement === node, centerHit: hit === node || (hit !== null && node.contains(hit)),
        id: node.id, rect: box(rect), clip,
        fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= clip.left - .5 && rect.right <= clip.right + .5 && rect.top >= clip.top - .5 && rect.bottom <= clip.bottom + .5 }
    })
    const createArea = element.closest('.dbw-field-create') as HTMLElement
    return { viewport: { width: innerWidth, height: innerHeight }, form: box(element.getBoundingClientRect()),
      createArea: { rect: box(createArea.getBoundingClientRect()), scrollTop: createArea.scrollTop, clientHeight: createArea.clientHeight, scrollHeight: createArea.scrollHeight },
      horizontalOverflow: element.scrollWidth - element.clientWidth, items,
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') } }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ windows, geometry, requireAllVisible }, null, 2))
  await testInfo.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(geometry.items.length).toBeGreaterThan(4)
  if (requireAllVisible) expect(geometry.items.every(item => item.fullyVisible)).toBe(true)
}

async function expectFieldCreateActionReachable(button: Locator) {
  await expect(button).toBeFocused()
  await expect(button).toBeInViewport({ ratio: 1 })
  const geometry = await button.evaluate(element => {
    const container = element.closest('.dbw-field-create') as HTMLElement
    const rect = element.getBoundingClientRect()
    const bounds = container.getBoundingClientRect()
    const clip = { left: bounds.left + container.clientLeft, top: bounds.top + container.clientTop,
      right: bounds.left + container.clientLeft + container.clientWidth, bottom: bounds.top + container.clientTop + container.clientHeight }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { fullyInside: rect.left >= clip.left - .5 && rect.right <= clip.right + .5 && rect.top >= clip.top - .5 && rect.bottom <= clip.bottom + .5,
      centerHit: hit === element || (hit !== null && element.contains(hit)), scrollTop: container.scrollTop }
  })
  expect(geometry.fullyInside).toBe(true)
  expect(geometry.centerHit).toBe(true)
  expect(geometry.scrollTop).toBeGreaterThan(0)
}

async function expectFieldGuidanceReadable(locator: Locator) {
  await expect(locator).toBeVisible()
  const contrast = await locator.evaluate(element => {
    const rgba = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((value, index) => value * (front[3] ?? 1) + back[index] * (1 - (front[3] ?? 1)))
    const layers: number[][] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const background = rgba(getComputedStyle(node).backgroundColor)
      layers.push(background)
      if ((background[3] ?? 1) === 1) break
    }
    if ((layers.at(-1)?.[3] ?? 1) !== 1) throw new Error('Missing opaque field guidance background')
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

for (const [language, theme] of [['en-US', 'light'], ['zh-CN', 'dark']] as const) {
  test(`new field guidance preserves labels and explains required choice options in ${language} ${theme} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seedCustomDatabase(page)
      const originalRecords = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)
      const originalColumns = await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), ids.database)
      await page.evaluate(async ({ language, theme }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', theme)
      }, { language, theme })
      await page.reload()
      await page.setViewportSize({ width: 760, height: 640 })
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toContainText('操作可靠性')
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: unknown, input: unknown) => unknown
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        const original = handlers.get('knowbook:create-document-database-column')!
        let calls = 0
        process.env.KNOWBOOK_FIELD_GUIDANCE_CALLS = '0'
        ipcMain.removeHandler('knowbook:create-document-database-column')
        ipcMain.handle('knowbook:create-document-database-column', (event, input) => {
          process.env.KNOWBOOK_FIELD_GUIDANCE_CALLS = String(++calls)
          return original(event, input)
        })
      })
      const callCount = () => app.evaluate(() => Number(process.env.KNOWBOOK_FIELD_GUIDANCE_CALLS))
      const readColumns = () => page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), ids.database)
      await page.getByRole('button', { name: /^(?:Fields|字段)/ }).click()
      const drawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理'), exact: true })
      const form = drawer.locator('.dbw-field-create-form')
      const addField = drawer.getByRole('button', { name: uiText('＋ Add field', '＋ 新增字段'), exact: true })
      const requiredText = uiText('Fields marked * are required.', '标有 * 的项目为必填。')
      const optionsText = uiText('Enter at least one option. Separate options with commas.', '至少输入一个选项，使用英文逗号分隔。')
      const name = form.getByLabel(uiText('Name', '名称'), { exact: true })
      const type = form.getByLabel(uiText('Field type', '字段类型'), { exact: true })
      const options = form.getByLabel(uiText('Options (comma separated)', '选项（逗号分隔）'), { exact: true })
      const create = form.getByRole('button', { name: uiText('Create', '创建'), exact: true })
      const nameLabel = name.locator('..')
      const typeLabel = type.locator('..')
      let requiredHintId: string | null = null
      let optionsHintId: string | null = null

      for (const [index, choiceType] of ['select', 'multi-select'].entries()) {
        if (index > 0) await page.setViewportSize({ width: 760, height: 640 })
        await addField.click()
        await expect(name).toBeFocused()
        await expect(name).toHaveAttribute('aria-required', 'true')
        await expect(nameLabel).toHaveClass('dbw-field-create-label')
        await expect(typeLabel).toHaveClass('dbw-field-create-label')
        await expect(nameLabel).toContainText(language === 'en-US' ? 'Name' : '名称')
        await expect(nameLabel).toContainText('*')
        await expect(typeLabel).toContainText(language === 'en-US' ? 'Field type' : '字段类型')
        const requiredHint = form.getByText(requiredText, { exact: true })
        await expect(requiredHint).toBeVisible()
        const requiredId = await requiredHint.getAttribute('id')
        expect(requiredId).toBeTruthy()
        if (requiredHintId) expect(requiredId).toBe(requiredHintId)
        requiredHintId = requiredId
        expect((await name.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(requiredId)
        await name.fill('   ')
        await expect(create).toBeDisabled()
        for (const plainType of ['text', 'date', 'checkbox']) {
          await type.selectOption(plainType)
          await expect(options).toHaveCount(0)
          await expect(form.getByText(optionsText, { exact: true })).toHaveCount(0)
        }
        const fieldName = choiceType === 'select' ? 'Single choice' : 'Multiple choices'
        await name.fill(`  ${fieldName}  `)
        await type.selectOption(choiceType)
        await expect(options).toHaveAttribute('aria-required', 'true')
        await expect(options).toHaveValue('')
        const optionsLabel = options.locator('..')
        await expect(optionsLabel).toHaveClass('dbw-field-create-label')
        await expect(optionsLabel).toContainText(language === 'en-US' ? 'Options (comma separated)' : '选项（逗号分隔）')
        await expect(optionsLabel).toContainText('*')
        const optionsHint = form.getByText(optionsText, { exact: true })
        await expect(optionsHint).toBeVisible()
        const optionId = await optionsHint.getAttribute('id')
        expect(optionId).toBeTruthy()
        if (optionsHintId) expect(optionId).toBe(optionsHintId)
        optionsHintId = optionId
        expect((await options.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain(optionId)
        await expect(create).toBeDisabled()
        await expect(form.getByRole('alert')).toHaveCount(0)
        await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0)
        await options.fill(' , ,  , ')
        await options.press('Enter')
        await expect(create).toBeDisabled()
        expect(await callCount()).toBe(index)
        expect(await readColumns()).toHaveLength(originalColumns.length + index)
        await form.scrollIntoViewIfNeeded()
        await recordFieldGuidance(page, app, testInfo, form, `${language}-${choiceType}-required-guidance`)
        await expectFieldGuidanceReadable(nameLabel.locator('span').first())
        await expectFieldGuidanceReadable(typeLabel.locator('span').first())
        await expectFieldGuidanceReadable(optionsLabel.locator('span').first())
        await expectFieldGuidanceReadable(requiredHint)
        await expectFieldGuidanceReadable(optionsHint)

        if (index === 0) {
          await page.setViewportSize({ width: 760, height: 480 })
          await name.scrollIntoViewIfNeeded()
          await name.click()
          await expect(name).toBeFocused()
          await page.keyboard.press('Tab')
          await expect(type).toBeFocused()
          await expect(type).toBeInViewport({ ratio: 1 })
          await page.keyboard.press('Tab')
          await expect(options).toBeFocused()
          await expect(options).toBeInViewport({ ratio: 1 })
        }
        await options.fill(' Low , High, Low ,  ')
        await expect(create).toBeEnabled()
        await expect(options).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(create).toBeFocused()
        await expect(create).toBeInViewport({ ratio: 1 })
        if (index === 0) {
          await expectFieldCreateActionReachable(create)
          await page.keyboard.press('Tab')
          const cancel = form.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })
          await expectFieldCreateActionReachable(cancel)
          await recordFieldGuidance(page, app, testInfo, form, `${language}-select-short-keyboard-scroll`, false)
          expect(await callCount()).toBe(0)
          await page.keyboard.press('Shift+Tab')
          await expectFieldCreateActionReachable(create)
        }
        await page.keyboard.press('Enter')
        await expect.poll(callCount).toBe(index + 1)
        await expect(form).toHaveCount(0)
        const columns = await readColumns()
        expect(columns).toHaveLength(originalColumns.length + index + 1)
        const saved = columns.filter(field => field.name === fieldName)
        expect(saved).toHaveLength(1)
        expect(saved[0].type).toBe(choiceType)
        expect(saved[0].options).toEqual(['Low', 'High'])
      }
      expect(await callCount()).toBe(2)
      expect((await readColumns()).filter(field => originalColumns.some(original => original.id === field.id))).toEqual(originalColumns)
      expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).toEqual(originalRecords)
      await drawer.getByRole('button', { name: uiText('Close', '关闭'), exact: true }).click()
      await page.reload()
      const persisted = await readColumns()
      expect(persisted.filter(field => ['Single choice', 'Multiple choices'].includes(field.name)).map(field => ({ name: field.name, type: field.type, options: field.options })))
        .toEqual([{ name: 'Single choice', type: 'select', options: ['Low', 'High'] }, { name: 'Multiple choices', type: 'multi-select', options: ['Low', 'High'] }])
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
      expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
      expect(errors).toEqual([])
    })
  })
}

async function recordFieldEnterState(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const drawer = document.querySelector('.dbw-field-drawer')
    const form = drawer?.querySelector('.dbw-field-create-form')
    return { viewport: { width: innerWidth, height: innerHeight }, formPresent: Boolean(form),
      busy: drawer?.getAttribute('aria-busy'), active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
      values: Array.from(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select') ?? []).map(input => ({
        label: input.getAttribute('aria-label'), value: input.value, disabled: input.disabled, focused: document.activeElement === input
      })), alerts: Array.from(drawer?.querySelectorAll('[role=alert]') ?? []).map(alert => alert.textContent) }
  })
  const probe = await app.evaluate(() => ({ requests: JSON.parse(process.env.KNOWBOOK_FIELD_ENTER_REQUESTS!),
    failures: JSON.parse(process.env.KNOWBOOK_FIELD_ENTER_FAILURES ?? '[]') }))
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ windows, state, probe }, null, 2))
  await testInfo.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

async function setFieldEnterFailure(app: ElectronApplication, databaseId: string, enabled: boolean) {
  await app.evaluate(({ app }, { databaseId, enabled }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!
    const { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.exec('DROP TRIGGER IF EXISTS knowbook_e2e_field_enter_failure')
      if (enabled) {
        const id = databaseId.replace(/'/g, "''")
        database.exec("CREATE TRIGGER knowbook_e2e_field_enter_failure BEFORE INSERT ON document_database_columns WHEN NEW.database_id = '" + id +
          "' AND NEW.name = 'Enter multi choice field' BEGIN SELECT RAISE(ABORT, 'The isolated field creation is temporarily unavailable.'); END")
      }
    } finally { database.close() }
  }, { databaseId, enabled })
}

for (const [language, theme] of [['en-US', 'light'], ['zh-CN', 'dark']] as const) {
  test(`field inputs submit valid drafts with Enter in ${language} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seedCustomDatabase(page)
      const originalColumns = await page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), ids.database)
      const originalRecords = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)
      await page.evaluate(async ({ language, theme }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', theme)
      }, { language, theme })
      await page.reload()
      await page.setViewportSize({ width: 760, height: 640 })
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toContainText('操作可靠性')
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: unknown, input: unknown) => unknown
        type Pending = { event: unknown; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void; settled: boolean }
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        const original = handlers.get('knowbook:create-document-database-column')!
        const pending: Pending[] = []
        const failures: string[] = []
        process.env.KNOWBOOK_FIELD_ENTER_REQUESTS = '[]'
        process.env.KNOWBOOK_FIELD_ENTER_FAILURES = '[]'
        ipcMain.removeHandler('knowbook:create-document-database-column')
        ipcMain.handle('knowbook:create-document-database-column', (event, input) => new Promise((resolve, reject) => {
          pending.push({ event, input, resolve, reject, settled: false })
          process.env.KNOWBOOK_FIELD_ENTER_REQUESTS = JSON.stringify(pending.map(request => request.input))
        }))
        ipcMain.on('knowbook:test-field-enter-settle', (_event, index: number) => {
          const request = pending[index]
          if (!request || request.settled) throw new Error('Invalid isolated field request settlement')
          request.settled = true
          setImmediate(async () => {
            try { request.resolve(await original(request.event, request.input)) }
            catch (error) {
              failures.push(error instanceof Error ? error.message : String(error))
              process.env.KNOWBOOK_FIELD_ENTER_FAILURES = JSON.stringify(failures)
              request.reject(error instanceof Error ? error : new Error(String(error)))
            }
          })
        })
      })
      const callCount = () => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_FIELD_ENTER_REQUESTS!).length as number)
      const settle = (index: number) => app.evaluate(({ ipcMain }, index) => { ipcMain.emit('knowbook:test-field-enter-settle', null, index) }, index)
      const readColumns = () => page.evaluate(id => window.knowbook.getDocumentDatabaseColumns(id), ids.database)
      await page.getByRole('button', { name: /^(?:Fields|字段)/ }).click()
      const drawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理'), exact: true })
      const add = drawer.getByRole('button', { name: uiText('＋ Add field', '＋ 新增字段'), exact: true })
      const form = drawer.locator('.dbw-field-create-form')
      const name = form.getByLabel(uiText('Name', '名称'), { exact: true })
      const type = form.getByLabel(uiText('Field type', '字段类型'), { exact: true })
      const options = form.getByLabel(uiText('Options (comma separated)', '选项（逗号分隔）'), { exact: true })
      const fields = [
        { type: 'text', name: 'Enter text field' }, { type: 'date', name: 'Enter date field' },
        { type: 'checkbox', name: 'Enter checkbox field' }, { type: 'select', name: 'Enter single choice field' },
        { type: 'multi-select', name: 'Enter multi choice field' }
      ] as const
      const exerciseBusyLock = async (expectedCalls: number) => {
        await expect(drawer).toHaveAttribute('aria-busy', 'true')
        await expect(name).toBeDisabled()
        await expect(type).toBeDisabled()
        if (await options.count()) await expect(options).toBeDisabled()
        await expect(drawer.getByRole('status')).toHaveText(uiText('Creating…', '正在创建…'))
        const create = form.getByRole('button', { name: uiText('Creating…', '正在创建…'), exact: true })
        await expect(create).toBeDisabled()
        await expect(form.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })).toBeDisabled()
        await expect(drawer.getByRole('button', { name: uiText('Close', '关闭'), exact: true })).toBeDisabled()
        await page.keyboard.press('Enter')
        await page.keyboard.press('Space')
        await create.scrollIntoViewIfNeeded()
        await expect(create).toBeInViewport({ ratio: 1 })
        const rect = await create.boundingBox()
        expect(rect).not.toBeNull()
        expect(await create.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return hit === element || (hit !== null && element.contains(hit))
        })).toBe(true)
        await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2)
        await page.keyboard.press('Escape')
        await expect(drawer).toBeVisible()
        expect(await callCount()).toBe(expectedCalls)
      }

      for (const [index, field] of fields.entries()) {
        await add.click()
        await name.fill(`  ${field.name}  `)
        await type.selectOption(field.type)
        const choice = field.type === 'select' || field.type === 'multi-select'
        const input = choice ? options : name
        if (choice) await options.fill(' Low , High, Low ,  ')
        else await name.click()
        await expect(input).toBeFocused()
        const before = await callCount()
        if (field.type === 'date' || field.type === 'select') {
          await input.dispatchEvent('compositionstart', { data: 'candidate' })
          await page.keyboard.press('Enter')
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          expect(await callCount()).toBe(before)
          await expect(input).toBeFocused()
          await expect(name).toHaveValue(`  ${field.name}  `)
          await input.dispatchEvent('compositionend', { data: 'candidate' })
          // These flag probes are controlled DOM events. The lifecycle probe
          // above uses a real Enter key; neither pretends to operate an OS IME.
          for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
            await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...flags })
            expect(await callCount()).toBe(before)
          }
        }
        if (field.type === 'multi-select') await setFieldEnterFailure(app, ids.database, true)
        await page.keyboard.press('Enter')
        if (index === 0) await recordFieldEnterState(page, app, testInfo, `${language}-name-enter-baseline`)
        await expect.poll(callCount).toBe(before + 1)
        await exerciseBusyLock(before + 1)
        await recordFieldEnterState(page, app, testInfo, `${language}-${field.type}-enter-pending`)
        expect(await readColumns()).toHaveLength(originalColumns.length + index)
        await settle(before)
        if (field.type === 'multi-select') {
          await expect(form.getByRole('alert')).toHaveText(uiText('Something went wrong. Please try again.', '操作失败，请重试。'))
          await recordFieldEnterState(page, app, testInfo, `${language}-sqlite-failure-keeps-draft`)
          await expect(form.getByRole('alert')).not.toContainText(/SqliteError|Error invoking|remote method|temporarily unavailable/i)
          await expect(name).toHaveValue(`  ${field.name}  `)
          await expect(type).toHaveValue(field.type)
          await expect(options).toHaveValue(' Low , High, Low ,  ')
          await expect(name).toBeEnabled()
          await expect(options).toBeEnabled()
          expect(await readColumns()).toHaveLength(originalColumns.length + index)
          expect(await callCount()).toBe(before + 1)
          await setFieldEnterFailure(app, ids.database, false)
          await options.click()
          await expect(options).toBeFocused()
          await page.keyboard.press('Enter')
          await expect.poll(callCount).toBe(before + 2)
          await exerciseBusyLock(before + 2)
          await settle(before + 1)
        }
        await expect(form).toHaveCount(0)
        const columns = await readColumns()
        expect(columns).toHaveLength(originalColumns.length + index + 1)
        expect(columns.filter(column => column.name === field.name).map(column => ({ type: column.type, options: column.options })))
          .toEqual([{ type: field.type, options: choice ? ['Low', 'High'] : [] }])
        expect(columns.filter(column => originalColumns.some(original => original.id === column.id))).toEqual(originalColumns)
        expect(await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.database)).toEqual(originalRecords)
      }
      expect(await callCount()).toBe(6)
      expect(await app.evaluate(() => JSON.parse(process.env.KNOWBOOK_FIELD_ENTER_FAILURES!)))
        .toEqual(['The isolated field creation is temporarily unavailable.'])
      await recordFieldEnterState(page, app, testInfo, `${language}-all-field-types-persisted`)
      await drawer.getByRole('button', { name: uiText('Close', '关闭'), exact: true }).click()
      await page.reload()
      const persisted = await readColumns()
      expect(persisted.filter(column => fields.some(field => field.name === column.name)).map(column => ({ name: column.name, type: column.type, options: column.options })))
        .toEqual(fields.map(field => ({ ...field, options: field.type === 'select' || field.type === 'multi-select' ? ['Low', 'High'] : [] })))
      await recordFieldEnterState(page, app, testInfo, `${language}-reload-confirms-fields`)
      expect(await callCount()).toBe(6)
      expect(errors).toEqual([])
    })
  })
}
