import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginRevisionPackage } from '../src/shared/plugin-platform'
import { QuickJsPluginRevisionValidator } from '../src/main/plugin-platform/quickjs-validator'

function revision(workerSource: string, standardModules: PluginRevisionPackage['manifest']['standardModules']): PluginRevisionPackage {
  return {
    revisionId: `sha256:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
    manifest: {
      schemaVersion: 2,
      id: 'validator-test',
      name: 'Validator Test',
      version: '1.0.0',
      apiVersion: '2',
      worker: 'worker.js',
      permissions: [],
      standardModules
    },
    workerSource,
    views: null,
    assets: {},
    sizeBytes: Buffer.byteLength(workerSource)
  }
}

function firstDiagnostic(result: Awaited<ReturnType<QuickJsPluginRevisionValidator['validate']>>): Record<string, unknown> {
  assert.ok(Array.isArray(result.diagnostics))
  const diagnostic = result.diagnostics[0]
  assert.ok(diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic))
  return diagnostic
}

test('QuickJS revision validator compiles declared KnowBook standard modules', async () => {
  const result = await new QuickJsPluginRevisionValidator().validate(revision(`
    import { definePlugin } from '@knowbook/std/plugin';
    export default definePlugin({ activate: () => ({ contributions: [] }) });
  `, [{ id: '@knowbook/std/plugin', version: '1.0.0' }]))

  assert.equal(result.status, 'passed')
  assert.equal(firstDiagnostic(result)['code'], 'quickjs-compile-passed')
})

test('QuickJS revision validator rejects undeclared imports', async () => {
  const result = await new QuickJsPluginRevisionValidator().validate(revision(`
    import { value } from '@knowbook/std/missing';
    export default value;
  `, []))

  assert.equal(result.status, 'failed')
  const diagnostic = firstDiagnostic(result)
  assert.equal(diagnostic['code'], 'quickjs-compile-failed')
  assert.match(String(diagnostic['message']), /not declared or installed|could not load module/)
})
