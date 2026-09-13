import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { SystemPluginManager, type SystemPluginHostController } from '../src/main/system-plugin/manager'
import { canRetryInterruptedSystemPluginPackage, recoverInterruptedSystemPluginInstalls } from '../src/main/system-plugin/install-recovery'
import { createSystemPluginPackagePreparer } from '../src/main/system-plugin/package-preparer'

const pluginId = 'system.install-recovery.fixture'

test('startup terminates interrupted job metadata, retains active revision and logs, and requires fresh same-hash confirmation', async (t) => {
  // Exercise equal creation timestamps: job UUID order is not execution order.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00.000Z') })
  const root = mkdtempSync(join(tmpdir(), 'knowbook-install-recovery-'))
  const store = new KnowbookStore(join(root, 'database.db'))
  const source = join(root, 'source')
  let prepares = 0
  let failPreparation = false
  let temporary = ''
  let newPackageId = ''
  let manager: SystemPluginManager | undefined
  const create = () => new SystemPluginManager({
    repository: store.pluginPlatform, stagingRoot: join(root, 'staging'), artifactRoot: join(root, 'artifacts'),
    runtimeRoot: join(root, 'runtime'), dataRoot: join(root, 'data'), logRoot: join(root, 'logs'), backupRoot: join(root, 'backups'),
    backupDatabase: (destination) => store.backupDatabase(destination), createHost: () => fakeHost(),
    isDependencyProcessAlive: () => false,
    preparePublishedPackage: async ({ packageRecord, request }) => {
      prepares += 1
      if (!failPreparation) return
      newPackageId = packageRecord.id
      temporary = join(root, 'runtime', pluginId, `.preparing-${randomUUID()}`)
      mkdirSync(temporary, { recursive: true })
      writeFileSync(join(temporary, 'partial-build.txt'), 'never published')
      const log = join(root, 'interrupted-build.log')
      writeFileSync(log, 'compiler output before host termination')
      for (const [kind, status, pid] of [
        ['install', 'succeeded', null], ['build', 'running', 999991], ['native-rebuild', 'pending', null]
      ] as const) {
        const job = store.pluginPlatform.createSystemPluginDependencyJob({
          packageId: packageRecord.id, requestId: request.id, kind, packageManager: 'npm', command: ['npm', kind], logPath: log
        })
        store.pluginPlatform.updateSystemPluginDependencyJob(job.id, { status, pid, exitCode: status === 'succeeded' ? 0 : null })
      }
      throw new Error('Simulated host interruption after a persisted running job')
    }
  })
  try {
    writePlugin(source, '1.0.0')
    manager = create()
    const initial = await confirm(manager, source)
    await manager.destroy(); manager = create(); await manager.startup()
    const original = manager.get(pluginId)!.currentPackage!
    assert.equal(original.id, initial.packageRecord!.id)
    const data = join(root, 'data', pluginId, 'retained.json')
    writeFileSync(data, '{"retained":true}')
    writePlugin(source, '2.0.0')
    failPreparation = true
    await assert.rejects(confirm(manager, source), /Simulated host interruption/)
    // Persist precisely the state left by an abrupt host exit, which bypasses
    // the normal promise rejection/catch block above. No process is killed here.
    store.pluginPlatform.updateSystemPluginPackage(newPackageId, { status: 'installing', error: null })
    await manager.destroy(); manager = create()
    failPreparation = false
    const before = prepares
    await manager.startup()
    assert.equal(prepares, before, 'startup must not re-execute any dependency task')
    assert.equal(manager.get(pluginId)!.currentPackage!.id, original.id)
    assert.equal(manager.get(pluginId)!.installation.status, 'active')
    assert.equal(readFileSync(data, 'utf8'), '{"retained":true}')
    assert.equal(existsSync(temporary), false, 'legacy exact .preparing directory should be cleaned')
    const recovered = store.pluginPlatform.getSystemPluginPackage(newPackageId)!
    assert.equal(canRetryInterruptedSystemPluginPackage(recovered), true)
    const recoveredJobs = store.pluginPlatform.listSystemPluginDependencyJobs(newPackageId)
    assert.deepEqual(recoveredJobs.sort((left, right) => left.kind.localeCompare(right.kind))
      .map((job) => [job.kind, job.status, job.pid, job.exitCode]), [
      ['build', 'failed', null, null],
      ['install', 'succeeded', null, 0],
      ['native-rebuild', 'cancelled', null, null]
    ])
    assert.equal(readFileSync(join(root, 'interrupted-build.log'), 'utf8'), 'compiler output before host termination')
    const auditCount = store.pluginPlatform.listSystemPluginAudit(pluginId).length
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime') })
    assert.equal(store.pluginPlatform.listSystemPluginAudit(pluginId).length, auditCount, 'completed recovery is idempotent')
    const review = await manager.prepareInstallFromDirectory({ sourceDirectory: source, requestedBy: 'user', reason: 'Explicitly retry interrupted artifact' })
    assert.equal(review.status, 'awaiting-confirmation')
    assert.equal(prepares, before)
    assert.equal(review.artifactSha256, recovered.contentHash)
    await assert.rejects(manager.resolveInstallRequest({ requestId: review.id, pluginId, artifactSha256: review.artifactSha256,
      decision: 'confirm', acknowledgeSystemAccess: false, actor: 'user' }), /acknowledgement/)
    assert.equal(prepares, before)
    const retry = await manager.resolveInstallRequest({ requestId: review.id, pluginId, artifactSha256: review.artifactSha256,
      decision: 'confirm', acknowledgeSystemAccess: true, actor: 'user' })
    assert.equal(retry.packageRecord!.id, newPackageId)
    assert.equal(prepares, before + 1)
    assert.equal(retry.installation!.currentPackageId, original.id)
    assert.equal(retry.installation!.pendingPackageId, newPackageId)
    await manager.destroy(); manager = create(); await manager.startup()
    assert.equal(manager.get(pluginId)!.currentPackage!.version, '2.0.0')
  } finally { await manager?.destroy(); store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

for (const observation of ['live-or-reused-pid', 'inspection-error'] as const) {
  test(`recovery preserves temporary runtime and blocks retry on ${observation}`, async () => {
    await fixture(async ({ root, store, record, temporary, job }) => {
      await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime'),
        isProcessAlive: () => { if (observation === 'inspection-error') throw new Error('EPERM: process cannot be inspected'); return true } })
      assert.equal(existsSync(temporary), true)
      assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), false)
      assert.equal(store.pluginPlatform.getSystemPluginDependencyJob(job.id)!.pid, 998877)
      assert.equal(store.pluginPlatform.getSystemPluginDependencyJob(job.id)!.status, 'failed')
      await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime'), isProcessAlive: () => false })
      assert.equal(existsSync(temporary), false)
      assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), true)
      assert.equal(store.pluginPlatform.getSystemPluginDependencyJob(job.id)!.pid, null)
    })
  })
}

