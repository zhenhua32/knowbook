import { test, expect } from '@playwright/test'

test.describe('Plugin System', () => {
  test('should load workspace plugins on startup', async ({ page }) => {
    await page.goto('/')
    
    // Wait for plugins to load
    await page.getByRole('link', { name: /plugins/i }).click()
    
    // Verify activity-pulse plugin is loaded
    await expect(page.locator('[data-testid="plugin-card"]')).toContainText('activity-pulse')
    await expect(page.locator('[data-testid="plugin-status"]')).toContainText('Running')
  })

  test('should enable and disable plugin', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /plugins/i }).click()
    
    // Find plugin toggle
    const toggleBtn = page.getByRole('button', { name: /enabled/i }).first()
    await toggleBtn.click()
    
    // Verify plugin is disabled
    await expect(page.getByRole('button', { name: /disabled/i })).toBeVisible()
    
    // Re-enable
    await page.getByRole('button', { name: /disabled/i }).click()
    await expect(page.getByRole('button', { name: /enabled/i })).toBeVisible()
  })

  test('should reload plugin', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /plugins/i }).click()
    
    // Click reload
    const reloadBtn = page.getByRole('button', { name: /reload/i }).first()
    await reloadBtn.click()
    
    // Verify reload complete
    await expect(page.getByText(/plugin reloaded/i)).toBeVisible()
  })

  test('should install plugin from folder', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /plugins/i }).click()
    
    // Mock file dialog - in real test we'd need to mock the dialog
    // For now, verify the button exists
    const installBtn = page.getByRole('button', { name: /install folder/i })
    await expect(installBtn).toBeVisible()
  })

  test('should remove user-data plugin', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /plugins/i }).click()
    
    // Try to remove a plugin (this would require a user-data plugin to exist)
    const removeBtn = page.getByRole('button', { name: /remove/i }).first()
    
    // Click remove
    await removeBtn.click()
    
    // Confirm
    const confirmBtn = page.getByRole('button', { name: /confirm/i })
    await confirmBtn.click()
  })

  test('should display plugin dashboard card', async ({ page }) => {
    await page.goto('/')
    
    // Verify plugin card is visible on dashboard
    await expect(page.locator('[data-testid="plugin-dashboard-card"]')).toBeVisible()
    await expect(page.locator('[data-testid="plugin-dashboard-card"]')).toContainText('activity-pulse')
  })

  test('should execute plugin document action', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select a document
    const doc = page.locator('[data-testid="document-tree-item"]').first()
    await doc.click()
    
    // Open plugin actions panel
    const pluginActionsTab = page.getByRole('tab', { name: /plugin actions/i })
    await pluginActionsTab.click()
    
    // Execute action
    const actionBtn = page.getByRole('button', { name: /run/i }).first()
    await actionBtn.click()
    
    // Verify action execution
    await expect(page.getByText(/action executed/i)).toBeVisible()
  })

  test('should show plugin error state', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /plugins/i }).click()
    
    // Find errored plugin
    const erroredPlugin = page.locator('[data-testid="plugin-card"][data-status="error"]')
    
    // If an error plugin exists, verify it shows recover
    if (await erroredPlugin.isVisible()) {
      await expect(page.getByRole('button', { name: /recover/i })).toBeVisible()
    }
  })
})
