import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const builtMainEntry = join(repoRoot, 'out', 'main', 'index.js')

function uiText(en: string, zh: string): RegExp {
  return new RegExp(`^(?:${escapeForRegExp(en)}|${escapeForRegExp(zh)})$`, 'i')
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page; tempRoot: string }> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      APPDATA: tempRoot,
      LOCALAPPDATA: tempRoot
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="shell"]')).toBeVisible()
  return { app, page, tempRoot }
}

async function closeApp(app: ElectronApplication | null, tempRoot: string | null): Promise<void> {
  await app?.close()
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function openDatabasePage(page: Page): Promise<void> {
  await page.getByTitle(uiText('Database', '数据库')).click()
  await expect(page.locator('[data-testid="database-grid"]')).toBeVisible()
}

function getDatabaseButton(page: Page, databaseName: string) {
  return page.getByRole('button', { name: databaseName }).last()
}

async function addTextColumn(page: Page, columnName: string): Promise<void> {
  await page.getByRole('button', { name: uiText('Add column', '新增列') }).click()
  await page.getByLabel(uiText('Column name', '列名')).fill(columnName)
  await page.getByRole('button', { name: uiText('Save column', '保存列') }).click()
  await expect(page.getByRole('button', { name: uiText('Add column', '新增列') })).toBeVisible()
}

async function createDatabase(page: Page, databaseName: string, description: string): Promise<void> {
  await page.getByRole('button', { name: uiText('Add database', '新增数据库') }).click()
  await page.getByLabel(uiText('Database name', '数据库名称')).fill(databaseName)
  await page.getByLabel(uiText('Description', '描述')).fill(description)
  await page.getByRole('button', { name: uiText('Create database', '创建数据库') }).click()
  await expect(getDatabaseButton(page, databaseName)).toBeVisible()
}

async function expectSchemaColumnNames(page: Page, expectedNames: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const values = await page.locator('.database-schema-name-input').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value)
      )
      return [...new Set(values)].sort()
    })
    .toEqual([...expectedNames].sort())
}

test.describe('Database Views', () => {
  test('isolates schema columns between the default database and an independent database', async () => {
    test.skip(!existsSync(builtMainEntry), 'Built Electron app not found. Run npm run build before E2E tests.')

    let app: ElectronApplication | null = null
    let tempRoot: string | null = null

    try {
      const launched = await launchApp()
      app = launched.app
      tempRoot = launched.tempRoot

      await openDatabasePage(launched.page)
      await getDatabaseButton(launched.page, 'Default').click()

      await addTextColumn(launched.page, 'Status')
      await expectSchemaColumnNames(launched.page, ['Status'])

      await createDatabase(launched.page, 'Projects', 'Project tracking')
      await getDatabaseButton(launched.page, 'Projects').click()
      await expectSchemaColumnNames(launched.page, [])

      await addTextColumn(launched.page, 'Owner')
      await expectSchemaColumnNames(launched.page, ['Owner'])

      const entityForm = launched.page.locator('.database-entity-field-grid-form')
      await expect(entityForm).toContainText('Owner')
      await expect(entityForm).not.toContainText('Status')

      await getDatabaseButton(launched.page, 'Default').click()
      await expectSchemaColumnNames(launched.page, ['Status'])
      await expect(entityForm).toContainText('Status')
      await expect(entityForm).not.toContainText('Owner')
    } finally {
      await closeApp(app, tempRoot)
    }
  })
})