import { test, expect } from '@playwright/test'

test.describe('AI Automation Features', () => {
  test('should configure AI settings', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /ai settings/i }).click()
    
    // Enable AI
    const enableToggle = page.getByRole('checkbox', { name: /enable ai features/i })
    await enableToggle.check()
    
    // Fill API configuration
    const baseUrlInput = page.getByPlaceholder(/base url/i)
    await baseUrlInput.fill('https://api.openai.com/v1')
    
    const modelInput = page.getByPlaceholder(/model/i)
    await modelInput.fill('gpt-4')
    
    const embeddingInput = page.getByPlaceholder(/embedding model/i)
    await embeddingInput.fill('text-embedding-3-small')
    
    const apiKeyInput = page.getByPlaceholder(/api key/i)
    await apiKeyInput.fill('test-api-key')
    
    // Save settings
    const saveBtn = page.getByRole('button', { name: /save ai settings/i })
    await saveBtn.click()
    
    // Verify settings saved
    await expect(page.getByText(/ai settings saved/i)).toBeVisible()
  })

  test('should enable auto-summary on save', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /ai settings/i }).click()
    
    // Enable auto-summary
    const autoSummaryToggle = page.getByRole('checkbox', { name: /auto summary when empty/i })
    await autoSummaryToggle.check()
    
    // Save AI settings
    await page.getByRole('button', { name: /save ai settings/i }).click()
    
    // Create a document
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /new root/i }).click()
    
    // Edit document with content
    await page.getByRole('button', { name: /edit/i }).click()
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('This is a test document with some content that should be summarized automatically when saved.')
    
    await page.getByRole('button', { name: /save/i }).click()
    
    // Wait for auto-summary
    await page.waitForTimeout(2000)
    
    // Verify summary was generated
    const summary = page.locator('[data-testid="document-summary"]')
    await expect(summary).not.toContainText('New knowledge node ready for editing')
  })

  test('should run document AI automations manually', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /ai settings/i }).click()
    
    // Enable automations
    await page.getByRole('checkbox', { name: /auto summary when empty/i }).check()
    await page.getByRole('checkbox', { name: /auto tag on save/i }).check()
    await page.getByRole('checkbox', { name: /auto highlight on save/i }).check()
    await page.getByRole('button', { name: /save ai settings/i }).click()
    
    // Select a document
    await page.getByRole('link', { name: /documents/i }).click()
    const doc = page.locator('[data-testid="document-tree-item"]').first()
    await doc.click()
    
    // Run automations
    const runAutomationsBtn = page.getByRole('button', { name: /run enabled automations/i })
    await runAutomationsBtn.click()
    
    // Verify automation result
    await expect(page.getByText(/ai automation updated:/i)).toBeVisible()
  })

  test('should generate document summary via AI', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select document
    const doc = page.locator('[data-testid="document-tree-item"]').first()
    await doc.click()
    
    // Switch to AI panel
    await page.getByRole('link', { name: /ask ai/i }).click()
    
    // Find related notes
    const findRelatedBtn = page.getByRole('button', { name: /find related notes/i })
    await findRelatedBtn.click()
    
    // Ask question
    const askInput = page.getByPlaceholder(/for example/i)
    await askInput.fill('Give me 3 key suggestions for this document')
    
    const askBtn = page.getByRole('button', { name: /ask ai/i })
    await askBtn.click()
    
    // Wait for response
    await expect(page.locator('[data-testid="ai-response"]')).toBeVisible()
  })

  test('should generate block tags automatically', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Create document with untagged blocks
    await page.getByRole('button', { name: /new root/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('This is a todo item about project planning\n- Another task about development')
    
    await page.getByRole('button', { name: /save/i }).click()
    
    // Run automations
    await page.getByRole('link', { name: /ai settings/i }).click()
    await page.getByRole('checkbox', { name: /auto tag on save/i }).check()
    await page.getByRole('button', { name: /save ai settings/i }).click()
    
    await page.getByRole('link', { name: /documents/i }).click()
    const doc = page.locator('[data-testid="document-tree-item"]').first()
    await doc.click()
    await page.getByRole('button', { name: /run enabled automations/i }).click()
    
    // Verify tags were generated
    await expect(page.locator('[data-testid="block-tag"]')).toBeVisible()
  })

  test('should generate block highlights', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Create document
    await page.getByRole('button', { name: /new root/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('This is an important point about the project.\nThis is less critical information.')
    
    await page.getByRole('button', { name: /save/i }).click()
    
    // Run automations
    await page.getByRole('link', { name: /ai settings/i }).click()
    await page.getByRole('checkbox', { name: /auto highlight on save/i }).check()
    await page.getByRole('button', { name: /save ai settings/i }).click()
    
    await page.getByRole('link', { name: /documents/i }).click()
    const doc = page.locator('[data-testid="document-tree-item"]').first()
    await doc.click()
    await page.getByRole('button', { name: /run enabled automations/i }).click()
    
    // Verify highlights were generated
    const highlightedBlocks = page.locator('[data-testid="block-item"]').filter({ has: page.locator('[data-testid="block-highlight"]') })
    await expect(highlightedBlocks.first()).toBeVisible()
  })
})
