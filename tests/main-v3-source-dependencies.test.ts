import assert from 'node:assert/strict'
import test from 'node:test'
import { hasNoV3RetirementHistoricalReferences } from '../src/main/backup/v3-restore-source-dependencies'

test('unrelated native formatting leaves V3 retirement eligible, while navigation and history still block it', () => {
  const heading = { type: 'heading-2', content: 'A different topic' }
  const list = { type: 'bulleted-list', content: 'An unrelated item' }
  const quote = { type: 'quote', content: 'A separate quotation' }
  const doc = { title: 'Retained document', summary: '', blocks: [heading, list] }
  const context = { sourceContent: { tables: [] }, physical: { documents: [doc], instances: [], groups: [
    { groupId: 'retained', snapshot: { bindings: [], blocks: [quote] } }
  ] } }
  assert.equal(hasNoV3RetirementHistoricalReferences(context, 'retired'), true)

  for (const content of ['[[Original#^retired-block]]', '[Reference](Old.md#^retired-block)', '<a href="Old.md#^retired-block">Old</a>']) {
    assert.equal(hasNoV3RetirementHistoricalReferences({ ...context, physical: { ...context.physical, documents: [
      { ...doc, blocks: [heading, { ...list, content }] }
    ] } }, 'retired'), false)
  }
  assert.equal(hasNoV3RetirementHistoricalReferences({ ...context, sourceContent: { tables: [
    { name: 'synced_group_history', rows: [{}] }
  ] } }, 'retired'), false)
})
