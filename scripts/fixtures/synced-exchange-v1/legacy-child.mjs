import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { causeMessages, copyTreeFresh, dumpRemote, dumpRequests, hash, hashFile, inventory, runChild, writeFresh } from './evidence.mjs'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const cases = ['prepared', 'possible', 'remote-confirmed', 'published-local-deferred', 'committed-replay']
assert.ok(cases.includes(config.caseName), 'Only the five reviewed compatibility scenarios can run')
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
assert.equal(process.cwd(), config.oldSource, 'The legacy process uses the archived source as its cwd')
assert.equal(process.env.TSX_TSCONFIG_PATH, join(config.oldSource, 'tsconfig.test.json'))
const legacyImport = path => import(pathToFileURL(join(config.oldSource, path)).href)
// This process never imports current product modules. Every fixture and all its
// transitive product imports are the complete pinned Git archive's originals.
const old = await legacyImport('tests/helpers/synced-exchange-fixture.ts')
const sql = value => "'" + value.replaceAll("'", "''") + "'"
let activeFixture = null
let completedReport = null

function rows(db, operationId) {
  const headKey = 'sync.webdav.protocol5.exchange-job-head.v1.' + operationId
  const headRow = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(headKey)
  assert.ok(headRow, 'The legacy writer committed the actual operation head before handoff')
  const head = JSON.parse(headRow.value)
  assert.equal(head.version, 1); assert.equal(head.operationId, operationId)
  const jobKey = 'sync.webdav.protocol5.exchange-job.v1.' + operationId + '.' + head.attemptId
  const jobRow = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(jobKey)
  assert.ok(jobRow, 'The original operation head points to an actual immutable legacy job')
  const job = JSON.parse(jobRow.value)
  assert.equal(job.kind, 'synced-exchange-job'); assert.equal(job.version, 1)
  assert.equal(job.request.method, 'exchangeSyncedSnapshot'); assert.equal(job.request.operationId, operationId)
  assert.equal(head.jobHash, hash(Buffer.from(jobRow.value)))
  assert.equal(head.requestHash, job.requestHash)
  const prefix = 'sync.webdav.protocol5.exchange-job-phase.v1.' + operationId + '.' + head.attemptId + '.'
  const phaseRows = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length, prefix)
    .sort((a, b) => JSON.parse(a.value).sequence - JSON.parse(b.value).sequence)
  assert.ok(phaseRows.length > 0, 'The actual legacy operation has a durable prepared phase')
  let previous = null
  for (const [sequence, row] of phaseRows.entries()) {
    const value = JSON.parse(row.value)
    assert.equal(value.kind, 'synced-exchange-job-phase'); assert.equal(value.version, 1)
    assert.equal(value.operationId, operationId); assert.equal(value.attemptId, head.attemptId)
    assert.equal(value.sequence, sequence); assert.equal(value.previousFactHash, previous)
    assert.equal(value.requestHash, job.requestHash); assert.equal(value.jobHash, head.jobHash)
    previous = hash(Buffer.from(row.value))
  }
  const receipt = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(operationId) ?? null
  const attempts = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').all(head.attemptId)
  const members = db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(head.attemptId)
  const allSettings = db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all()
  const immutableSettings = allSettings.filter(row => row.key.startsWith('sync.webdav.protocol5.exchange-job.v1.')
    || row.key.startsWith('sync.webdav.protocol5.exchange-job-phase.v1.')
    || row.key.startsWith('sync.webdav.protocol5.exchange-host-cut.v1.')
    || row.key.startsWith('sync.webdav.protocol5.exchange-history-row.v1.')
    || row.key.startsWith('sync.webdav.protocol5.exchange-history-index.v1.'))
  const operations = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations ORDER BY client_operation_id').all()
  return { headRow, head, jobRow, job, phaseRows, receipt, attempts, members, immutableSettings, operations }
}
function closeLegacyConnections(f) {
  // No connect/reopen/newPristine/clone helper is used in this verifier. Setup's
  // bootstrap/Store handles are already destroyed; these are its only live DBs.
  for (const profile of [f.A, f.B]) if (profile.db.open) profile.db.close()
  assert.equal(f.A.db.open, false); assert.equal(f.B.db.open, false)
}
async function expectOldFailure(run, code, marker) {
  let error = null
  try { await run() } catch (cause) { error = cause }
  assert.ok(error, 'The old producer must reach the intended real failure point')
  assert.equal(error.code, code, 'The real old boundary reports the intended finite failure category')
  const messages = causeMessages(error)
  if (marker) assert.ok(messages.some(message => message.includes(marker)), 'The preserved original cause proves the exact SQL injection was reached')
  return { name: error.name, code: error.code, messages, stack: error.stack ?? null }
}

