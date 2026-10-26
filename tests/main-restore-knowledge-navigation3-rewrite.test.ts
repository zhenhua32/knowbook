import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreNavigationRewritePlan3, readRootRestoreNavigationRewritePlan3 }
  from '../src/main/database/restore-knowledge-navigation3-rewrite-read'
import type { Merge3ContentTable } from '../src/main/database/restore-knowledge-merge3-storage'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { withNavigation3RewriteFixture } from './helpers/navigation3-rewrite-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreNavigationRewritePlan3>>['value']
function rows(value: Value, name: Merge3ContentTable) {
  const table = value.tables.find(table => table.name === name)
  assert.ok(table)
  return table.rows.map(row => ({ row, values: Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  })) as Record<string, unknown> }))
}
function byId(value: Value, name: 'documents' | 'blocks', id: string) {
  const matches = rows(value, name).filter(entry => entry.values.id === id)
  assert.equal(matches.length, 1)
  return matches[0]
}

test('actual Main navigation rewrite uses both original identities and exact final candidate text without installing it', t =>
  withNavigation3RewriteFixture(async f => {
    const n = f.navigationRewrite, identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const choice: { anonymousValues: 'source' | 'current' | 'unresolved' } = { anonymousValues: 'source' }
    const prepared = await prepareRootRestoreNavigationRewritePlan3(identity.plan, choice), value = prepared.value
    choice.anonymousValues = 'current'
    const mapped = (kind: 'document' | 'block', id: string) => {
      const matches = identity.value.assignments.filter(item => item.physical && item.kind === kind && item.sourceId === id)
      assert.equal(matches.length, 1)
      return matches[0].targetId
    }
    const content = (id: string, side: 'source' | 'current' = 'source') =>
      String(byId(value, 'blocks', side === 'source' ? mapped('block', id) : id).values.content)

    await t.test('source old-path links reach their final document while retained current links keep the old-path occupant', () => {
      const target = byId(value, 'documents', mapped('document', n.targetId))
      assert.equal(target.values.path, n.finalPath)
      assert.equal(target.values.title, n.finalPath)
      assert.equal(byId(value, 'documents', n.occupantId).values.path, n.legacyPath)
      assert.notEqual(mapped('document', n.targetId), n.occupantId)
      const expected = '[[Rewrite Final Target#echo|source alias]] [block](' + n.finalUrl + '#^' + mapped('block', n.targetBodyId)
        + ') [document](' + n.finalUrl + ') ![opaque image](' + n.oldUrl + '#echo)'
      assert.equal(content(n.contextualId), expected)
      const retainedExpected = '[current occupant](' + n.oldUrl + ') [stable section](' + n.finalUrl + '#echo)'
        + ' [leaf](/Rewrite%20Final%20Target/Retained%20Leaf.md#leaf)'
      assert.equal(content(n.retainedDirectId, 'current'), retainedExpected)
      assert.equal(content(n.opaqueId), n.opaque)
      assert.equal(content(n.retainedOpaqueId, 'current'), n.retainedOpaque)
    })

    await t.test('every duplicate Markdown and HTML destination has its own original UTF16 CRLF range', () => {
      const originalUrl = n.oldUrl + '#echo', finalUrl = n.finalUrl + '#echo'
      const entry = byId(value, 'blocks', mapped('block', n.directId))
      assert.equal(entry.values.content, n.direct.split(originalUrl).join(finalUrl))
      const edits = value.edits.filter(edit => edit.side === 'source' && edit.table === 'blocks'
        && edit.rowKey === entry.row.key && edit.column === 'content').sort((a, b) => a.from - b.from)
      const expectedPositions = [...n.direct.matchAll(/\/Rewrite%20Legacy%20Target\.md#echo/g)].map(match => match.index)
      assert.equal(edits.length, 3)
      assert.deepEqual(edits.map(edit => edit.from), expectedPositions)
      for (const edit of edits) {
        assert.equal(edit.before, originalUrl)
        assert.equal(edit.after, finalUrl)
        assert.equal(n.direct.slice(edit.from, edit.to), edit.before)
      }
      assert.match(String(entry.values.content), /\r\n<a href=/)
      assert.equal(String(entry.values.content).split('😀').length, 2)
      assert.match(String(entry.values.content), /"kept title"/)
      assert.equal(entry.row.sourceRef.side, 'source')
    })

    await t.test('cross-block first definitions are rewritten once and summary reference environments stay independent', () => {
      assert.equal(content(n.useId), n.use)
      assert.equal(content(n.definitionId), n.definition.replace(n.oldUrl, n.finalUrl))
      assert.equal(content(n.duplicateDefinitionId), n.duplicateDefinition)
      assert.equal(content(n.retainedUseId, 'current'), n.retainedUse)
      assert.equal(content(n.retainedDefinitionId, 'current'), n.retainedDefinition.replace(n.currentUrl + '#echo-1', n.finalUrl + '#echo'))
      assert.equal(byId(value, 'documents', mapped('document', n.sourceHostId)).values.summary,
        n.summary.replace(n.oldUrl, n.finalUrl))
      assert.equal(byId(value, 'documents', n.retainedHostId).values.summary,
        n.retainedSummary.replace(n.currentUrl + '#echo-1', n.finalUrl + '#echo'))
      for (const [id, side] of [[n.useId, 'source'], [n.retainedUseId, 'current']] as const) {
        const row = byId(value, 'blocks', side === 'source' ? mapped('block', id) : id)
        assert.equal(value.edits.some(edit => edit.rowKey === row.row.key && edit.column === 'content'), false)
      }
    })

    await t.test('a retained ordinary consumer cannot inherit the replacing source canonical first definition silently', () => {
      const use = byId(value, 'blocks', n.environmentUseId)
      assert.equal(use.values.content, n.environmentUse)
      assert.equal(content(n.environmentFallbackId, 'current'), n.environmentFallback)
      const group = mapped('block', n.canonicalDefinitionId)
      const canonical = rows(value, 'synced_group_blocks').filter(entry => entry.values.id === group)
      assert.equal(canonical.length, 1)
      assert.equal(canonical[0].values.content, n.canonicalDefinition,
        'Captured canonical text stays pending and is never rewritten as an ordinary destination')
      assert.ok(value.conflicts.some(item => (item.code === 'definition-environment-changed'
        || item.code === 'ordinary-navigation-semantic-unit-changed') && item.rowKeys.includes(use.row.key)),
      'The complete final expanded environment must reject a different first definition for this exact retained ordinary consumer')
      assert.equal(value.canonicalBindingsRewritten, false)
    })

    await t.test('the retained descendant follows its real final parent and a surviving heading follows identity rather than the old slug', () => {
      assert.equal(byId(value, 'documents', n.leafId).values.path, n.leafFinalPath)
      assert.equal(byId(value, 'documents', n.leafId).values.parent_id, mapped('document', n.targetId))
      assert.equal(content(n.leafBodyId, 'current'), '[parent](../Rewrite%20Final%20Target.md#echo) [bare self](#leaf)')
      assert.equal(content(n.firstEchoId), 'Echo')
      assert.equal(content(n.secondEchoId), 'Echo')
      assert.equal(rows(value, 'blocks').some(entry => entry.values.id === n.deletedHeadingId || entry.values.id === n.deletedBlockId), false)
      const removed = byId(value, 'blocks', n.retainedMissingId)
      // The old #echo belonged to the deleted current-only heading. A final
      // heading reuses that fragment, while the old full current path is gone.
      // This checks deletion provenance, not a same-full-path activation.
      assert.ok(value.unresolved.some(item => item.rowKey === removed.row.key))
      assert.ok(value.unresolved.length >= 3, 'Removed heading, removed block and originally missing source document are explicit unresolved destinations')
      assert.equal(byId(value, 'documents', n.futureOccupantId).values.path, 'Future Occupied')
      const missing = byId(value, 'blocks', mapped('block', n.missingId))
      assert.equal(missing.values.content, n.missing)
      assert.ok(value.unresolved.some(item => item.side === 'source' && item.rowKey === missing.row.key))
      assert.ok(value.conflicts.some(item => item.code === 'unresolved-navigation-became-live'
        && item.rowKeys.includes(missing.row.key)), 'A newly occupied missing source path must produce a typed conflict instead of being accepted as a live target')
    })

    await t.test('all twelve candidate tables remain preview-only and both live SQLite stores are unchanged', () => {
      assert.equal(value.tables.length, 12)
      assert.ok(value.edits.length >= 10)
      const knownConflictRows = new Set([
        byId(value, 'blocks', mapped('block', n.missingId)).row.key,
        byId(value, 'blocks', n.environmentUseId).row.key,
        byId(value, 'blocks', n.environmentFallbackId).row.key
      ])
      for (const item of value.conflicts) {
        assert.ok(['unresolved-navigation-became-live', 'definition-environment-changed', 'ordinary-navigation-semantic-unit-changed'].includes(item.code), item.code)
        assert.ok(item.rowKeys.every(key => knownConflictRows.has(key)), JSON.stringify(item))
      }
      for (const projection of value.projections) {
        const expected = projection.expectedTarget, actual = projection.actualTarget
        if (!expected) continue
        assert.ok(actual && 'documentId' in actual)
        assert.equal(actual.kind, expected.kind); assert.equal(actual.documentId, expected.documentId)
        if (expected.kind === 'heading') assert.equal(actual.headingKey, expected.headingKey)
        if (expected.kind === 'block') assert.equal(actual.blockId, expected.blockId)
      }
      assert.match(value.checkedNavigationRewriteHash, /^[0-9a-f]{64}$/)
      for (const flag of ['referenceRewriteComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const)
        assert.equal(value[flag], false)
      assert.deepEqual(allTables(f.source.db), f.beforeSource)
      assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })

    await t.test('only private actual owners and finite closed choices can reopen this full reconstruction', async () => {
      await assert.rejects(prepareRootRestoreNavigationRewritePlan3({ ...identity.plan }))
      await assert.rejects(readRootRestoreNavigationRewritePlan3({ ...prepared.plan }))
      let getterReads = 0
      const getter = Object.defineProperty({}, 'anonymousValues', { enumerable: true,
        get() { getterReads++; return 'source' } })
      await assert.rejects(prepareRootRestoreNavigationRewritePlan3(identity.plan, getter as never))
      assert.equal(getterReads, 0)
      await assert.rejects(prepareRootRestoreNavigationRewritePlan3(identity.plan, { anonymousValues: 'both' } as never))
      await assert.rejects(prepareRootRestoreNavigationRewritePlan3(identity.plan, { anonymousValues: 'source', rows: [] } as never))
      assert.deepEqual(await readRootRestoreNavigationRewritePlan3(prepared.plan), value)
    })

    await t.test('each read authenticates the durable kernel and the actual verification originals again', async () => {
      const manifestPath = join(identity.directory, 'manifest.json'), manifest = await readFile(manifestPath)
      try {
        await writeFile(manifestPath, Buffer.concat([manifest, Buffer.from(' ')]))
        await assert.rejects(readRootRestoreNavigationRewritePlan3(prepared.plan))
      } finally { await writeFile(manifestPath, manifest) }
      assert.deepEqual(await readRootRestoreNavigationRewritePlan3(prepared.plan), value)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreNavigationRewritePlan3(prepared.plan))
      assert.deepEqual(allTables(f.source.db), f.beforeSource)
      assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })
  }))
