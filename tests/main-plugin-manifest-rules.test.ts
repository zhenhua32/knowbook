import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePluginManifest } from '../src/main/plugin-market.ts'
import { findPluginManifestIssue, normalizePluginManifest } from '../src/main/plugin-manifest-rules.ts'

const validManifest = {
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.2.3',
  entry: 'lib/main.js',
  enabledByDefault: false,
  engines: { knowbook: '>=0.1.0' }
}

test('marketplace manifest validation enforces the same rules as the plugin host parser', () => {
  assert.equal(validatePluginManifest(validManifest), true)

  const rejectedCases: Array<[string, Record<string, unknown>]> = [
    ['traversal id', { ...validManifest, id: '../evil' }],
    ['dot id', { ...validManifest, id: '.' }],
    ['dot-dot id', { ...validManifest, id: '..' }],
    ['illegal id characters', { ...validManifest, id: 'my plugin!' }],
    ['non-semver version', { ...validManifest, version: 'not-a-version' }],
    ['invalid engine range', { ...validManifest, engines: { knowbook: 'not-a-range' } }],
    ['absolute entry', { ...validManifest, entry: '/etc/passwd' }],
    ['parent entry', { ...validManifest, entry: '../outside.js' }],
    ['blank entry segments', { ...validManifest, entry: './' }]
  ]

  for (const [label, manifest] of rejectedCases) {
    assert.equal(validatePluginManifest(manifest), false, `expected rejection: ${label}`)
  }
})

test('manifest rule helpers report precise issues and normalize accepted manifests', () => {
  assert.equal(findPluginManifestIssue(validManifest), null)

  const normalized = normalizePluginManifest(validManifest)
  assert.ok(normalized)
  assert.equal(normalized?.entry, 'lib/main.js')
  assert.equal(normalized?.enabledByDefault, false)
  assert.deepEqual(normalized?.engines, { knowbook: '>=0.1.0' })

  assert.match(findPluginManifestIssue({ ...validManifest, id: '../evil' }) ?? '', /id/i)
  assert.match(findPluginManifestIssue({ ...validManifest, version: 'nope' }) ?? '', /semantic version/i)
  assert.match(findPluginManifestIssue({ ...validManifest, entry: '../x.js' }) ?? '', /entry/i)
  assert.match(findPluginManifestIssue({ ...validManifest, engines: { knowbook: 'zzz' } }) ?? '', /range/i)
  assert.match(findPluginManifestIssue({}) ?? '', /id, name, and version/i)
  assert.equal(normalizePluginManifest({ ...validManifest, name: '' }), null)
})