test('recovery rejects a metadata path outside the package runtime and preserves external data', async () => {
  await fixture(async ({ root, store, record }) => {
    const outside = join(root, 'external')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'external data')
    store.pluginPlatform.updateSystemPluginPackage(record.id, { runtimeFingerprint: {
      installPreparation: { schemaVersion: 1, packageId: record.id, contentHash: record.contentHash, temporaryRoot: outside }
    } })
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime'), isProcessAlive: () => false })
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'external data')
    assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), false)
  })
})

test('recovery treats an exited recorded process as absent without sending a termination signal', async () => {
  await fixture(async ({ root, store, record, temporary, job }) => {
    const pid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('close', () => resolve(child.pid!))
    })
    store.pluginPlatform.updateSystemPluginDependencyJob(job.id, { pid })
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime') })
    assert.equal(existsSync(temporary), false)
    assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), true)
  })
})

test('recovery accepts a canonical temporary path through an aliased managed profile', async () => {
  await fixture(async ({ root, store, record, temporary }) => {
    const alias = join(root, 'profile-alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform,
      runtimeRoot: join(alias, 'runtime'), isProcessAlive: () => false })
    assert.equal(existsSync(temporary), false)
    assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), true)
  })
})

test('recovery refuses an external junction and keeps unrelated runtime directories', async () => {
  await fixture(async ({ root, store, record, temporary }) => {
    rmSync(temporary, { recursive: true })
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    symlinkSync(outside, temporary, process.platform === 'win32' ? 'junction' : 'dir')
    const keep = join(root, 'runtime', pluginId, 'arbitrary-user-directory')
    mkdirSync(keep)
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime'), isProcessAlive: () => false })
    assert.equal(existsSync(join(outside, 'keep.txt')), true)
    assert.equal(existsSync(keep), true)
    assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), false)
  })
})

test('running job without a recorded PID stays blocked across repeated startups, while pending jobs can cancel', async () => {
  await fixture(async ({ root, store, record, temporary, job }) => {
    store.pluginPlatform.updateSystemPluginDependencyJob(job.id, { pid: null })
    let probes = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime'),
        isProcessAlive: () => { probes++; return false } })
      assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), false)
      assert.equal(existsSync(temporary), true)
      assert.equal(store.pluginPlatform.getSystemPluginDependencyJob(job.id)!.status, 'failed')
      assert.equal((store.pluginPlatform.getSystemPluginDependencyJob(job.id)!.error as { unidentifiedProcess?: boolean }).unidentifiedProcess, true)
    }
    assert.equal(probes, 0)
  })
  await fixture(async ({ root, store, record, temporary, job }) => {
    store.pluginPlatform.updateSystemPluginDependencyJob(job.id, { status: 'pending', pid: null })
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime') })
    assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), true)
    assert.equal(store.pluginPlatform.getSystemPluginDependencyJob(job.id)!.status, 'cancelled')
    assert.equal(existsSync(temporary), false)
  })
})

