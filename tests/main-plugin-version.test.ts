import test from 'node:test'
import assert from 'node:assert/strict'
import { isPluginVersionCompatible, getVersionCompatibilityMessage } from '../src/main/plugin-version'

test('isPluginVersionCompatible returns true when engines is missing', () => {
  assert.equal(isPluginVersionCompatible({}, '0.1.0'), true)
  assert.equal(isPluginVersionCompatible({ engines: {} }, '0.1.0'), true)
})

test('isPluginVersionCompatible respects exact version', () => {
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '0.1.0' } }, '0.1.0'),
    true
  )
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '0.2.0' } }, '0.1.0'),
    false
  )
})

test('isPluginVersionCompatible supports semver ranges', () => {
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '>=0.1.0' } }, '0.1.0'),
    true
  )
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '>=0.1.0' } }, '0.2.0'),
    true
  )
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '>=0.2.0' } }, '0.1.0'),
    false
  )
})

test('isPluginVersionCompatible supports caret range', () => {
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '^0.1.0' } }, '0.1.0'),
    true
  )
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '^0.1.0' } }, '0.1.5'),
    true
  )
  assert.equal(
    isPluginVersionCompatible({ engines: { knowbook: '^0.1.0' } }, '0.2.0'),
    false
  )
})

test('getVersionCompatibilityMessage returns null when compatible', () => {
  assert.equal(
    getVersionCompatibilityMessage({ engines: { knowbook: '>=0.1.0' } }, '0.1.0'),
    null
  )
})

test('getVersionCompatibilityMessage returns message when incompatible', () => {
  const message = getVersionCompatibilityMessage(
    { engines: { knowbook: '>=0.2.0' } },
    '0.1.0'
  )
  assert.ok(message !== null)
  assert.ok(message!.includes('0.2.0'))
  assert.ok(message!.includes('0.1.0'))
})
