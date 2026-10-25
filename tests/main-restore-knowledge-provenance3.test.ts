import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { graph3Encode, graph3Text, RestoreGraph3Conflict, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { knowledgeHash, type KnowledgeRowRef } from '../src/main/database/restore-knowledge-payload-model'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityGraphInputs3 } from '../src/main/database/restore-knowledge-identity3-read'
import { deriveRootRestoreProvenanceSources3 } from '../src/main/database/restore-knowledge-provenance3-model'
import { prepareRootRestoreProvenanceSources3, readRootRestoreProvenanceSources3 } from '../src/main/database/restore-knowledge-provenance3-read'
import { historicalRowLocator } from '../src/main/database/synced-history-evidence-support'
import { createRawHash } from '../src/main/database/synced-host-create-plan'
import { hostHash } from '../src/main/database/synced-host-journal'
import type { HostCreateJournal, SyncedHostCreateApplied } from '../src/main/database/synced-host-create-codec'
import { withContent3Fixture, tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { allTables, applySyncedHostCommand, createRequest, created } from './helpers/synced-backup-v3-fixture'
import { restoreCreated } from './helpers/synced-host-command-create-fixture'

const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
function originalRow(data: Graph3Inputs, reference: KnowledgeRowRef) {
  const knowledge = data.inputs.source.knowledge
  const table = knowledge.originals.find(item => item.table === reference.table)
  assert.ok(table)
  const row = table.rows.find(item => item.occurrence === reference.occurrence && item.rowHash === reference.rowHash && same(item.key, reference.key))
  assert.ok(row)
  return { knowledge, table, row }
}
function initialAck(data: Graph3Inputs, operationId: string) {
  const materials = data.inputs.source.knowledge.historicalMaterial.filter(item => item.fact.family === 'host-create-ack'
    && item.fact.locator.table === 'synced_operations' && item.fact.locator.key[0] === operationId)
  assert.equal(materials.length, 1)
  return materials[0]
}

/** 仅用于明确的数据模型负例。重签原行和全部相应引用，使负例到达
 * ACK/journal 语义 join，而不是只触发 rowHash 守卫；不 mint Main owner。 */
function patchOriginal(data: Graph3Inputs, reference: KnowledgeRowRef, changes: Record<string, string>) {
  const { knowledge, table, row } = originalRow(data, reference)
  assert.ok(table.table === 'synced_operations' || table.table === 'synced_host_history')
  assert.equal(Object.isFrozen(row), false)
  const oldReference = structuredClone(reference)
  const decode = () => Object.fromEntries(table.columns.map((column, index) => [column, graph3Text(row.cells[index], knowledge.encoding)]))
  const key = oldReference.key.map(cell => graph3Text(cell, knowledge.encoding))
  const oldHistorical = historicalRowLocator(table.table, key, decode())
  const cells = [...row.cells]
  for (const [column, value] of Object.entries(changes)) {
    const index = table.columns.indexOf(column)
    assert.ok(index >= 0)
    assert.equal(table.primaryKey.includes(column), false)
    cells[index] = graph3Encode(value, data.inputs.source.source.sourceContent.encoding)
  }
  Reflect.set(row, 'cells', cells)
  const rowHash = knowledgeHash('knowbook.knowledge.sql-row.v1', { encoding: knowledge.encoding,
    table: table.table, columns: table.columns, cells })
  Reflect.set(row, 'rowHash', rowHash)
  const nextReference = { ...oldReference, rowHash }
  const nextHistorical = historicalRowLocator(table.table, key, decode())
  const seen = new WeakSet<object>()
  const replace = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const item = value as Record<string, unknown>
    if (item.table === oldReference.table && item.rowHash === oldReference.rowHash
      && item.occurrence === oldReference.occurrence && same(item.key, oldReference.key)) Object.assign(item, nextReference)
    else if (item.table === oldHistorical.table && item.rowHash === oldHistorical.rowHash
      && same(item.key, oldHistorical.key)) Object.assign(item, nextHistorical)
    for (const child of Object.values(value)) replace(child)
  }
  replace(knowledge)
}
function patchAck(data: Graph3Inputs, operationId: string, change: (ack: SyncedHostCreateApplied) => void) {
  const material = initialAck(data, operationId), { table, row, knowledge } = originalRow(data, material.primary)
  const raw = graph3Text(row.cells[table.columns.indexOf('result_json')], knowledge.encoding)
  const envelope = JSON.parse(raw) as { kind: string; version: number; result: SyncedHostCreateApplied }
  assert.equal(envelope.kind, 'synced-host-create-operation')
  assert.equal(envelope.version, 1)
  change(envelope.result)
  patchOriginal(data, material.primary, { result_json: JSON.stringify(envelope) })
}
function rejectsJoin(data: Graph3Inputs, code: string, reason: string) {
  assert.throws(() => deriveRootRestoreProvenanceSources3(data), (error: unknown) => {
    assert.ok(error instanceof RestoreGraph3Conflict)
    assert.equal(error.code, code)
    assert.equal((error.detail as { reason: unknown }).reason, reason)
    return true
  })
}

