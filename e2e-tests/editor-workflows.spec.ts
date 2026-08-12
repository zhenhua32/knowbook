import { expect, test, type Locator, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type PersistedBodyBlock = {
  type: string
  content: string
  checked: boolean
  depth: number
  parentIndex: number | null
}

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getSummaryInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-textarea').first()
}

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

function getBodyEditor(page: Page, bodyIndex: number): Locator {
  return page.locator('textarea.block-inline-textarea').nth(bodyIndex + 1)
}

function getTreeButton(page: Page, title: string): Locator {
  return page.locator('.tree-button', { hasText: title }).first()
}

async function getBodyBlockValues(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => (textarea as HTMLTextAreaElement).value)
  )
}

async function findDocumentIdByTitle(page: Page, title: string): Promise<string | null> {
  return page.evaluate(async (documentTitle) => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return catalog.find((document) => document.title === documentTitle)?.id ?? null
  }, title)
}

async function getPersistedBodyBlocks(page: Page, documentId: string): Promise<PersistedBodyBlock[] | null> {
  return page.evaluate(async (id) => {
    const detail = await window.knowbook.getDocumentDetail(id)
    if (!detail) {
      return null
    }

    const bodyBlocks = detail.blocks.slice(1)
    const bodyIndexById = new Map(bodyBlocks.map((block, index) => [block.id, index]))
    return bodyBlocks.map((block) => ({
      type: block.type,
      content: block.content,
      checked: block.checked,
      depth: block.depth,
      parentIndex: block.parentBlockId ? bodyIndexById.get(block.parentBlockId) ?? null : null
    }))
  }, documentId)
}

async function createSavedRootDocument(page: Page, title: string, body: string): Promise<string> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await ensureDocumentMetadataEditor(page)
  await getTitleInput(page).fill(title)
  await getBodyEditor(page, 0).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)

  await expect.poll(() => findDocumentIdByTitle(page, title)).not.toBeNull()
  const id = await findDocumentIdByTitle(page, title)
  if (!id) {
    throw new Error(`Could not resolve document id for ${title}`)
  }
  return id
}

async function createBodyBlocks(page: Page, values: string[]): Promise<void> {
  await getBodyEditor(page, 0).fill(values[0])
  for (let index = 1; index < values.length; index += 1) {
    await getBodyEditor(page, index - 1).press('Control+Enter')
    await getBodyEditor(page, index).fill(values[index])
  }
}

async function selectFirstTwoBodyBlocks(page: Page): Promise<void> {
  const firstBody = getBodyEditor(page, 0)
  await firstBody.click()
  await firstBody.press('End')
  await firstBody.press('Shift+ArrowDown')
  await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
}

async function readClipboardText(app: Parameters<Parameters<typeof withElectronApp>[0]>[0]['app']): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText()).then((text) => text.replace(/\r\n?/g, '\n'))
}

