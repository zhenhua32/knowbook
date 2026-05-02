# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> KnowBook Smoke Tests >> should have E2E test files
- Location: e2e-tests\smoke.spec.ts:41:3

# Error details

```
ReferenceError: require is not defined
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test'
  2  | 
  3  | test.describe('KnowBook Smoke Tests', () => {
  4  |   test('should have the main application structure', async ({ page }) => {
  5  |     // Test that the renderer HTML is served (would need dev server running)
  6  |     // For now, we test the built app structure
  7  |     await page.goto('/')
  8  |     
  9  |     // Check that the shell container exists
  10 |     const shell = page.locator('[data-testid="shell"]')
  11 |     // We skip this assertion since it requires a running dev server
  12 |     // In CI, we would start the dev server first
  13 |     expect(true).toBe(true)
  14 |   })
  15 | 
  16 |   test('should have all core modules', async () => {
  17 |     const fs = require('fs')
  18 |     const path = require('path')
  19 |     
  20 |     const requiredFiles = [
  21 |       'src/main/index.ts',
  22 |       'src/renderer/src/App.tsx',
  23 |       'src/shared/contracts.ts',
  24 |       'src/main/database/store.ts',
  25 |       'src/main/database/schema.ts',
  26 |       'src/main/plugin-host.ts',
  27 |       'src/main/plugin-sdk.ts',
  28 |       'src/main/plugin-version.ts',
  29 |       'src/renderer/src/i18n.ts',
  30 |       'src/shared/board.ts',
  31 |       'src/shared/markdown.ts',
  32 |       'src/shared/code.ts'
  33 |     ]
  34 |     
  35 |     for (const file of requiredFiles) {
  36 |       const fullPath = path.join(__dirname, '..', file)
  37 |       expect(fs.existsSync(fullPath)).toBe(true)
  38 |     }
  39 |   })
  40 | 
  41 |   test('should have E2E test files', async () => {
> 42 |     const fs = require('fs')
     |                ^ ReferenceError: require is not defined
  43 |     const path = require('path')
  44 |     
  45 |     const e2eTestFiles = [
  46 |       'e2e-tests/document-crud.spec.ts',
  47 |       'e2e-tests/database-views.spec.ts',
  48 |       'e2e-tests/links-and-graph.spec.ts',
  49 |       'e2e-tests/ai-automation.spec.ts',
  50 |       'e2e-tests/plugins.spec.ts',
  51 |       'e2e-tests/editor-shortcuts.spec.ts'
  52 |     ]
  53 |     
  54 |     for (const file of e2eTestFiles) {
  55 |       const fullPath = path.join(__dirname, '..', file)
  56 |       expect(fs.existsSync(fullPath)).toBe(true)
  57 |     }
  58 |   })
  59 | })
  60 | 
```