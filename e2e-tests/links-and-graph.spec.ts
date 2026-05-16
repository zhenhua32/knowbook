import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

function getTitleInput(page: Page): Locator {
  return page.locator('.document-summary-card .editor-input').first()
}

function getBodyEditor(page: Page): Locator {
  return page.locator('textarea.block-inline-textarea').nth(1)
}

function getPreviewTitle(page: Page): Locator {
  return page.locator('.preview-panel .panel-head h3')
}

function getTreeButton(page: Page, title: string): Locator {
  return page.locator('.tree-button', { hasText: title }).first()
}

async function createRootDocument(page: Page, title: string, body: string): Promise<void> {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
  await getTitleInput(page).fill(title)
  await getBodyEditor(page).fill(body)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(getPreviewTitle(page)).toHaveText(title)
}

async function openDocument(page: Page, title: string): Promise<void> {
  await getTreeButton(page, title).click()
  await expect(getPreviewTitle(page)).toHaveText(title)
}

async function ensureAuxPanelVisible(page: Page): Promise<void> {
  const relationGrid = page.locator('.relation-grid')

  if (await relationGrid.isVisible().catch(() => false)) {
    return
  }

  const showAuxButton = page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') })
  if (await showAuxButton.isVisible().catch(() => false)) {
    await showAuxButton.click()
  }

  await expect(relationGrid).toBeVisible()
}

async function openGraphPage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Graph', '图谱')).click()
  await expect(page.locator('[data-testid="graph-grid"]')).toBeVisible()
}

async function seedLinkedDocuments(page: Page, suffix: string): Promise<{ sourceTitle: string; targetTitle: string }> {
  const targetTitle = `Graph Target ${suffix}`
  const sourceTitle = `Graph Source ${suffix}`

  await createRootDocument(page, targetTitle, 'Target body for graph tests')
  await createRootDocument(page, sourceTitle, `Follow [[${targetTitle}]] from this note`)

  return { sourceTitle, targetTitle }
}

test.describe('Links and Knowledge Graph @electron', () => {
  test('follows a document link with Ctrl+Click inside the editor', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      const { sourceTitle, targetTitle } = await seedLinkedDocuments(page, suffix)
      await openDocument(page, sourceTitle)

      const editor = getBodyEditor(page)
      const tokenStart = `Follow [[${targetTitle}]] from this note`.indexOf(`[[${targetTitle}]]`) + 2
      await editor.evaluate((element, cursorPosition) => {
        const textarea = element as HTMLTextAreaElement
        textarea.focus()
        textarea.setSelectionRange(cursorPosition, cursorPosition)
        textarea.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
      }, tokenStart)

      await expect(getPreviewTitle(page)).toHaveText(targetTitle)
    })
  })

  test('shows backlinks for a linked document in the auxiliary panel', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      const { sourceTitle, targetTitle } = await seedLinkedDocuments(page, suffix)
      await openDocument(page, targetTitle)
      await ensureAuxPanelVisible(page)

      await expect(page.locator('.relation-grid')).toContainText(sourceTitle)
    })
  })

  test('renders graph nodes and link edges for linked documents', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      const { sourceTitle, targetTitle } = await seedLinkedDocuments(page, suffix)
      await openGraphPage(page)

      await expect(page.locator('.graph-node-label', { hasText: targetTitle })).toBeVisible()
      await expect(page.locator('.graph-node-label', { hasText: sourceTitle })).toBeVisible()
      await expect(page.locator('.graph-edge-link').first()).toBeVisible()
    })
  })

  test('opens the target document when clicking a graph node', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const suffix = Date.now().toString(36)

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      const { targetTitle } = await seedLinkedDocuments(page, suffix)
      await openGraphPage(page)

      await page.locator('.graph-surface').evaluate((surface, title) => {
        const groups = Array.from(surface.querySelectorAll<SVGGElement>('.graph-node-group'))
        const targetGroup = groups.find((group) =>
          group.querySelector('.graph-node-label')?.textContent?.trim() === title
        )

        if (!targetGroup) {
          throw new Error(`Graph node not found: ${title}`)
        }

        targetGroup.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }, targetTitle)

      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
      await expect(getPreviewTitle(page)).toHaveText(targetTitle)
    })
  })
})