test.describe('Editor Common Workflows @electron', () => {
  test('flushes unsaved title, summary, and body before switching documents', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const sourceTitle = `Flush source ${suffix}`
    const renamedTitle = `Flush renamed ${suffix}`
    const targetTitle = `Flush target ${suffix}`

    await withElectronApp(async ({ page }) => {
      const sourceId = await createSavedRootDocument(page, sourceTitle, 'Old body')
      await createSavedRootDocument(page, targetTitle, 'Target body')
      await getTreeButton(page, sourceTitle).click()
      await ensureDocumentMetadataEditor(page)

      await getTitleInput(page).fill(renamedTitle)
      await getSummaryInput(page).fill('Summary saved by navigation flush')
      await getBodyEditor(page, 0).fill('Body saved by navigation flush')
      await getTreeButton(page, targetTitle).click()
      await expect(getPreviewTitle(page)).toHaveText(targetTitle)

      await expect.poll(() => page.evaluate(async (id) => {
        const detail = await window.knowbook.getDocumentDetail(id)
        return detail ? {
          title: detail.title,
          summary: detail.summary,
          body: detail.blocks[1]?.content
        } : null
      }, sourceId)).toEqual({
        title: renamedTitle,
        summary: 'Summary saved by navigation flush',
        body: 'Body saved by navigation flush'
      })

      await getTreeButton(page, renamedTitle).click()
      await ensureDocumentMetadataEditor(page)
      await expect(getTitleInput(page)).toHaveValue(renamedTitle)
      await expect(getSummaryInput(page)).toHaveValue('Summary saved by navigation flush')
      await expect(getBodyEditor(page, 0)).toHaveValue('Body saved by navigation flush')
    })
  })

  test('persists undo and redo results after structural edits', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Undo redo ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Alpha')
      await getBodyEditor(page, 0).press('Control+Enter')
      await getBodyEditor(page, 1).fill('Beta')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])

      await getBodyEditor(page, 1).press('Control+z')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha'])
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'Alpha', checked: false, depth: 0, parentIndex: null }
      ])

      await getBodyEditor(page, 0).press('Control+Shift+z')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'Alpha', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Beta', checked: false, depth: 0, parentIndex: null }
      ])
    })
  })

  test('persists multi-block conversion, duplication, toolbar movement, and cut', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Multi workflow ${Date.now().toString(36)}`

    await withElectronApp(async ({ app, page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial')
      await createBodyBlocks(page, ['Alpha', 'Beta', 'Gamma'])
      await selectFirstTwoBodyBlocks(page)

      let toolbar = page.locator('.block-selection-toolbar')
      await toolbar.locator('select').selectOption('todo')
      await toolbar.getByRole('button', { name: uiText('Convert', '转换') }).click()
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Alpha', checked: false, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Beta', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Gamma', checked: false, depth: 0, parentIndex: null }
      ])

      await toolbar.getByRole('button', { name: uiText('Duplicate', '复制副本') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Alpha', 'Beta', 'Gamma'])

      toolbar = page.locator('.block-selection-toolbar')
      await toolbar.getByRole('button', { name: uiText('Move Down', '下移') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Alpha', 'Beta'])
      await toolbar.getByRole('button', { name: uiText('Move Up', '上移') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Alpha', 'Beta', 'Gamma'])

      await toolbar.getByRole('button', { name: uiText('Cut', '剪切') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])
      await expect.poll(() => readClipboardText(app)).toBe('- [ ] Alpha\n\n- [ ] Beta')
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Alpha', checked: false, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Beta', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Gamma', checked: false, depth: 0, parentIndex: null }
      ])
    })
  })

  test('copies selected blocks and plain text to the system clipboard without mutating the document', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Copy workflow ${Date.now().toString(36)}`

    await withElectronApp(async ({ app, page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial')
      await createBodyBlocks(page, ['- [x] Done', '> Quoted'])
      await selectFirstTwoBodyBlocks(page)

      const toolbar = page.locator('.block-selection-toolbar')
      await toolbar.getByRole('button', { name: uiText('Copy Blocks', '复制块') }).click()
      await expect.poll(() => readClipboardText(app)).toBe('- [x] Done\n\n> Quoted')

      await toolbar.getByRole('button', { name: uiText('Copy Text', '复制文本') }).click()
      await expect.poll(() => readClipboardText(app)).toBe('[x] Done\n\nQuoted')
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Done', checked: true, depth: 0, parentIndex: null },
        { type: 'quote', content: 'Quoted', checked: false, depth: 0, parentIndex: null }
      ])
    })
  })

  test('uses slash commands for type conversion, child insertion, duplication, movement, and deletion', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Slash workflow ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Root task')
      const root = getBodyEditor(page, 0)

      await root.fill('/todo')
      await page.locator('.slash-command-item', { hasText: '/todo' }).click()
      await root.fill('Root task')

      await root.fill('Root task\n/child')
      await root.press('End')
      await page.locator('.slash-command-item', { hasText: '/child' }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Root task\n', ''])
      await getBodyEditor(page, 1).fill('Child task')

      await getBodyEditor(page, 1).fill('Child task\n/duplicate')
      await getBodyEditor(page, 1).press('End')
      await page.locator('.slash-command-item', { hasText: '/duplicate' }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Root task\n', 'Child task\n', 'Child task\n'])

      await getBodyEditor(page, 2).fill('Duplicated child\n/up')
      await getBodyEditor(page, 2).press('End')
      await page.locator('.slash-command-item', { hasText: '/up' }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Root task\n', 'Duplicated child\n', 'Child task\n'])

      await getBodyEditor(page, 2).fill('Child task\n/delete')
      await getBodyEditor(page, 2).press('End')
      await page.locator('.slash-command-item', { hasText: '/delete' }).click()
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Root task\n', checked: false, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Duplicated child\n', checked: false, depth: 1, parentIndex: 0 }
      ])
    })
  })

  test('inserts document and block links from suggestions and persists them', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const targetTitle = `Suggestion target ${suffix}`
    const sourceTitle = `Suggestion source ${suffix}`

    await withElectronApp(async ({ page }) => {
      await createSavedRootDocument(page, targetTitle, 'Target body')
      const sourceId = await createSavedRootDocument(page, sourceTitle, 'Link workspace')
      await createBodyBlocks(page, ['Link workspace', 'Source block'])
      const editor = getBodyEditor(page, 0)

      await editor.fill(`See [[${targetTitle.slice(0, 12)}`)
      await expect(page.locator('.link-helper-panel')).toBeVisible()
      await expect(page.locator('.relation-chip', { hasText: targetTitle })).toBeVisible()
      await page.locator('.relation-chip', { hasText: targetTitle }).click()
      await expect(editor).toHaveValue(`See [[${targetTitle}]]`)

      await editor.fill(`See [[${targetTitle}]] and [[Source`)
      const blockSuggestion = page.locator('.link-helper-panel .relation-chip', { hasText: 'Source block' }).first()
      await expect(blockSuggestion).toBeVisible()
      await blockSuggestion.click()

      await expect.poll(() => page.evaluate(async (id) => {
        const detail = await window.knowbook.getDocumentDetail(id)
        return detail?.blocks[1]?.content ?? null
      }, sourceId)).toMatch(/^See \[\[Suggestion target .+\]\] and \[\[[0-9a-f-]+\]\]$/)
    })
  })

  test('searches within blocks and globally, then navigates with history shortcuts', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)
    const alphaTitle = `Search alpha ${suffix}`
    const betaTitle = `Search beta ${suffix}`
    const uniqueNeedle = `needle-${suffix}`

    await withElectronApp(async ({ page }) => {
      await createSavedRootDocument(page, alphaTitle, `Alpha ${uniqueNeedle}`)
      await createBodyBlocks(page, [`Alpha ${uniqueNeedle}`, 'Other block'])
      await createSavedRootDocument(page, betaTitle, 'Beta body')
      await getTreeButton(page, alphaTitle).click()

      await page.keyboard.press('Control+f')
      const blockSearch = page.locator('.block-find-input')
      await blockSearch.fill(uniqueNeedle)
      await expect(page.locator('.block-find-result')).toHaveCount(1)
      await blockSearch.press('Enter')
      await expect(getBodyEditor(page, 0)).toBeFocused()
      await page.keyboard.press('Escape')

      await page.keyboard.press('Control+k')
      const globalSearch = page.locator('.global-search-input')
      await globalSearch.fill(betaTitle)
      await expect(page.locator('.global-search-result', { hasText: betaTitle })).toBeVisible()
      await page.locator('.global-search-result', { hasText: betaTitle }).click()
      await expect(getPreviewTitle(page)).toHaveText(betaTitle)

      await page.keyboard.press('Alt+ArrowLeft')
      await expect(getPreviewTitle(page)).toHaveText(alphaTitle)
      await page.keyboard.press('Alt+ArrowRight')
      await expect(getPreviewTitle(page)).toHaveText(betaTitle)
    })
  })

  test('pins a document and copies its saved markdown from the header menu', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Pin markdown ${Date.now().toString(36)}`

    await withElectronApp(async ({ app, page }) => {
      await createSavedRootDocument(page, title, 'Markdown body')
      await page.getByRole('button', { name: uiText('Pin document', '收藏文档') }).click()
      await expect(page.locator('.pinned-doc-item-compact', { hasText: title })).toBeVisible()

      await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Copy MD', '复制 Markdown') }).click()
      await expect.poll(() => readClipboardText(app)).toContain(`# ${title}`)
      await expect.poll(() => readClipboardText(app)).toContain('Markdown body')

      await page.getByRole('button', { name: uiText('Unpin document', '取消收藏') }).click()
      await expect(page.locator('.pinned-doc-item-compact', { hasText: title })).toHaveCount(0)
    })
  })
})
