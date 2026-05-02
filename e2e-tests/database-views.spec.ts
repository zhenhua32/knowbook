import { test, expect } from '@playwright/test'

test.describe('Database Views', () => {
  test('should create database column', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Click "Add column" button
    const addColumnBtn = page.getByRole('button', { name: /add column/i })
    await addColumnBtn.click()
    
    // Fill column details
    const nameInput = page.getByPlaceholder(/column name/i)
    await nameInput.fill('Status')
    
    const typeSelect = page.locator('[data-testid="column-type-select"]')
    await typeSelect.selectOption('select')
    
    const optionsInput = page.getByPlaceholder(/options/i)
    await optionsInput.fill('Todo, In Progress, Done')
    
    // Save column
    const saveBtn = page.getByRole('button', { name: /save column/i })
    await saveBtn.click()
    
    // Verify column was created
    await expect(page.locator('[data-testid="database-column"]')).toContainText('Status')
  })

  test('should edit database values in table view', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /database/i }).click()
    
    // Select a document row
    const firstRow = page.locator('[data-testid="document-row"]').first()
    await firstRow.click()
    
    // Click on a cell to edit
    const statusCell = page.locator('[data-testid="cell-status"]').first()
    await statusCell.click()
    
    // Select a value
    const optionTodo = page.getByRole('option', { name: /todo/i })
    await optionTodo.click()
    
    // Verify value was saved
    await expect(statusCell).toContainText('Todo')
  })

  test('should filter documents in table view', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /database/i }).click()
    
    // Type in search box
    const searchInput = page.getByPlaceholder(/search documents/i)
    await searchInput.fill('test')
    
    // Verify only matching documents are shown
    const rows = page.locator('[data-testid="document-row"]')
    await expect(rows).toHaveCount(1)
  })

  test('should group documents in board view', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /database/i }).click()
    
    // Switch to board view
    const boardViewBtn = page.getByRole('button', { name: /board view/i })
    await boardViewBtn.click()
    
    // Group by status column
    const groupBySelect = page.locator('[data-testid="group-by-select"]')
    await groupBySelect.selectOption('status')
    
    // Verify columns are created
    const columns = page.locator('[data-testid="board-column"]')
    await expect(columns).toHaveCount(3) // Todo, In Progress, Done
  })

  test('should drag document between board columns', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /database/i }).click()
    await page.getByRole('button', { name: /board view/i }).click()
    
    // Drag document from Todo to Done
    const todoColumn = page.locator('[data-testid="board-column"]').filter({ hasText: 'Todo' })
    const doneColumn = page.locator('[data-testid="board-column"]').filter({ hasText: 'Done' })
    
    const documentCard = todoColumn.locator('[data-testid="document-card"]').first()
    const doneHeader = doneColumn.locator('[data-testid="column-header"]')
    
    await documentCard.dragTo(doneHeader)
    
    // Verify document moved to Done column
    await expect(doneColumn.locator('[data-testid="document-card"]')).toHaveCount(1)
    await expect(todoColumn.locator('[data-testid="document-card"]')).toHaveCount(0)
  })

  test('should rename database column', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Click column settings
    const columnMenu = page.getByRole('button', { name: /column options/i }).first()
    await columnMenu.click()
    
    // Click rename
    const renameBtn = page.getByRole('menuitem', { name: /rename/i })
    await renameBtn.click()
    
    // Enter new name
    const renameInput = page.getByPlaceholder(/new column name/i)
    await renameInput.fill('New Status')
    
    const confirmBtn = page.getByRole('button', { name: /confirm/i })
    await confirmBtn.click()
    
    // Verify column renamed
    await expect(page.locator('[data-testid="database-column"]')).toContainText('New Status')
  })

  test('should delete database column', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Click column settings
    const columnMenu = page.getByRole('button', { name: /column options/i }).first()
    await columnMenu.click()
    
    // Click delete
    const deleteBtn = page.getByRole('menuitem', { name: /delete/i })
    await deleteBtn.click()
    
    // Confirm deletion
    const confirmBtn = page.getByRole('button', { name: /confirm/i })
    await confirmBtn.click()
    
    // Verify column deleted
    await expect(page.locator('[data-testid="database-column"]')).not.toBeVisible()
  })
})
