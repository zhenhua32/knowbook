import { expect, type Page } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ElectronAppContext = {
  app: ElectronApplication
  page: Page
  tempRoot: string
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const builtMainEntry = join(repoRoot, 'out', 'main', 'index.js')

export function hasBuiltElectronApp(): boolean {
  return existsSync(builtMainEntry)
}

export function uiText(en: string, zh: string): RegExp {
  return new RegExp(`^(?:${escapeForRegExp(en)}|${escapeForRegExp(zh)})$`, 'i')
}

export async function ensureDocumentMetadataEditor(page: Page): Promise<void> {
  const titleInput = page.locator('.document-summary-card .editor-input').first()
  if (!await titleInput.isVisible().catch(() => false)) {
    const editButton = page.locator('.document-summary-edit-button')
    await expect(editButton).toBeVisible()
    await editButton.click()
  }
  await expect(titleInput).toBeVisible()
}

export async function launchElectronApp(): Promise<ElectronAppContext> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-e2e-'))
  const app = await electron.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu', '.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      APPDATA: tempRoot,
      LOCALAPPDATA: tempRoot,
      KNOWBOOK_ALLOW_PRIVATE_WEB_CLIP: '1',
      KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1',
      KNOWBOOK_E2E_EPHEMERAL_CREDENTIAL_STORAGE: '1',
      KNOWBOOK_USER_DATA_DIR: tempRoot
    }
  })

  const page = await app.firstWindow()
  page.on('console', (message) => console.error(`[renderer:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.error('[renderer:pageerror]', error))
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="shell"]')).toBeVisible()

  return { app, page, tempRoot }
}

export async function closeElectronApp(context: Pick<ElectronAppContext, 'app' | 'tempRoot'> | null): Promise<void> {
  if (!context) {
    return
  }

  const childProcess = context.app.process()
  let closeTimer: NodeJS.Timeout | undefined
  const closedGracefully = await Promise.race([
    context.app.close().then(() => true, () => false),
    new Promise<boolean>((resolve) => {
      closeTimer = setTimeout(() => resolve(false), 5_000)
    })
  ])
  if (closeTimer) {
    clearTimeout(closeTimer)
  }

  if (!closedGracefully && childProcess.exitCode === null && childProcess.signalCode === null) {
    const processExited = new Promise<void>((resolve) => {
      childProcess.once('exit', () => resolve())
    })
    childProcess.kill('SIGKILL')
    let killTimer: NodeJS.Timeout | undefined
    await Promise.race([
      processExited,
      new Promise<void>((resolve) => {
        killTimer = setTimeout(resolve, 5_000)
      })
    ])
    if (killTimer) {
      clearTimeout(killTimer)
    }
  }

  if (context.tempRoot) {
    rmSync(context.tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })
  }
}

export async function withElectronApp(run: (context: ElectronAppContext) => Promise<void>): Promise<void> {
  const context = await launchElectronApp()
  try {
    await run(context)
  } finally {
    await closeElectronApp(context)
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
