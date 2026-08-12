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

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

function getBodyEditor(page: Page, bodyIndex: number): Locator {
  return page.locator('textarea.block-inline-textarea').nth(bodyIndex + 1)
}

async function getBodyBlockValues(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => (textarea as HTMLTextAreaElement).value)
  )
}

async function getBodyBlockTypes(page: Page): Promise<string[]> {
  return page.locator('textarea.block-inline-textarea').evaluateAll((textareas) =>
    textareas.slice(1).map((textarea) => {
      const className = Array.from(textarea.classList).find((value) => value.startsWith('type-'))
      return className?.slice('type-'.length) ?? ''
    })
  )
}

async function findDocumentIdByTitle(page: Page, title: string): Promise<string | null> {
  return page.evaluate(async (documentTitle) => {
    const catalog = await window.knowbook.getDocumentCatalog()
    return catalog.find((document) => document.title === documentTitle)?.id ?? null
  }, title)
}

async function createBodyBlocks(page: Page, values: string[]): Promise<void> {
  if (values.length === 0) {
    return
  }

  await getBodyEditor(page, 0).fill(values[0])
  for (let index = 1; index < values.length; index += 1) {
    await getBodyEditor(page, index - 1).press('Control+Enter')
    await getBodyEditor(page, index).fill(values[index])
  }
}

async function openBodyBlockToolbar(page: Page, bodyIndex: number): Promise<Locator> {
  const row = page.locator('.block-editor-row').nth(bodyIndex + 1)
  await row.locator('.block-drag-handle').click({ force: true })
  const toolbar = row.locator('.block-edit-toolbar')
  await expect(toolbar).toBeVisible()
  return toolbar
}

async function createSavedRootDocument(page: Page, title: string, body: string): Promise<string> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await ensureDocumentMetadataEditor(page)
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)

  await getTitleInput(page).fill(title)
  await getBodyEditor(page, 0).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)

  await expect.poll(() => findDocumentIdByTitle(page, title)).not.toBeNull()
  const documentId = await findDocumentIdByTitle(page, title)
  if (!documentId) {
    throw new Error(`Could not resolve document id for ${title}`)
  }

  return documentId
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

async function getPersistedBodyBlockMetadata(page: Page, documentId: string) {
  return page.evaluate(async (id) => {
    const detail = await window.knowbook.getDocumentDetail(id)
    return detail?.blocks.slice(1).map((block) => ({
      type: block.type,
      content: block.content,
      language: block.language ?? null,
      highlight: block.highlight ?? null
    })) ?? null
  }, documentId)
}

async function reopenDocument(page: Page, title: string): Promise<void> {
  await page.locator('.tree-button:not(.tree-button-active)').first().click()
  await expect(getPreviewTitle(page)).not.toHaveText(title)

  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(getPreviewTitle(page)).toHaveText(title)
  await ensureDocumentMetadataEditor(page)
}

