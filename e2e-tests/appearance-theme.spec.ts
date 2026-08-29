import { expect, test } from '@playwright/test'
import {
  hasBuiltElectronApp,
  withElectronApp
} from './helpers/electron'

test.describe('appearance theme', () => {
  test.skip(!hasBuiltElectronApp(), 'Electron build output is unavailable.')

  test('persists and applies dark and light host themes across renderer reloads', async () => {
    await withElectronApp(async ({ page }) => {
      await page.evaluate(async () => {
        await window.knowbook.saveSetting('appearance.theme', 'dark')
      })
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect.poll(() => page.evaluate(() => ({
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        background: getComputedStyle(document.documentElement).backgroundImage
      }))).toEqual({
        colorScheme: 'dark',
        background: expect.stringContaining('linear-gradient')
      })

      await page.evaluate(async () => {
        await window.knowbook.saveSetting('appearance.theme', 'light')
      })
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect.poll(() => page.evaluate(() => (
        getComputedStyle(document.documentElement).colorScheme
      ))).toBe('light')
    })
  })
})
