import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildPluginRevisionPackage,
  PluginRevisionStore
} from '../src/main/plugin-platform/index.ts'

test('revision packages normalize semantic input into one deterministic hash', () => {
  const first = buildPluginRevisionPackage({
    manifest: manifest({
      permissions: [
        { capability: 'documents.update', version: 1, reason: 'Write notes' },
        { capability: 'documents.read', version: 1 }
      ],
      standardModules: [
        { id: '@knowbook/std/dates', version: '1.0.0' },
        { id: '@knowbook/std/markdown', version: '2.0.0' }
      ]
    }),
    workerSource: '\uFEFFexport function activate() {\r\n  return true\r\n}',
    views: { z: 1, nested: { b: false, a: true }, a: 'first' },
    assets: {
      'icons\\mark.svg': Uint8Array.from([1, 2, 3])
    }
  }).package

  const second = buildPluginRevisionPackage({
    manifest: manifest({
      permissions: [
        { capability: 'documents.read', version: 1 },
        { reason: 'Write notes', version: 1, capability: 'documents.update' }
      ],
      standardModules: [
        { version: '2.0.0', id: '@knowbook/std/markdown' },
        { version: '1.0.0', id: '@knowbook/std/dates' }
      ]
    }),
    workerSource: 'export function activate() {\n  return true\n}\n',
    views: { a: 'first', nested: { a: true, b: false }, z: 1 },
    assets: {
      'icons/mark.svg': Uint8Array.from([1, 2, 3])
    }
  }).package

  assert.equal(first.revisionId, second.revisionId)
  assert.match(first.revisionId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(first.workerSource, 'export function activate() {\n  return true\n}\n')
  assert.deepEqual(first.manifest.permissions.map((entry) => entry.capability), [
    'documents.read',
    'documents.update'
  ])
  assert.equal(first.sizeBytes, second.sizeBytes)
})

test('revision hash changes with executable content and rejects unsupported dependencies', () => {
  const base = buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: 'export const value = 1'
  }).package
  const changed = buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: 'export const value = 2'
  }).package

  assert.notEqual(base.revisionId, changed.revisionId)
  assert.throws(() => buildPluginRevisionPackage({
    manifest: manifest({ standardModules: [{ id: 'lodash', version: '4.17.21' }] }),
    workerSource: ''
  }), /@knowbook\/std/)
  assert.throws(() => buildPluginRevisionPackage({
    manifest: manifest(),
    workerSource: '',
    assets: { '../secret.txt': new Uint8Array() }
  }), /inside the assets directory/)
  assert.throws(() => buildPluginRevisionPackage({
    manifest: { ...manifest(), postinstall: 'npm install' },
    workerSource: ''
  }), /unknown field "postinstall"/)
})

test('revision store publishes atomically, loads idempotently, and leaves staging empty', () => {
  withRevisionStore((store, root) => {
    const input = {
      manifest: manifest(),
      workerSource: 'export const activate = () => true',
      views: { cards: [{ id: 'daily-review' }] },
      assets: { 'icon.svg': Uint8Array.from([60, 115, 118, 103, 62]) }
    }
    const published = store.publish(input)
    const repeated = store.publish(input)
    const loaded = store.load(published.revisionId)

    assert.equal(repeated.revisionId, published.revisionId)
    assert.equal(loaded.revisionId, published.revisionId)
    assert.equal(loaded.workerSource, 'export const activate = () => true\n')
    assert.deepEqual([...loaded.assets['icon.svg']], [60, 115, 118, 103, 62])
    assert.equal(readdirSync(join(root, 'staging')).length, 0)
    assert.equal(readdirSync(join(root, 'objects')).length, 1)
    assert.equal(store.has(published.revisionId), true)
    assert.equal(store.has('sha256:bad'), false)
  })
})

test('revision store detects object tampering instead of executing changed code', () => {
  withRevisionStore((store) => {
    const published = store.publish({
      manifest: manifest(),
      workerSource: 'export const safe = true'
    })
    writeFileSync(
      join(store.getObjectPath(published.revisionId), 'worker.js'),
      'export const safe = false\n'
    )

    assert.throws(() => store.load(published.revisionId), /content hash mismatch/)
    assert.throws(() => store.publish({
      manifest: manifest(),
      workerSource: 'export const safe = true'
    }), /content hash mismatch/)
  })
})

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'daily-review',
    name: 'Daily Review',
    version: '1.0.0',
    apiVersion: '2',
    permissions: [],
    standardModules: [],
    ...overrides
  }
}

function withRevisionStore(
  run: (store: PluginRevisionStore, root: string) => void
): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-revision-test-'))
  try {
    run(new PluginRevisionStore(root), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