try {
  await old.withExchange(async f => {
    activeFixture = f
    const setupOperations = []
    const exchange = async profile => {
      const operationId = randomUUID(), value = old.completed(await f.exchange(profile, operationId))
      setupOperations.push({ profile: profile.root, operationId, result: value })
      return value
    }
    try {
      await exchange(f.A); await exchange(f.B)
      // Real acknowledged local host/group branches first become common state.
      // The target operation later replaces both, producing real cut/archive
      // evidence rather than fabricated app_settings records.
      const groupId = f.ack.createdLifecycle.groupId
      const originalHost = old.hostEdit(f.A.db, f.islands[0], 'Legacy acknowledged host branch')
      const originalGroup = old.changeGroup(f.A.db, groupId, blocks => { blocks[0].content += ' legacy acknowledged group branch' })
      assert.equal(originalGroup.status, 'saved')
      await exchange(f.A); await exchange(f.B)
      const incomingText = 'Legacy peer incoming row for compatibility ' + config.caseName
      old.hostEdit(f.B.db, f.islands[0], incomingText)
      old.changeGroup(f.B.db, groupId, blocks => { blocks[0].content += ' legacy peer replacement ' + config.caseName })
      await exchange(f.B)
      old.hostEdit(f.A.db, f.islands[1], 'Legacy outgoing row for compatibility ' + config.caseName)
      const operationId = randomUUID(), controller = new AbortController()
      const input = { operationId, userDataRoot: f.A.root, target: f.targetConfig }
      const originalBaseline = old.stateRow(f.A.db).value
      const beforeRemote = old.remoteActual(f), beforeIncoming = old.hostRows(f.A.db, f.islands[0])
      const outgoingHash = old.localPortable(f.A).entries['doc:' + f.islands[1]]
      assert.notEqual(outgoingHash, beforeRemote.manifest.entries['doc:' + f.islands[1]])
      assert.ok(f.A.db.prepare('SELECT 1 FROM synced_host_history_documents WHERE history_id=?').get(originalHost.ack.historyToken), 'The old target has a real executable host mapping to cut')
      assert.ok(f.A.db.prepare('SELECT 1 FROM synced_group_history WHERE group_id=?').get(groupId), 'The old target has a real executable group history to archive')
      const phasePrefix = 'sync.webdav.protocol5.exchange-job-phase.v1.' + operationId + '.'
      const triggerName = 'compat_exchange_v1_' + config.caseName.replaceAll('-', '_')
      const triggerPhase = "substr(NEW.key,1," + phasePrefix.length + ')=' + sql(phasePrefix)
      let triggerSql = null, injectionHits = 0, failure = null, legacyResult = null
      let late = null
      const requestStart = f.server.requests.length
      if (config.caseName === 'prepared') {
        triggerSql = 'CREATE TRIGGER ' + triggerName + ' BEFORE INSERT ON app_settings WHEN ' + triggerPhase
          + " AND json_extract(NEW.value,'$.phase')='possible' BEGIN SELECT RAISE(ABORT,'compat legacy prepared trigger claim abort'); END"
        f.A.db.exec(triggerSql)
      } else if (config.caseName === 'possible') {
        f.server.setHook(request => {
          if (request.method === 'HEAD' && request.path === '/' + f.targetConfig.directory + '/objects/' + outgoingHash + '.json') {
            injectionHits++; return { kind: 'disconnect' }
          }
        })
      } else if (config.caseName === 'remote-confirmed') {
        // Deliberately no Database/Store/prepare/read/re-entry in this callback.
        // Returning 0 lets the actual confirmation transaction commit; the old
        // public run's next original signal check is the point which throws.
        f.A.db.function('compat_abort_after_remote_confirmation', () => {
          injectionHits++
          controller.abort('compat legacy confirmed then abort')
          return 0
        })
        triggerSql = 'CREATE TRIGGER ' + triggerName + ' AFTER INSERT ON app_settings WHEN ' + triggerPhase
          + " AND json_extract(NEW.value,'$.phase')='remote-confirmed' BEGIN SELECT compat_abort_after_remote_confirmation(); END"
        f.A.db.exec(triggerSql)
      } else if (config.caseName === 'published-local-deferred') {
        late = old.lateReceipt(f.A.db, operationId, { documentId: f.islands[0], content: incomingText })
      }
      try {
        if (config.caseName === 'committed-replay') legacyResult = old.completed(await f.exchange(f.A, operationId), 'applied')
        else failure = await expectOldFailure(() => f.exchange(f.A, operationId, controller.signal),
          config.caseName === 'prepared' || config.caseName === 'published-local-deferred' ? 'database' : 'transport',
          config.caseName === 'prepared' ? 'compat legacy prepared trigger claim abort'
            : config.caseName === 'published-local-deferred' ? 'exchange exact late receipt fixture' : null)
      } finally {
        f.server.setHook(undefined)
        if (triggerSql) f.A.db.exec('DROP TRIGGER ' + triggerName)
        if (late) { injectionHits = late.seen.length; late.remove() }
      }
      const saved = rows(f.A.db, operationId), actualPhase = JSON.parse(saved.phaseRows.at(-1).value).phase
      const expectedPhase = config.caseName === 'committed-replay' ? 'settled' : config.caseName
      assert.equal(actualPhase, expectedPhase, 'A sample is handed over only after its actual legacy durable phase was reached')
      assert.ok(saved.job.descriptor.members.length > 0 && saved.job.descriptor.members.some(member => member.groupId === groupId), 'Every sample claims actual active local members, not an ordinary zero-member shortcut')
      const spoolDirectory = join(f.A.root, 'storage', 'synced-exchanges-v1', operationId, saved.head.attemptId)
      const inputs = JSON.parse(readFileSync(join(spoolDirectory, 'inputs.json'), 'utf8'))
      assert.equal(inputs.version, 1); assert.equal(inputs.kind, 'synced-exchange-private-inputs')
      assert.deepEqual(inputs.request, saved.job.request)
      assert.equal(hash(readFileSync(join(spoolDirectory, 'job.json'))), hash(Buffer.from(saved.jobRow.value)))
      const manifestBytes = readFileSync(join(spoolDirectory, 'manifest.json')), expectedManifest = JSON.parse(manifestBytes.toString('utf8'))
      assert.equal(hash(manifestBytes), saved.job.descriptor.next.manifestHash)
      const reachedRemote = old.remoteActual(f)
      if (config.caseName === 'prepared' || config.caseName === 'possible') assert.deepEqual(reachedRemote.bytes, beforeRemote.bytes, 'The pre-manifest failure leaves the actual remote manifest unchanged')
      else assert.deepEqual(reachedRemote.bytes, manifestBytes, 'Actual HTTP publication committed the exact original spool bytes')
      if (config.caseName === 'prepared') {
        assert.equal(saved.attempts.length, 0, 'The prepared injection rolled back the actual claim attempt')
        assert.equal(saved.phaseRows.length, 1)
      } else {
        assert.equal(saved.attempts.length, 1); assert.equal(saved.members.length, saved.job.descriptor.members.length)
        assert.equal(saved.attempts[0].state, config.caseName === 'possible' ? 'possible' : 'confirmed')
      }
      if (config.caseName === 'possible' || config.caseName === 'remote-confirmed') assert.equal(injectionHits, 1, 'The reviewed real network/signal injection point was reached exactly once')
      if (late) assert.ok(late.seen.some(value => value.incomingMatches > 0 && value.groups > 0), 'The actual receipt trigger witnessed the incoming physical graph before rollback')
      if (config.caseName !== 'committed-replay') {
        assert.equal(saved.receipt, null); assert.equal(old.stateRow(f.A.db).value, originalBaseline)
        assert.deepEqual(old.hostRows(f.A.db, f.islands[0]), beforeIncoming, 'No failed old install silently changes the persisted incoming host')
      } else {
        assert.ok(saved.receipt, 'The fifth sample uses an actual successful old operation receipt')
        const receipt = JSON.parse(saved.receipt.result_json)
        assert.equal(receipt.kind, 'synced-exchange-operation'); assert.equal(receipt.version, 1)
        assert.ok(receipt.provenance.hostHistoryCuts.length > 0, 'The original old receipt authenticates actual host cuts')
        assert.ok(receipt.provenance.historyArchives.length > 0, 'The original old receipt authenticates actual group history archives')
        old.hostEdit(f.A.db, f.islands[2], 'Later local edit must survive old immutable ACK replay')
        // Current first strictly reads these genuine old cut/archive/state
        // facts, then changes only the fixture recovery epoch before replay.
        f.server.files.delete('/' + f.targetConfig.directory + '/manifest.json')
      }
      const handoff = { caseName: config.caseName, operationId, input, runtime: old.runtime,
        oldCommit: config.oldCommit, profile: { root: f.A.root, file: f.A.file }, expectedPhase,
        saved: rows(f.A.db, operationId), expectedManifest, expectedManifestHash: hash(manifestBytes), legacyResult,
        setupOperations, injection: { triggerSql, hits: injectionHits, failure, lateWitnesses: late?.seen ?? [] },
        oldHistory: { hostToken: originalHost.ack.historyToken, groupOperationId: originalGroup.operationId },
        spoolDirectory, spoolFiles: inventory(spoolDirectory), requestStart,
        targetFingerprint: saved.job.request.targetFingerprint, incomingText, incomingDocumentId: f.islands[0] }
      writeFresh(join(config.evidence, 'legacy-handoff.json'), handoff)
      dumpRequests(f.server.requests, join(config.evidence, 'legacy-requests.json'))
      dumpRemote(f.server, join(config.evidence, 'remote-before-current'))
      closeLegacyConnections(f)
      const profileBefore = copyTreeFresh(f.A.root, join(config.evidence, 'profile-before-current'))
      writeFresh(join(config.evidence, 'profile-before-inventory.json'), profileBefore)
      writeFresh(join(config.evidence, 'legacy-connections-closed.json'), { pid: process.pid, A: f.A.db.open, B: f.B.db.open, at: new Date().toISOString(), requestCount: f.server.requests.length })
      const currentStart = f.server.requests.length
      // The old process now serves only the original HTTP fixture's in-memory
      // bytes. It performs no DB read/write while the new process owns the DB.
      writeFresh(join(config.evidence, 'current-input.json'), { currentRoot: config.currentRoot,
        handoffPath: join(config.evidence, 'legacy-handoff.json'), evidence: config.evidence })
      const processReport = await runChild({ name: 'current', script: config.currentDriver,
        args: [join(config.evidence, 'current-input.json')], cwd: config.currentRoot,
        loader: config.loader, tsconfig: join(config.currentRoot, 'tsconfig.test.json'), evidence: config.evidence })
      assert.notEqual(processReport.pid, process.pid, 'Current product evaluation occurs in a separate process')
      const currentResult = JSON.parse(readFileSync(join(config.evidence, 'current-result.json'), 'utf8'))
      dumpRequests(f.server.requests, join(config.evidence, 'all-requests.json'))
      const profileAfter = copyTreeFresh(f.A.root, join(config.evidence, 'profile-after-current'))
      writeFresh(join(config.evidence, 'profile-after-inventory.json'), profileAfter)
      dumpRemote(f.server, join(config.evidence, 'remote-after-current'))
      if (config.caseName === 'committed-replay') {
        assert.equal(f.server.requests.length, currentStart, 'Actual old receipt replay emits zero HTTP, including metadata/probes')
        assert.deepEqual(profileAfter, currentResult.profileBeforeReplay, 'Replay preserves the whole closed profile raw bytes after the explicit fixture epoch change')
      } else {
        assert.deepEqual(old.remoteActual(f).bytes, manifestBytes, 'New recovery converges to the original v1 remote bytes')
        assert.equal(currentResult.result.afterManifestHash, hash(manifestBytes))
        if (config.caseName === 'remote-confirmed' || config.caseName === 'published-local-deferred') {
          const writes = f.server.requests.slice(currentStart).filter(request => ['PUT', 'MOVE', 'DELETE', 'MKCOL'].includes(request.method))
          assert.deepEqual(writes, [], 'Already committed v1 publication is confirmed by reads instead of a second publication/probe')
        }
      }
      f.server.assertNoHookErrors()
      completedReport = { status: 'passed', caseName: config.caseName, operationId, expectedPhase,
        originalAttemptId: saved.head.attemptId, originalJobHash: saved.head.jobHash,
        handoffSha256: hashFile(join(config.evidence, 'legacy-handoff.json')), currentResultSha256: hashFile(join(config.evidence, 'current-result.json')),
        originalPhaseCount: saved.phaseRows.length, currentHttpRequests: f.server.requests.length - currentStart,
        legacyPid: process.pid, currentPid: processReport.pid, currentProcess: processReport,
        completedAt: new Date().toISOString() }
      writeFresh(join(config.evidence, 'case-result.json'), completedReport)
    } catch (error) {
      f.server.setHook(undefined)
      closeLegacyConnections(f)
      if (!existsSync(join(config.evidence, 'failure-profile'))) copyTreeFresh(f.A.root, join(config.evidence, 'failure-profile'))
      if (!existsSync(join(config.evidence, 'failure-requests.json'))) dumpRequests(f.server.requests, join(config.evidence, 'failure-requests.json'))
      if (!existsSync(join(config.evidence, 'failure-remote'))) dumpRemote(f.server, join(config.evidence, 'failure-remote'))
      throw error
    }
  }, { assets: true, catalog: true, orphan: true })
  assert.ok(completedReport, 'The legacy fixture must reach a complete verified handoff')
  process.stdout.write(JSON.stringify({ status: 'passed', caseName: config.caseName, operationId: completedReport.operationId }) + '\n')
} catch (error) {
  if (activeFixture) closeLegacyConnections(activeFixture)
  writeFresh(join(config.evidence, 'legacy-failure.json'), { status: 'failed', pid: process.pid,
    caseName: config.caseName, messages: causeMessages(error), stack: error instanceof Error ? error.stack : null, at: new Date().toISOString() })
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n')
  process.exitCode = 1
}
