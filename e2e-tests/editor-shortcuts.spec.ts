import { test, expect } from '@playwright/test'

test.describe('Editor Markdown Shortcuts', () => {
  test('should convert # to heading 1', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('# Heading One')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-heading-1"]')).toBeVisible()
  })

  test('should convert ## to heading 2', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('## Heading Two')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-heading-2"]')).toBeVisible()
  })

  test('should convert - [ ] to todo unchecked', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('- [ ] Task not done')
    await page.getByRole('button', { name: /save/i }).click()
    
    const todoBlock = page.locator('[data-testid="block-type-todo"]').first()
    await expect(todoBlock).toBeVisible()
    await expect(todoBlock).not.toHaveAttribute('data-checked', 'true')
  })

  test('should convert - [x] to todo checked', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('- [x] Task done')
    await page.getByRole('button', { name: /save/i }).click()
    
    const todoBlock = page.locator('[data-testid="block-type-todo"]').first()
    await expect(todoBlock).toBeVisible()
    await expect(todoBlock).toHaveAttribute('data-checked', 'true')
  })

  test('should convert > to quote', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('> This is a quote')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-quote"]')).toBeVisible()
  })

  test('should convert - to bulleted list', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('- List item 1')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-bulleted-list"]')).toBeVisible()
  })

  test('should convert 1. to numbered list', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('1. First item')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-numbered-list"]')).toBeVisible()
  })

  test('should convert $$ to math block', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('$$\nE = mc^2\n$$')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-math"]')).toBeVisible()
  })

  test('should convert --- to divider', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('---')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-divider"]')).toBeVisible()
  })

  test('should convert ``` to code block', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('```\nconst x = 1;\n```')
    await page.getByRole('button', { name: /save/i }).click()
    
    await expect(page.locator('[data-testid="block-type-code"]')).toBeVisible()
  })
})
