import { test, expect } from '@playwright/test'

test.describe('Document CRUD Operations', () => {
  test('should create a new root document', async ({ page }) => {
    await page.goto('/')
    
    // Wait for app to load
    await expect(page.locator('.shell')).toBeVisible()
    
    // Navigate to documents page
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Click "New Root" button
    const newRootBtn = page.getByRole('button', { name: /new root/i })
    await newRootBtn.click()
    
    // Verify a new document appears in the tree
    const documentTree = page.locator('[data-testid="document-tree"]')
    await expect(documentTree).toBeVisible()
  })

  test('should create child document', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select an existing document first
    const firstDoc = page.locator('[data-testid="document-tree-item"]').first()
    await firstDoc.click()
    
    // Click "Add child" button
    const addChildBtn = page.getByRole('button', { name: /add child/i })
    await addChildBtn.click()
    
    // Verify child document was created
    const childDoc = page.locator('[data-testid="document-child-item"]')
    await expect(childDoc).toBeVisible()
  })

  test('should edit document title and summary', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select a document
    const firstDoc = page.locator('[data-testid="document-tree-item"]').first()
    await firstDoc.click()
    
    // Enter edit mode
    const editBtn = page.getByRole('button', { name: /edit/i })
    await editBtn.click()
    
    // Edit title
    const titleInput = page.getByPlaceholder(/title/i)
    await titleInput.fill('Test Document Title')
    
    // Edit summary
    const summaryInput = page.getByPlaceholder(/summary/i)
    await summaryInput.fill('Test document summary content.')
    
    // Save
    const saveBtn = page.getByRole('button', { name: /save/i })
    await saveBtn.click()
    
    // Verify changes persisted
    await expect(page.getByText('Test Document Title')).toBeVisible()
  })

  test('should delete document', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select a document
    const firstDoc = page.locator('[data-testid="document-tree-item"]').first()
    await firstDoc.click()
    
    // Open delete dialog
    const deleteBtn = page.getByRole('button', { name: /delete/i })
    await deleteBtn.click()
    
    // Confirm deletion
    const confirmBtn = page.getByRole('button', { name: /confirm/i })
    await confirmBtn.click()
    
    // Verify document is removed
    await expect(firstDoc).not.toBeVisible()
  })

  test('should move document to different parent', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select a document to move
    const docToMove = page.locator('[data-testid="document-tree-item"]').nth(1)
    await docToMove.click()
    
    // Click "Move to" dropdown
    const moveToBtn = page.getByRole('button', { name: /move to/i })
    await moveToBtn.click()
    
    // Select new parent (root)
    const rootOption = page.getByRole('option', { name: /root/i })
    await rootOption.click()
    
    // Verify document is now under root
    const rootFolder = page.locator('[data-testid="root-folder"]')
    await expect(rootFolder).toContainText(docToMove.textContent())
  })
})

test.describe('Block Editor Operations', () => {
  test('should create blocks with Markdown shortcuts', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    
    // Select a document
    const firstDoc = page.locator('[data-testid="document-tree-item"]').first()
    await firstDoc.click()
    
    // Enter edit mode
    await page.getByRole('button', { name: /edit/i }).click()
    
    // Type Markdown shortcuts
    const editor = page.locator('[data-testid="block-editor"]')
    
    // Create heading
    await editor.fill('# Heading One\n')
    
    // Create todo
    await editor.press('Enter')
    await editor.fill('- [ ] Todo item')
    
    // Create code block
    await editor.press('Enter')
    await editor.fill('```\nconsole.log("hello")\n```')
    
    // Save and verify
    await page.getByRole('button', { name: /save/i }).click()
    
    // Verify blocks were created
    await expect(page.locator('[data-testid="block-type-heading-1"]')).toBeVisible()
    await expect(page.locator('[data-testid="block-type-todo"]')).toBeVisible()
    await expect(page.locator('[data-testid="block-type-code"]')).toBeVisible()
  })

  test('should convert block types', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    
    // Create a paragraph
    await editor.fill('This is a paragraph')
    
    // Select the block and convert to heading
    await page.getByRole('button', { name: /convert/i }).click()
    await page.getByRole('option', { name: /heading 1/i }).click()
    
    // Verify conversion
    await expect(page.locator('[data-testid="block-type-heading-1"]')).toBeVisible()
    await page.getByRole('button', { name: /save/i }).click()
  })

  test('should drag and drop blocks', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    // Create multiple blocks
    const editor = page.locator('[data-testid="block-editor"]')
    await editor.fill('Block 1\nBlock 2\nBlock 3')
    
    // Drag block 2 before block 1
    const block2 = page.locator('[data-testid="block-item"]').nth(1)
    const block1 = page.locator('[data-testid="block-item"]').first()
    
    await block2.dragTo(block1)
    
    // Verify order changed
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.locator('[data-testid="block-item"]').first()).toContainText('Block 2')
  })

  test('should indent and outdent blocks', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /documents/i }).click()
    await page.getByRole('button', { name: /edit/i }).click()
    
    const editor = page.locator('[data-testid="block-editor"]')
    
    // Create a list item
    await editor.fill('- List item')
    
    // Select and indent
    await page.getByRole('button', { name: /indent/i }).click()
    
    // Verify indentation
    const block = page.locator('[data-testid="block-item"]')
    await expect(block).toHaveAttribute('data-depth', '1')
    
    // Outdent
    await page.getByRole('button', { name: /outdent/i }).click()
    await expect(block).toHaveAttribute('data-depth', '0')
    
    await page.getByRole('button', { name: /save/i }).click()
  })
})
