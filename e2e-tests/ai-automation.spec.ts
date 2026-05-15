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

})
