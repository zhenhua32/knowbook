import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

// In Playwright, we can use process.cwd() which should be the project root
const projectRoot = process.cwd()

test.describe('KnowBook Build Validation', () => {
  test('should have valid package.json', async () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    )
    
    expect(packageJson.name).toBe('knowbook')
    expect(packageJson.version).toBeDefined()
    expect(packageJson.scripts?.build).toBeDefined()
    expect(packageJson.scripts?.test).toBeDefined()
  })

  test('should have valid tsconfig.json', async () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf8')
    )
    
    expect(tsconfig.compilerOptions?.target).toBeDefined()
    expect(tsconfig.compilerOptions?.module).toBeDefined()
  })

  test('should have out directory after build', async () => {
    const outDir = path.join(projectRoot, 'out')
    
    // This test assumes the project has been built
    if (fs.existsSync(outDir)) {
      const mainOut = path.join(outDir, 'main', 'index.js')
      const preloadOut = path.join(outDir, 'preload', 'index.mjs')
      const rendererOut = path.join(outDir, 'renderer', 'index.html')
      
      expect(fs.existsSync(mainOut)).toBe(true)
      expect(fs.existsSync(preloadOut)).toBe(true)
      expect(fs.existsSync(rendererOut)).toBe(true)
    } else {
      // Skip if not built
      test.skip()
    }
  })
})
