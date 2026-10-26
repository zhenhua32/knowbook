import assert from 'node:assert/strict'
import test from 'node:test'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { collectSyncedBindingOccurrences } from '../src/main/sync/synced-binding-occurrences'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withReference3CurrentHintFixture } from './helpers/reference3-current-hint-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreReferencePlan3>>['value']
function rows(value: Value, name: string) {
  const table = value.candidate.tables.find(table => table.name === name)!
  return table.rows.map(row => ({ row, value: Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  })) as Record<string, unknown> }))
}

test('a retained current canonical definition keeps its actual live same-birth target despite a stale missing hint', () =>
  withReference3CurrentHintFixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.captured.knowledgePlan)
    const prepared = await prepareRootRestoreReferencePlan3(identity.plan), value = prepared.value, { allocation, candidate } = value
    assert.equal(f.restoredBirth, f.birth)
    assert.equal(allocation.origins.some(origin => origin.side === 'source' && origin.sourceGroupId === f.groupId), false,
      'The definition group only exists in current, so source policy cannot change its targets')
    const target = allocation.bindingTargets.find(item => item.side === 'current' && item.sourceGroupId === f.groupId)!
    assert.equal(target.proofKind, 'current-domain-preserved')
    assert.deepEqual(target.originalTarget, f.missingBinding.target)
    assert.deepEqual(target.target, f.missingBinding.target)
    const wire = candidate.activeGroupWires.find(wire => wire.id === f.groupId)!
    assert.deepEqual(wire.bindings, [f.missingBinding])
    assert.equal(wire.blocks.find(block => block.id === f.definitionId)!.content, f.definition)
    const destination = collectSyncedBindingOccurrences(wire.origin, wire.blocks).find(link => link.blockId === f.definitionId)!
    assert.equal(destination.url, f.url.replace('#^', '#%5E'), 'The parser normalizes the caret while the source cell stays byte-identical')
    const finalTarget = rows(value, 'blocks').find(entry => entry.value.id === f.blockId)!
    assert.equal(finalTarget.value.document_id, f.targetId)
    assert.equal(finalTarget.value.created_at, f.birth)
    assert.equal(finalTarget.row.sourceRef.side, 'source')
    assert.equal(finalTarget.row.replaces?.side, 'current')
    const consumer = rows(value, 'blocks').find(entry => entry.value.id === f.useId)!
    assert.equal(consumer.row.sourceRef.side, 'current')
    assert.equal(consumer.value.content, f.use)
    const host = rows(value, 'documents').find(entry => entry.value.id === f.consumerHostId)!
    const raw = resolveMarkdownDocumentPath(String(host.value.path), destination.url)!
    assert.equal(raw.fragment, '^' + f.blockId)
    const rawDocuments = rows(value, 'documents').filter(entry => entry.value.path === raw.path)
    assert.equal(rawDocuments.length, 1)
    assert.equal(rawDocuments[0].value.id, f.targetId,
      'The final raw href already resolves to this unchanged stable target, not a new occupant')
    assert.deepEqual(candidate.conflicts.filter(conflict => conflict.code === 'canonical3-unproved-definition-target-became-live'), [],
      'A stale state hint must not manufacture a target-promotion conflict')
    assert.equal(candidate.candidateConflictFree, true)
    assert.equal(candidate.referenceRewriteComplete, false); assert.equal(candidate.permit, false)
    assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
