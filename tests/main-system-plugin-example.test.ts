import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { WorkspaceEventBus } from '../src/main/event-bus'
import { inspectSystemPluginArtifact } from '../src/main/system-plugin-artifact'
import { SystemPluginHost } from '../src/main/system-plugin/host'
import { createKnowbookFullTrustServices, type KnowbookFullTrustServiceOptions } from '../src/main/system-plugin/knowbook-services'

test('published starter example loads with real Store, reuses its document, migrates and cleans subscriptions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-v3-example-'))
  const runtime = join(directory, 'runtime')
  const dataRoot = join(directory, 'data')
  const store = new KnowbookStore(join(directory, 'knowbook.db'))
  const bus = new WorkspaceEventBus()
  const hosts: SystemPluginHost<ReturnType<typeof createKnowbookFullTrustServices>>[] = []
  try {
    cpSync(resolve('examples/system-plugin-v3-starter'), runtime, { recursive: true })
    mkdirSync(dataRoot)
    const artifact = await inspectSystemPluginArtifact(runtime)
    assert.deepEqual(artifact.manifest.entries, { main: 'main.cjs', renderer: 'renderer.cjs', service: 'service.cjs' })
    const services = createKnowbookFullTrustServices({
      store, sqlite: store.getUnsafeDatabaseHandle(), workspaceEventBus: bus,
      electron: {} as KnowbookFullTrustServiceOptions['electron'], getMainWindow: () => null,
      getAiCredentials: () => ({ enabled: false, apiKey: null, baseUrl: '', model: '' }),
      notifyWorkspaceMutation() {},
      paths: { userData: directory, appData: directory, documents: directory, downloads: directory, temp: directory }
    })
    const before = services.documents.list().length
    const start = async (version: string, fromVersion?: string) => {
      const host = new SystemPluginHost({
        plugin: { id: artifact.manifest.id, version, revisionHash: artifact.artifactId },
        pluginRoot: runtime, dataRoot, mainEntry: 'main.cjs', services, fromVersion
      })
      hosts.push(host)
      await host.activate()
      assert.equal(host.status, 'active')
      return host
    }
    const first = await start('1.0.0')
    const state = () => JSON.parse(readFileSync(join(dataRoot, 'state.json'), 'utf8')) as { documentId: string; activations: number }
    const documentId = state().documentId
    assert.equal(services.documents.list().length, before + 1)
    assert.equal(services.settings.get(`${artifact.manifest.id}.documentId`), documentId)
    await bus.emit({ type: 'document.summary.generated', createdAt: new Date().toISOString(), documentId,
      documentTitle: '系统插件示例', path: '系统插件示例', summary: 'External summary' })
    assert.equal(services.settings.get(`${artifact.manifest.id}.lastDocumentEvent`), 'document.summary.generated')
    await first.deactivate()
    services.settings.delete(`${artifact.manifest.id}.lastDocumentEvent`)
    await bus.emit({ type: 'document.summary.generated', createdAt: new Date().toISOString(), documentId,
      documentTitle: '系统插件示例', path: '系统插件示例', summary: 'After shutdown' })
    assert.equal(services.settings.get(`${artifact.manifest.id}.lastDocumentEvent`), null)
    const restarted = await start('1.0.0')
    assert.deepEqual(state(), { schemaVersion: 1, documentId, activations: 2 })
    assert.equal(services.documents.list().length, before + 1)
    await restarted.deactivate()
    const upgraded = await start('2.0.0', '1.0.0')
    assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')), { fromVersion: '1.0.0', toVersion: '2.0.0' })
    assert.equal(state().documentId, documentId)
    assert.equal(state().activations, 3)
    await upgraded.deactivate()
  } finally {
    for (const host of hosts) await host.deactivate().catch(() => undefined)
    store.destroy()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
