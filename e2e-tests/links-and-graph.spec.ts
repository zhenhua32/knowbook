import { test, expect } from '@playwright/test'

test.describe('Links and Knowledge Graph', () => {
  test('should create document link', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    
    // Type a link to another document
    await editor.fill('See [[Test Document]] for more info')
    
    // Save
    await page.getByRole('button', { name: /save/i }).click()
    
    // Verify link is rendered
    await expect(page.locator('[data-testid="document-link"]')).toBeVisible()
    await expect(page.locator('[data-testid="document-link"]')).toContainText('Test Document')
  })

  test('should create block-level reference', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Navigate to target document and copy block ID
    const targetDoc = page.locator('[data-testid="document-tree-item"]').first()
    await targetDoc.click()
    
    // Add a block
    await page.getByRole('button', { name: /edit/i }).click()
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('Reference this block')
    await page.getByRole('button', { name: /save/i }).click()
    
    // Get block ID
    const blockId = await page.locator('[data-testid="block-item"]').first().getAttribute('data-block-id')
    
    // Navigate to another document
    const secondDoc = page.locator('[data-testid="document-tree-item"]').nth(1)
    await secondDoc.click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    // Create document-level link using block ID
    await editor.fill(`See [[${blockId}]]`)
    await page.getByRole('button', { name: /save/i }).click()
    
    // Verify block reference is rendered
    await expect(page.locator('[data-testid="block-reference"]')).toBeVisible()
  })

  test('should navigate via link click', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Click a document link in the editor
    const link = page.locator('[data-testid="document-link"]').first()
    await link.click()
    
    // Verify navigation occurred
    await expect(page.locator('[data-testid="document-preview"]')).toBeVisible()
  })

  test('should show backlinks panel', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select a document
    const doc = page.locator('[data-testid="document-tree-item"]').first()
    await doc.click()
    
    // Open backlinks panel
    const backlinksTab = page.getByRole('tab', { name: /backlinks/i })
    await backlinksTab.click()
    
    // Verify backlinks are shown
    await expect(page.locator('[data-testid="backlinks-list"]')).toBeVisible()
  })

  test('should display knowledge graph', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /graph/i }).click()
    
    // Wait for graph to render
    const graphContainer = page.locator('[data-testid="knowledge-graph"]')
    await expect(graphContainer).toBeVisible()
    
    // Verify graph has nodes
    const nodes = page.locator('[data-testid="graph-node"]')
    await expect(nodes).toHaveCountGreaterThan(0)
    
    // Verify graph has edges (links)
    const edges = page.locator('[data-testid="graph-edge"]')
    await expect(edges).toBeVisible()
  })

  test('should highlight graph node on hover', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /graph/i }).click()
    
    // Hover over a node
    const node = page.locator('[data-testid="graph-node"]').first()
    await node.hover()
    
    // Verify highlight effect
    await expect(node).toHaveCSS('filter', 'brightness(1.2)')
  })
})
