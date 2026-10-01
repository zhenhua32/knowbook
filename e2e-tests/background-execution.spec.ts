import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('background Electron tests render, accept keyboard input and ignore foreground activation @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ app, page }) => {
    const nativeState = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
    await expect.poll(nativeState).toEqual([{ visible: false, focused: false, focusable: false }])
    await app.evaluate(({ app }) => { app.emit('second-instance', {}, [], process.cwd()) })
    await expect.poll(nativeState).toEqual([{ visible: false, focused: false, focusable: false }])

    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('General', '通用'), exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('tab', { name: 'AI', exact: true })).toBeFocused()
    const model = page.getByLabel(uiText('Model', '模型'))
    await model.fill('background-input-check')
    await expect(model).toHaveValue('background-input-check')
    await page.keyboard.press('Tab')
    await page.keyboard.press('F1')
    const help = page.getByRole('dialog', { name: uiText('Keyboard shortcuts', '快捷键帮助'), exact: true })
    await expect(help).toBeVisible()
    await expect(help.getByRole('searchbox', { name: uiText('Search shortcuts', '搜索快捷键') })).toBeFocused()
    const marker = await help.evaluate(dialog => {
      const marker = document.createElement('div')
      marker.setAttribute('aria-hidden', 'true')
      marker.style.cssText = 'position:absolute;left:0;top:0;width:40px;height:40px;background:rgb(17,173,39);pointer-events:none;z-index:99999'
      dialog.append(marker)
      const rect = marker.getBoundingClientRect()
      return { x: rect.x + 20, y: rect.y + 20, width: window.innerWidth }
    })
    const screenshot = await page.screenshot({ path: testInfo.outputPath('background-keyboard-dialog.png') })
    expect(screenshot.length).toBeGreaterThan(1_000)
    const scale = screenshot.readUInt32BE(16) / marker.width
    const color = await app.evaluate(({ nativeImage }, input) => {
      const image = nativeImage.createFromBuffer(Buffer.from(input.png, 'base64'))
      const bitmap = image.toBitmap()
      const position = (input.y * image.getSize().width + input.x) * 4
      return [...bitmap.subarray(position, position + 4)]
    }, { png: screenshot.toString('base64'), x: Math.round(marker.x * scale), y: Math.round(marker.y * scale) })
    expect(color).toEqual([39, 173, 17, 255])
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect.poll(nativeState).toEqual([{ visible: false, focused: false, focusable: false }])
    await page.reload()
    await expect(page.locator('[data-testid="shell"]')).toBeVisible()
    await expect.poll(nativeState).toEqual([{ visible: false, focused: false, focusable: false }])
  })
})
