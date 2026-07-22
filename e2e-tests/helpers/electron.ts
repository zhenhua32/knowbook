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
  await context?.app.close()
  if (context?.tempRoot) {
    rmSync(context.tempRoot, { recursive: true, force: true })
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