test('actual original create ACK chains prove only instance births and preserve complete captured navigation hints', t => {
  let restoredGroup = '', firstOperation = '', undoOperation = '', redoOperation = ''
  return withContent3Fixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const prepared = await prepareRootRestoreProvenanceSources3(identity.plan), value = prepared.value
    const data = await readRootRestoreIdentityGraphInputs3(identity.plan), knowledge = data.inputs.source.knowledge
    const origin = (result: ReturnType<typeof deriveRootRestoreProvenanceSources3>, groupId: string) => {
      const entries = result.origins.filter(item => item.tuple.groupId === groupId)
      assert.equal(entries.length, 1)
      return entries[0]
    }
    const oracleRows = f.source.db.prepare('SELECT id,action_json FROM synced_host_history').all() as Array<{ id: string; action_json: string }>
    const oracle = new Map(oracleRows.map(row => [row.id, JSON.parse(row.action_json) as { input: HostCreateJournal['input']; create: HostCreateJournal['create'] }]))
    await t.test('every actual Main group joins its initial journal and ACK while document birth remains unknown despite unique physical evidence', () => {
      assert.ok(value.origins.length >= 3)
      assert.equal(value.origins.length, knowledge.groups.length)
      for (const group of knowledge.groups) {
        assert.ok(group.lifecycle?.createHistoryId)
        assert.ok(group.lifecycleSource)
        assert.ok(group.createJournalSource)
        const original = oracle.get(group.lifecycle.createHistoryId)
        assert.ok(original)
        const entry = origin(value, group.tuple.groupId)
        assert.equal(entry.comparisonKey, group.comparisonKey)
        assert.deepEqual(entry.groupSource, group.source)
        assert.equal(entry.originalOriginJson, group.originalOriginJson)
        assert.deepEqual(entry.origin, group.tuple.origin)
        assert.equal(entry.firstInstance.sourceId, group.tuple.origin.firstInstanceId)
        assert.equal(entry.firstInstance.status, 'proved-birth')
        assert.equal(entry.firstInstance.knownBirth, original.create.instanceCreatedAt)
        assert.equal(entry.firstInstance.reason, null)
        for (const support of [group.source, group.lifecycleSource, group.createJournalSource, initialAck(data, original.input.clientOperationId).primary])
          assert.ok(entry.firstInstance.supports.some(item => same(item, support)))
        const physicalDocument = identity.value.assignments.filter(item => item.kind === 'document'
          && item.sourceId === group.tuple.origin.documentId && item.physical)
        assert.equal(physicalDocument.length, 1)
        assert.notEqual(physicalDocument[0].birth, null)
        assert.equal(entry.document.sourceId, group.tuple.origin.documentId)
        assert.equal(entry.document.status, 'unresolved')
        assert.equal(entry.document.knownBirth, null)
        assert.deepEqual(entry.document.supports, [group.source])
      }
      assert.deepEqual(deriveRootRestoreProvenanceSources3(data), value)
      for (const flag of ['sourceRewriting', 'referenceRewriteComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const)
        assert.equal(value[flag], false)
    })
    await t.test('all captured keys source rows provenance families and stale live hints retain their original values', () => {
      assert.deepEqual(value.capturedBindings, f.sourcePacket.knowledge.bindings)
      assert.equal(value.hintsOnly, true)
      assert.equal(value.ordinaryNavigationCaptured, false)
      const stale = value.capturedBindings.find(capture => capture.binding.target.kind === 'heading'
        && capture.binding.target.documentId === f.source.targetId && capture.binding.target.slug === 'target-heading')
      assert.ok(stale)
      const target = stale.binding.target
      assert.ok(target.kind === 'heading')
      assert.equal(target.state, 'live')
      const physical = f.sourcePacket.source.physical.documents.find(document => document.documentId === target.documentId)
      assert.ok(physical)
      assert.ok(physical.blocks.some(block => block.id === f.source.targetBodyId && block.content === f.raw))
      assert.ok(value.capturedBindings.some(capture => capture.provenance === 'current-stored'))
      assert.ok(value.capturedBindings.some(capture => capture.provenance === 'create-journal'))
      assert.equal(Object.isFrozen(value.capturedBindings), true)
    })
    await t.test('fake copied and accessor handles grant neither provenance reads nor caller callouts', async () => {
      let getters = 0
      const fake = Object.defineProperty({}, 'kind', { get() { getters++; throw new Error('caller getter') } })
      await assert.rejects(prepareRootRestoreProvenanceSources3(fake as never))
      await assert.rejects(readRootRestoreProvenanceSources3(fake as never))
      await assert.rejects(prepareRootRestoreProvenanceSources3({ ...identity.plan }))
      await assert.rejects(readRootRestoreProvenanceSources3({ ...prepared.source }))
      assert.equal(getters, 0)
      assert.deepEqual(await readRootRestoreProvenanceSources3(prepared.source), value)
    })

    // 以下变更只作用于真实完整输入的独立 DTO 克隆，不改变实际 SQL，
    // 不构成新的 Main 来源认证、历史执行许可或已安装恢复的验收。
    await t.test('missing initial ACK facts stay unresolved even when real Undo and Redo ACKs for the same group remain', () => {
      const changed = structuredClone(data), k = changed.inputs.source.knowledge
      const original = initialAck(changed, firstOperation)
      for (const operation of [undoOperation, redoOperation]) assert.ok(k.historicalMaterial.some(item => item.fact.family === 'host-create-ack'
        && item.fact.locator.key[0] === operation))
      Reflect.set(k, 'historicalMaterial', k.historicalMaterial.filter(item => item !== original))
      const entry = origin(deriveRootRestoreProvenanceSources3(changed), restoredGroup)
      assert.equal(entry.firstInstance.status, 'unresolved')
      assert.equal(entry.firstInstance.knownBirth, null)
      assert.equal(entry.firstInstance.reason, 'initial-create-ack-fact-missing')
      assert.equal(entry.document.knownBirth, null)
    })
    await t.test('a group without an original create source cannot borrow current physical or retained instance births', () => {
      const changed = structuredClone(data), group = changed.inputs.source.knowledge.groups.find(item => item.tuple.groupId === restoredGroup)!
      Object.assign(group, { createJournalSource: null, lifecycle: null, lifecycleSource: null })
      const entry = origin(deriveRootRestoreProvenanceSources3(changed), restoredGroup)
      assert.ok(identity.value.assignments.some(item => item.kind === 'block' && item.sourceId === entry.firstInstance.sourceId && item.physical && item.birth !== null))
      assert.equal(entry.firstInstance.status, 'unresolved')
      assert.equal(entry.firstInstance.knownBirth, null)
      assert.equal(entry.firstInstance.reason, 'original-create-chain-unavailable')
      assert.equal(entry.document.knownBirth, null)
    })
    await t.test('rehashed original operation request token tuple and working-side contradictions reach the exact create join', () => {
      const request = structuredClone(data)
      const material = initialAck(request, firstOperation)
      patchOriginal(request, material.primary, { request_hash: 'f'.repeat(64) })
      rejectsJoin(request, 'contradictory-original-create-pair', 'original-request-hash')

      const token = structuredClone(data)
      patchAck(token, firstOperation, ack => {
        const replacement = randomUUID()
        ack.historyToken = replacement
        ack.createdLifecycle.createHistoryId = replacement
      })
      rejectsJoin(token, 'contradictory-original-create-pair', 'original-ack-stable-create-tuple')

      const tuple = structuredClone(data)
      patchAck(tuple, firstOperation, ack => {
        const replacement = randomUUID(), own = ack.groups.find(group => group.groupId === restoredGroup)!
        ack.createdLifecycle.creationId = replacement
        own.creationId = replacement
        ack.createdLifecycle.activationHash = createRawHash({ kind: 'synced-group', id: own.groupId,
          creationId: own.creationId, createdAt: own.createdAt, origin: own.origin, blocks: own.blocks, bindings: own.bindings })
      })
      rejectsJoin(tuple, 'contradictory-original-create-pair', 'original-ack-stable-create-tuple')

      const working = structuredClone(data)
      patchAck(working, firstOperation, ack => {
        ack.hosts[0].logicalBefore.title = 'A different original working title'
        ack.hosts[0].logicalBeforeHash = hostHash(ack.hosts[0].logicalBefore)
      })
      rejectsJoin(working, 'contradictory-original-create-pair', 'original-ack-working-and-after')

      const journal = structuredClone(data), group = journal.inputs.source.knowledge.groups.find(item => item.tuple.groupId === restoredGroup)!
      assert.ok(group.createJournalSource)
      const raw = originalRow(journal, group.createJournalSource), position = raw.table.columns.indexOf('action_json')
      const action = JSON.parse(graph3Text(raw.row.cells[position], raw.knowledge.encoding)) as { create: { wireHash: string } }
      action.create.wireHash = 'f'.repeat(64)
      patchOriginal(journal, group.createJournalSource, { action_json: JSON.stringify(action) })
      rejectsJoin(journal, 'provenance-declared-create-journal-mismatch', 'invalid-original-create-journal')
    })
    await t.test('hot reads reject changed durable kernels and actual verification SQL after a successful full reconstruction', async () => {
      const path = join(identity.directory, 'manifest.json'), bytes = await readFile(path)
      const manifest = JSON.parse(bytes.toString('utf8')) as { kernel: { seed: string } }
      manifest.kernel.seed = manifest.kernel.seed === '00'.repeat(32) ? 'ff'.repeat(32) : '00'.repeat(32)
      try {
        await writeFile(path, JSON.stringify(manifest) + '\n')
        await assert.rejects(readRootRestoreProvenanceSources3(prepared.source))
      } finally { await writeFile(path, bytes) }
      assert.deepEqual(await readFile(path), bytes)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreProvenanceSources3(prepared.source))
    })
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }, undefined, undefined, source => {
    const input = createRequest(source.db, { documentId: source.hostId, selectedRootIds: [source.hostBodyId] })
    const initial = created(applySyncedHostCommand(source.db, input))
    const undo = restoreCreated(source.db, initial, 'undo'), redo = restoreCreated(source.db, undo.ack, 'redo')
    assert.equal(undo.ack.createdLifecycle.state, 'retired-create')
    assert.equal(redo.ack.createdLifecycle.state, 'active')
    restoredGroup = input.action.groupId; firstOperation = input.clientOperationId
    undoOperation = undo.input.clientOperationId; redoOperation = redo.input.clientOperationId
  })
})
