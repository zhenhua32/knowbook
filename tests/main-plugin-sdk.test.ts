const test = require('node:test').test
const assert = require('node:assert').strict
const { createManifest, validatePluginManifest } = require('../src/main/plugin-market')

test('createManifest creates valid manifest', () => {
  const manifest = createManifest({
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin',
    author: 'Test Author',
    entry: 'index.js',
    engines: { knowbook: '>=0.1.0' }
  })

  assert.equal(manifest['id'], 'test-plugin')
  assert.equal(manifest['name'], 'Test Plugin')
  assert.equal(manifest['version'], '1.0.0')
  assert.equal(manifest['description'], 'A test plugin')
  assert.equal(manifest['author'], 'Test Author')
  assert.equal(manifest['entry'], 'index.js')
  assert.deepEqual(manifest['engines'], { knowbook: '>=0.1.0' })
})

test('validatePluginManifest validates correct manifest', () => {
  const validManifest = {
    id: 'valid-plugin',
    name: 'Valid Plugin',
    version: '1.0.0',
    description: 'A valid plugin',
    author: 'Author',
    entry: 'index.js',
    engines: { knowbook: '>=0.1.0' }
  }

  assert.equal(validatePluginManifest(validManifest), true)
})

test('validatePluginManifest rejects invalid manifest - missing id', () => {
  const invalidManifest = {
    name: 'Invalid Plugin',
    version: '1.0.0'
  }

  assert.equal(validatePluginManifest(invalidManifest), false)
})

test('validatePluginManifest rejects invalid manifest - missing name', () => {
  const invalidManifest = {
    id: 'invalid-plugin',
    version: '1.0.0'
  }

  assert.equal(validatePluginManifest(invalidManifest), false)
})

test('validatePluginManifest rejects invalid manifest - missing version', () => {
  const invalidManifest = {
    id: 'invalid-plugin',
    name: 'Invalid Plugin'
  }

  assert.equal(validatePluginManifest(invalidManifest), false)
})

test('validatePluginManifest accepts manifest with optional fields missing', () => {
  const minimalManifest = {
    id: 'minimal-plugin',
    name: 'Minimal Plugin',
    version: '1.0.0'
  }

  assert.equal(validatePluginManifest(minimalManifest), true)
})

test('validatePluginManifest rejects manifest with wrong types', () => {
  const wrongTypesManifest = {
    id: 123, // should be string
    name: 'Wrong Types Plugin',
    version: '1.0.0'
  }

  assert.equal(validatePluginManifest(wrongTypesManifest), false)
})

test('validatePluginManifest rejects manifest with invalid engines type', () => {
  const manifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engines: 'should be object'
  }

  assert.equal(validatePluginManifest(manifest), false)
})

test('validatePluginManifest rejects manifest with invalid knowbook range', () => {
  const manifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engines: { knowbook: 123 }
  }

  assert.equal(validatePluginManifest(manifest), false)
})

test('createManifest creates manifest with engines', () => {
  const manifest = createManifest({
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    engines: { knowbook: '>=0.1.0' }
  })

  assert.equal(manifest['id'], 'my-plugin')
  assert.equal(manifest['name'], 'My Plugin')
  assert.equal(manifest['version'], '1.0.0')
  assert.deepEqual(manifest['engines'], { knowbook: '>=0.1.0' })
  assert.equal(validatePluginManifest(manifest), true)
})

test('Plugin SDK - KnowBookPlugin base class exists', () => {
  // Just verify the module can be imported
  const fs = require('fs')
  const path = require('path')
  const sdkPath = path.join(__dirname, '..', 'src', 'main', 'plugin-sdk.ts')
  
  // This is a structural test
  assert.equal(fs.existsSync(sdkPath), true)
  
  const content = fs.readFileSync(sdkPath, 'utf8')
  assert.ok(content.includes('class KnowBookPlugin'))
  assert.ok(content.includes('abstract activate'))
})

test('Plugin SDK - PluginApi type is exported', () => {
  const fs = require('fs')
  const path = require('path')
  const sdkPath = path.join(__dirname, '..', 'src', 'main', 'plugin-sdk.ts')
  
  const content = fs.readFileSync(sdkPath, 'utf8')
  assert.ok(content.includes('export type PluginApi'))
})