test('copy failure before task creation remains discoverable through persisted preparation metadata', async () => {
  await fixture(async ({ root, store, record, temporary, job }) => {
    store.pluginPlatform.updateSystemPluginDependencyJob(job.id, { status: 'cancelled', pid: null })
    const request = store.pluginPlatform.createSystemPluginInstallRequest({ pluginId, name: 'Copy failure', version: '1.0.0', publisher: 'Tests',
      artifactSha256: record.contentHash, systemPermissions: ['full-trust'], reason: 'Copy failure recovery', requestedBy: 'user' })
    const prepare = createSystemPluginPackagePreparer({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime'), logRoot: join(root, 'logs') })
    await assert.rejects(prepare({ packageRecord: record, request, artifact: {
      artifactId: `sha256:${record.contentHash}`, artifactSha256: record.contentHash, artifactDirectory: join(root, 'missing-source'),
      manifest: { schemaVersion: 3, trust: 'full', id: pluginId, name: 'Copy failure', version: '1.0.0', publisher: 'Tests',
        entries: { main: 'main.cjs' }, fullAccess: true, riskDeclarations: ['node'] },
      files: [], fileCount: 0, sizeBytes: 0, dependencyLockPath: null
    } }), /ENOENT/)
    store.pluginPlatform.updateSystemPluginPackage(record.id, { status: 'failed', error: { name: 'CopyError', message: 'Source vanished' } })
    assert.equal(store.pluginPlatform.listSystemPluginPackagesAwaitingInstallRecovery().some((candidate) => candidate.id === record.id), true)
    await recoverInterruptedSystemPluginInstalls({ repository: store.pluginPlatform, runtimeRoot: join(root, 'runtime') })
    assert.equal(canRetryInterruptedSystemPluginPackage(store.pluginPlatform.getSystemPluginPackage(record.id)!), true)
    assert.equal(existsSync(temporary), true, 'A sibling preparing directory outside the recorded copy attempt is retained')
    assert.equal((store.pluginPlatform.getSystemPluginPackage(record.id)!.runtimeFingerprint as { installPreparation?: unknown }).installPreparation, undefined)
  })
})

async function fixture(run: (input: {
  root: string; store: KnowbookStore; record: ReturnType<KnowbookStore['pluginPlatform']['createSystemPluginPackage']>;
  job: ReturnType<KnowbookStore['pluginPlatform']['createSystemPluginDependencyJob']>; temporary: string
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-recovery-path-'))
  const store = new KnowbookStore(join(root, 'database.db'))
  try {
    const record = store.pluginPlatform.createSystemPluginPackage({ pluginId, version: '1.0.0', publisher: 'Tests',
      contentHash: 'a'.repeat(64), artifactPath: join(root, 'artifact'), manifestSnapshot: {}, fileManifest: [], status: 'installing' })
    const temporary = join(root, 'runtime', pluginId, `.preparing-${randomUUID()}`)
    mkdirSync(temporary, { recursive: true })
    writeFileSync(join(temporary, 'partial.txt'), 'partial')
    store.pluginPlatform.updateSystemPluginPackage(record.id, { runtimeFingerprint: {
      installPreparation: { schemaVersion: 1, packageId: record.id, contentHash: record.contentHash, temporaryRoot: temporary }
    } })
    const job = store.pluginPlatform.createSystemPluginDependencyJob({ packageId: record.id, kind: 'install', packageManager: 'npm', command: ['npm', 'ci'] })
    store.pluginPlatform.updateSystemPluginDependencyJob(job.id, { status: 'running', pid: 998877 })
    await run({ root, store, record, temporary, job })
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}

function writePlugin(source: string, version: string) {
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ schemaVersion: 3, trust: 'full', id: pluginId,
    name: 'Install recovery fixture', version, publisher: 'Tests', entries: { main: 'main.cjs' }, fullAccess: true, riskDeclarations: ['node'] }))
  writeFileSync(join(source, 'main.cjs'), 'module.exports.activate = () => {}')
}
async function confirm(manager: SystemPluginManager, sourceDirectory: string) {
  const request = await manager.prepareInstallFromDirectory({ sourceDirectory, requestedBy: 'user', reason: 'Controlled recovery fixture' })
  return manager.resolveInstallRequest({ requestId: request.id, pluginId, artifactSha256: request.artifactSha256,
    decision: 'confirm', acknowledgeSystemAccess: true, actor: 'user' })
}
function fakeHost(): SystemPluginHostController {
  return { status: 'active', activate: async () => ({ entryPath: 'main.cjs', format: 'cjs', health: { ok: true } }),
    healthCheck: async () => ({ ok: true }), beforeQuit: async () => {}, deactivate: async () => {} }
}