test.describe('Editor Common Operations Durability @electron', () => {
  test('auto-saves text edits and keeps a footer-added empty block after reload', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common empty row ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial body')

      await getBodyEditor(page, 0).fill('Edited body')
      await page.getByRole('button', { name: uiText('Add block', '新增块') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Edited body', ''])

      const expectedBlocks: PersistedBodyBlock[] = [
        { type: 'paragraph', content: 'Edited body', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: '', checked: false, depth: 0, parentIndex: null }
      ]
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual(expectedBlocks)

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Edited body', ''])
    })
  })

  test('persists split, keyboard insertion, and backspace merge operations', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common split merge ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'AlphaBeta')
      const firstBody = getBodyEditor(page, 0)

      await firstBody.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        textarea.focus()
        textarea.setSelectionRange(5, 5)
      })
      await firstBody.press('Alt+Enter')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta'])

      await getBodyEditor(page, 1).press('Control+Enter')
      await getBodyEditor(page, 2).fill('Gamma')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'Beta', 'Gamma'])

      await getBodyEditor(page, 2).press('Home')
      await getBodyEditor(page, 2).press('Backspace')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'BetaGamma'])

      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'Alpha', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'BetaGamma', checked: false, depth: 0, parentIndex: null }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Alpha', 'BetaGamma'])
    })
  })

  test('persists todo conversion, checked state, and nested list relationships', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common todo nesting ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial body')
      const parentEditor = getBodyEditor(page, 0)

      await parentEditor.fill('- [ ] Parent task')
      await expect(parentEditor).toHaveClass(/type-todo/)
      await page.locator('.block-todo-checkbox').first().check()

      await parentEditor.press('Control+Enter')
      const childEditor = getBodyEditor(page, 1)
      await childEditor.fill('Child task')
      await childEditor.press('Tab')

      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Parent task', 'Child task'])
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['todo', 'todo'])
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Parent task', checked: true, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Child task', checked: false, depth: 1, parentIndex: 0 }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['todo', 'todo'])
      await expect(page.locator('.block-todo-checkbox').nth(0)).toBeChecked()
      await expect(page.locator('.block-todo-checkbox').nth(1)).not.toBeChecked()

      await expect(page.getByRole('button', { name: uiText('Collapse block', '折叠块') })).toBeVisible()
      await page.getByRole('button', { name: uiText('Collapse block', '折叠块') }).click()
      await expect(getBodyEditor(page, 1)).toHaveCount(0)
      await page.getByRole('button', { name: uiText('Expand block', '展开块') }).click()
      await expect(getBodyEditor(page, 1)).toHaveValue('Child task')

      await getBodyEditor(page, 1).press('Shift+Tab')
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'todo', content: 'Parent task', checked: true, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Child task', checked: false, depth: 0, parentIndex: null }
      ])
    })
  })

  test('persists keyboard reordering and context-menu deletion', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common reorder delete ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'One')

      await getBodyEditor(page, 0).press('Control+Enter')
      await getBodyEditor(page, 1).fill('Two')
      await getBodyEditor(page, 1).press('Control+Enter')
      await getBodyEditor(page, 2).fill('Three')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Two', 'Three'])

      await getBodyEditor(page, 2).press('Alt+ArrowUp')
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Three', 'Two'])

      await getBodyEditor(page, 2).click({ button: 'right' })
      await expect(page.locator('.block-context-menu')).toBeVisible()
      await page.locator('.block-context-menu').getByRole('button', { name: uiText('Delete', '删除') }).click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Three'])

      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'One', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Three', checked: false, depth: 0, parentIndex: null }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['One', 'Three'])
    })
  })

  test('persists every common block type created with markdown shortcuts', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common block types ${Date.now().toString(36)}`
    const markdownInputs = [
      '# Heading one',
      '## Heading two',
      '> Quoted line',
      '- Bullet item',
      '1. Numbered item',
      '- [x] Completed item',
      '$$ x^2 + y^2',
      '```\nconst answer = 42;\n```',
      '---'
    ]

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial body')
      await createBodyBlocks(page, markdownInputs)

      await expect.poll(() => getBodyBlockTypes(page)).toEqual([
        'heading-1',
        'heading-2',
        'quote',
        'bulleted-list',
        'numbered-list',
        'todo',
        'math',
        'code'
      ])
      await expect(page.locator('.block-divider-line')).toHaveCount(1)

      await expect.poll(() => getPersistedBodyBlockMetadata(page, documentId)).toEqual([
        { type: 'heading-1', content: 'Heading one', language: null, highlight: null },
        { type: 'heading-2', content: 'Heading two', language: null, highlight: null },
        { type: 'quote', content: 'Quoted line', language: null, highlight: null },
        { type: 'bulleted-list', content: 'Bullet item', language: null, highlight: null },
        { type: 'numbered-list', content: 'Numbered item', language: null, highlight: null },
        { type: 'todo', content: 'Completed item', language: null, highlight: null },
        { type: 'math', content: 'x^2 + y^2', language: null, highlight: null },
        { type: 'code', content: 'const answer = 42;\n```', language: 'javascript', highlight: null },
        { type: 'divider', content: '', language: null, highlight: null }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockTypes(page)).toEqual([
        'heading-1',
        'heading-2',
        'quote',
        'bulleted-list',
        'numbered-list',
        'todo',
        'math',
        'code'
      ])
      await expect(page.locator('.block-divider-line')).toHaveCount(1)
    })
  })

  test('persists toolbar type, code language, highlight, duplicate, and inline add operations', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common toolbar ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'console.log("hello")')
      const toolbar = await openBodyBlockToolbar(page, 0)

      await toolbar.locator('.block-type-selector').selectOption('code')
      await toolbar.getByRole('button', { name: uiText('Blue', '蓝色') }).click()
      const languageBadge = page.locator('.block-code-language-badge').nth(0)
      await languageBadge.click()
      await page.locator('.code-block-language-selector').selectOption('typescript')

      const codeToolbar = await openBodyBlockToolbar(page, 0)
      await codeToolbar.locator('.block-toolbar-duplicate').click()
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['console.log("hello")', 'console.log("hello")'])

      await page.locator('.block-editor-row').nth(1).locator('.block-hover-add').click({ force: true })
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['console.log("hello")', '', 'console.log("hello")'])
      await getBodyEditor(page, 1).fill('Inserted inline')

      await expect.poll(() => getPersistedBodyBlockMetadata(page, documentId)).toEqual([
        { type: 'code', content: 'console.log("hello")', language: 'typescript', highlight: 'blue' },
        { type: 'paragraph', content: 'Inserted inline', language: null, highlight: null },
        { type: 'code', content: 'console.log("hello")', language: 'typescript', highlight: 'blue' }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['console.log("hello")', 'Inserted inline', 'console.log("hello")'])
      await expect(page.locator('.block-code-language-badge').first()).toContainText('typescript')
    })
  })

  test('pastes multiline plain text and structured markdown as separate persisted blocks', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common paste ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'StartEnd')
      const editor = getBodyEditor(page, 0)
      await editor.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        textarea.focus()
        textarea.setSelectionRange(5, 5)
      })
      await editor.evaluate((element) => {
        const data = new DataTransfer()
        data.setData('text/plain', 'First\nSecond\nThird')
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      })
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['StartFirst', 'Second', 'ThirdEnd'])

      const third = getBodyEditor(page, 2)
      await third.press('End')
      await third.evaluate((element) => {
        const data = new DataTransfer()
        data.setData('text/plain', '\n# Pasted heading\n\n- [ ] Pasted todo')
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      })

      await expect.poll(() => getBodyBlockTypes(page)).toEqual(['paragraph', 'paragraph', 'paragraph', 'heading-1', 'todo'])
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'StartFirst', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Second', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'ThirdEnd', checked: false, depth: 0, parentIndex: null },
        { type: 'heading-1', content: 'Pasted heading', checked: false, depth: 0, parentIndex: null },
        { type: 'todo', content: 'Pasted todo', checked: false, depth: 0, parentIndex: null }
      ])
    })
  })

  test('continues and exits heading and list blocks, downgrades with Backspace, and navigates through the outline', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common continue ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, '# Section')

      await getBodyEditor(page, 0).press('End')
      await getBodyEditor(page, 0).press('Enter')
      await getBodyEditor(page, 1).fill('Paragraph')
      await getBodyEditor(page, 1).press('Control+Enter')
      await getBodyEditor(page, 2).fill('- First item')
      await getBodyEditor(page, 2).press('End')
      await getBodyEditor(page, 2).press('Enter')
      await getBodyEditor(page, 3).fill('Second item')
      await getBodyEditor(page, 3).press('End')
      await getBodyEditor(page, 3).press('Enter')
      await getBodyEditor(page, 4).press('Enter')
      await getBodyEditor(page, 4).fill('After list')
      await getBodyEditor(page, 4).press('Control+Enter')
      await getBodyEditor(page, 5).fill('> Downgrade me')
      await getBodyEditor(page, 5).press('Home')
      await getBodyEditor(page, 5).press('Backspace')

      await expect.poll(() => getPersistedBodyBlockMetadata(page, documentId)).toEqual([
        { type: 'heading-1', content: 'Section', language: null, highlight: null },
        { type: 'paragraph', content: 'Paragraph', language: null, highlight: null },
        { type: 'bulleted-list', content: 'First item', language: null, highlight: null },
        { type: 'bulleted-list', content: 'Second item', language: null, highlight: null },
        { type: 'paragraph', content: 'After list', language: null, highlight: null },
        { type: 'paragraph', content: 'Downgrade me', language: null, highlight: null }
      ])

      const outlineItem = page.locator('.document-outline-panel .toc-item', { hasText: 'Section' })
      await expect(outlineItem).toBeVisible()
      await outlineItem.click()
      await expect(getBodyEditor(page, 0)).toBeFocused()
      await getBodyEditor(page, 0).evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      })
      await getBodyEditor(page, 0).press('ArrowDown')
      await expect(getBodyEditor(page, 1)).toBeFocused()
      await getBodyEditor(page, 1).press('ArrowUp')
      await expect(getBodyEditor(page, 0)).toBeFocused()

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockTypes(page)).toEqual([
        'heading-1',
        'paragraph',
        'bulleted-list',
        'bulleted-list',
        'paragraph',
        'paragraph'
      ])
    })
  })

  test('reorders blocks by dragging and persists the new order', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common drag ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Initial')
      await createBodyBlocks(page, ['One', 'Two', 'Three'])

      const rows = page.locator('.block-editor-row')
      await rows.nth(1).locator('.block-drag-handle').dragTo(rows.nth(3))
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Two', 'Three', 'One'])
      await expect.poll(() => getPersistedBodyBlocks(page, documentId)).toEqual([
        { type: 'paragraph', content: 'Two', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'Three', checked: false, depth: 0, parentIndex: null },
        { type: 'paragraph', content: 'One', checked: false, depth: 0, parentIndex: null }
      ])

      await reopenDocument(page, title)
      await expect.poll(() => getBodyBlockValues(page)).toEqual(['Two', 'Three', 'One'])
    })
  })

  test('deleting every block persists the store fallback paragraph', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const title = `Common delete all ${Date.now().toString(36)}`

    await withElectronApp(async ({ page }) => {
      const documentId = await createSavedRootDocument(page, title, 'Only body')
      await getBodyEditor(page, 0).press('Control+a')
      await getBodyEditor(page, 0).press('Control+a')
      await page.locator('.block-selection-toolbar').getByRole('button', { name: uiText('Delete', '删除') }).click()
      await expect(page.locator('textarea.block-inline-textarea')).toHaveCount(0)

      await expect.poll(() => page.evaluate(async (id) => {
        const detail = await window.knowbook.getDocumentDetail(id)
        return detail?.blocks.map((block) => ({ type: block.type, content: block.content })) ?? null
      }, documentId)).toEqual([{ type: 'paragraph', content: 'Start writing here.' }])
      await reopenDocument(page, title)
      await expect(page.locator('textarea.block-inline-textarea')).toHaveCount(1)
      await expect(page.locator('textarea.block-inline-textarea').first()).toHaveValue('Start writing here.')
    })
  })
})
