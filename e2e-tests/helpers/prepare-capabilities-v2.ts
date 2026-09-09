import Database from 'better-sqlite3'
import { join } from 'node:path'
import { SqlitePluginPlatformRepository } from '../../src/main/plugin-platform/repository'
import { PluginRevisionStore } from '../../src/main/plugin-platform/revision-store'

// Prepare persisted test input while its isolated host is stopped. No v2 runtime
// evidence is manufactured here: the packaged host must create a real QuickJS run
// and complete its normal opaque-frame readiness handshake on the next launch.
const [profile, deniedTarget] = process.argv.slice(2)
if (!profile || !/^http:\/\/127\.0\.0\.1:\d+\/v2-must-not-load$/.test(deniedTarget ?? '')) throw new Error('Invalid controlled v2 fixture arguments')
const pluginId = 'system.capabilities.v2-comparison'
const databasePath = join(profile, 'storage', 'knowbook.db')
// Avoid opening KnowbookStore here: source migrations may be newer than the
// packaged host under test. Only write the existing v2 tables, without migration.
const db = new Database(databasePath)
const repository = new SqlitePluginPlatformRepository(db)
const scope = { kind: 'workspace' as const, workspaceId: 'local-workspace' }
const revisions = new PluginRevisionStore(join(profile, 'storage', 'plugin-revisions-v2'))
let installationId = ''
let grantId = ''
let revisionId = ''
try {
  repository.createDefinition({ id: pluginId, name: 'V2 capability comparison', source: 'dynamic', persistenceScope: 'workspace' })
  const package_ = revisions.publish({
    manifest: { schemaVersion: 2, id: pluginId, name: 'V2 capability comparison', version: '1.0.0', apiVersion: '2', worker: 'worker.js', permissions: [], standardModules: [{ id: '@knowbook/std/plugin', version: '1.0.0' }] },
    workerSource: `import { definePlugin } from '@knowbook/std/plugin';
export default definePlugin({activate(){return {contributions:[{descriptor:{slot:'workspace.dashboard',id:'capability-v2-comparison'},value:{kind:'iframe',asset:'frame.html',title:'V2 capability comparison',handlers:[]}}]}}});`,
    assets: { 'frame.html': Buffer.from(`<!doctype html><p id="v2-node"></p><p id="v2-network">pending</p><button id="v2-network-attack">network</button><button id="v2-popup-attack">popup</button><button id="v2-navigation-attack">navigate</button><script>
document.querySelector('#v2-node').textContent=typeof require;
document.querySelector('#v2-network-attack').onclick=async()=>{
try { await fetch(${JSON.stringify(deniedTarget)});document.querySelector('#v2-network').textContent='unexpected-success' }
catch { document.querySelector('#v2-network').textContent='network-denied' }
};
document.querySelector('#v2-popup-attack').onclick=()=>{try {open(${JSON.stringify(`${deniedTarget}?popup=1`)})}catch {}};
document.querySelector('#v2-navigation-attack').onclick=()=>{try {location.href=${JSON.stringify(deniedTarget)}}catch {}};
</script>`) }
  })
  repository.createRevision({ package: package_, staticCheckStatus: 'passed' })
  const installation = repository.ensureInstallation({ id: 'capability-v2-installation', pluginId, scope })
  const grant = repository.createGrantSet({ id: 'capability-v2-grant', pluginId, revisionId: package_.revisionId, installationId: installation.id, scope, grants: [], createdAt: new Date().toISOString() })
  installationId = installation.id
  grantId = grant.id
  revisionId = package_.revisionId
  db.prepare('UPDATE plugin_installations SET current_revision_id = ?, current_grant_set_id = ? WHERE id = ?').run(revisionId, grantId, installationId)
} finally { db.close() }
