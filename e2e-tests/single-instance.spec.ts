import { spawn } from 'node:child_process'
import electronPath from 'electron'
import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

test.describe('Single instance protection @electron', () => {
  test('a duplicate process exits and keeps the primary window available', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page, tempRoot }) => {
      const duplicate = spawn(electronPath as unknown as string, [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--in-process-gpu',
        '.'
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APPDATA: tempRoot,
          LOCALAPPDATA: tempRoot,
          KNOWBOOK_ALLOW_PRIVATE_WEB_CLIP: '1',
          KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1',
          KNOWBOOK_USER_DATA_DIR: tempRoot
        },
        stdio: 'ignore',
        windowsHide: true
      })

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          duplicate.kill()
          reject(new Error('Duplicate KnowBook process did not exit after losing the single-instance lock.'))
        }, 10_000)

        duplicate.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        duplicate.once('exit', (code) => {
          clearTimeout(timeout)
          resolve(code)
        })
      })

      expect(exitCode).toBe(0)
      await expect(page.locator('[data-testid="shell"]')).toBeVisible()
    })
  })
})
