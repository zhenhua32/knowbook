import assert from 'node:assert/strict'
import type { DocumentBlockDraft } from '../../src/shared/contracts'
import { withContent3Fixture } from './content3-fixture'
import { applySyncedHostCommand, createRequest, created, randomUUID, snapshot } from './synced-backup-v3-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { editCreatedGroup } from './synced-host-command-create-fixture'

type Content3Fixture = Parameters<Parameters<typeof withContent3Fixture>[0]>[0]
type Source = Content3Fixture['source']
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })

/** 一个实际原件对同时覆盖普通导航、独立 summary、完整同步 heading
 * 投影、历史 route 和原件路径歧义。所有同步 create/insert 及 move 都是真实
 * Main/Store writer；最后 raw 普通存储接缝只保存需原字节观察的正文/路径。 */
function seedNavigation3(source: Source) {
  const make = (title: string, blocks: DocumentBlockDraft[], parentId: string | null = null) => {
    const id = source.store.createDocument(parentId)
    source.store.updateDocument(id, { title, summary: '', blocks })
    return id
  }
  const targetHeadingId = randomUUID(), targetBodyId = randomUUID(), uuidHeadingId = randomUUID(), uuidHeadingText = randomUUID()
  const targetId = make('Navigation Target', [{ ...paragraph(targetHeadingId, 'Live heading'), type: 'heading-1' },
    paragraph(targetBodyId, 'Original navigation target'), { ...paragraph(uuidHeadingId, uuidHeadingText), type: 'heading-2' }])
  const foreignBlockId = randomUUID(), foreignId = make('Navigation Foreign', [paragraph(foreignBlockId, 'A foreign physical block')])
  const routeBlockId = randomUUID(), oldRemainingId = randomUUID()
  const oldOwnerId = make('Navigation Old', [paragraph(routeBlockId, 'The moved stable block'), paragraph(oldRemainingId, 'Old owner survives')])
  const from = source.store.getDocumentDetail(oldOwnerId), to = source.store.getDocumentDetail(targetId)
  assert.ok(from && to)
  const move = source.store.moveDocumentBlocks({ fromDocumentId: oldOwnerId, toDocumentId: targetId, blockIds: [routeBlockId],
    expectedFromUpdatedAt: from.updatedAt, expectedToUpdatedAt: to.updatedAt })
  assert.equal(move.state, 'applied')
  assert.ok(source.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get('Navigation Old', routeBlockId))

  const repeatedCanonicalHeadingId = randomUUID(), repeatedCanonicalExternalId = randomUUID()
  const repeatedHostId = make('Navigation Repeated', [paragraph(repeatedCanonicalHeadingId, 'Echo'),
    paragraph(repeatedCanonicalExternalId, '[external](https://example.invalid/opaque)')])
  const create = createRequest(source.db, { documentId: repeatedHostId, selectedRootIds: [repeatedCanonicalHeadingId, repeatedCanonicalExternalId] })
  const createResult = applySyncedHostCommand(source.db, create)
  assert.equal(createResult.status, 'applied', JSON.stringify(createResult))
  created(createResult)
  // The current create gate deliberately refuses heading rewrites. A genuine
  // post-create content edit supplies the heading, as in the cold fixture.
  editCreatedGroup(source.db, create.action.groupId, snapshot(source.db, create.action.groupId).blocks
    .map(({ createdAt: _birth, ...block }) => ({ ...block, type: block.id === repeatedCanonicalHeadingId ? 'heading-1' : block.type })))
  const insert = command(source.db, { documentId: repeatedHostId, groupId: create.action.groupId })
  insertAck(applySyncedHostCommand(source.db, insert))

  const ambiguousBodyA = randomUUID(), ambiguousBodyB = randomUUID()
  const ambiguousA = make('Navigation Twin', [paragraph(ambiguousBodyA, 'Ambiguous A')], source.hostId)
  const ambiguousB = make('Navigation Twin', [paragraph(ambiguousBodyB, 'Ambiguous B')], source.targetId)
  const unicodeUpperId = make('Navigation Unicode Upper', [paragraph(randomUUID(), 'Upper non-ASCII path')])
  const unicodeLowerId = make('Navigation Unicode Lower', [paragraph(randomUUID(), 'Lower non-ASCII path')])
  const bodyUseId = randomUUID(), definitionId = randomUUID(), inactiveDefinitionId = randomUUID()
  const directId = randomUUID(), contextualId = randomUUID(), opaqueCodeId = randomUUID(), bareWikiMovedId = randomUUID()
  const hostId = make('Navigation Host', [paragraph(bodyUseId, 'Pending original body use'), paragraph(definitionId, 'Pending original definition'),
    paragraph(inactiveDefinitionId, 'Pending inactive definition'), paragraph(directId, 'Pending direct link'),
    paragraph(contextualId, 'Pending contextual links'), { ...paragraph(opaqueCodeId, '[opaque](/Navigation%20Target.md)'), type: 'code', language: 'text' },
    paragraph(bareWikiMovedId, 'A bare wiki historical route target')])
  const bareFrom = source.store.getDocumentDetail(hostId), bareTo = source.store.getDocumentDetail(targetId)
  assert.ok(bareFrom && bareTo)
  const bareMove = source.store.moveDocumentBlocks({ fromDocumentId: hostId, toDocumentId: targetId, blockIds: [bareWikiMovedId],
    expectedFromUpdatedAt: bareFrom.updatedAt, expectedToUpdatedAt: bareTo.updatedAt })
  assert.equal(bareMove.state, 'applied')
  assert.equal(source.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get('Navigation Host', directId), undefined)
  assert.ok(source.db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get('Navigation Host', bareWikiMovedId))
  const bodyUse = '[first][shared] and [second][shared]'
  const definition = '[shared]: /Navigation%20Target.md#live-heading "source title"'
  const inactiveDefinition = '[shared]: /Never%20Active.md#wrong "inactive duplicate"'
  const direct = '😀 Prefix [direct](/Navigation%20Target.md#live-heading "physical title")\r\n'
    + '<a href="/Navigation%20Target.md#live-heading">HTML kept</a>'
  const contextual = [
    '[[Navigation Target#Live heading|kept alias]]',
    '[route](/Navigation%20Old.md#^' + routeBlockId + ')',
    '[not-global](/Navigation%20Target.md#^' + foreignBlockId + ')',
    '[first echo](/Navigation%20Repeated.md#echo)',
    '[second echo](/Navigation%20Repeated.md#echo-1)',
    '[uuid heading](/Navigation%20Target.md#' + uuidHeadingText + ')',
    '[[Navigation Target#' + uuidHeadingText + ']]',
    '[[' + directId + ']]',
    '[[^' + directId + ']]',
    '[[^' + bareWikiMovedId + ']]',
    '[ambiguous exact](/Navigation%20Duplicate.md)',
    '[ambiguous heading](/Navigation%20Duplicate.md#navigation-twin)',
    '[exact ambiguous block](/Navigation%20Duplicate.md#^' + ambiguousBodyA + ')',
    '[ambiguous ASCII](/navigation%20duplicate.md)',
    '[[navigation duplicate]]',
    '[[Navigation Twin]]',
    '[[ÄPFEL]]'
  ].join('\n')
  const summary = '[summary-only][shared] and [summary-direct](/Navigation%20Target.md#live-heading)'
  const templateBlockId = source.hostBodyId, templateContent = '[late target](/Template%20Late.md#future) [[{{title}}]]'
  const template = source.store.saveDocumentTemplate({ name: 'Navigation deferred template', title: '{{title}}', summary: '[late summary]({{path}})',
    blocks: [paragraph(templateBlockId, templateContent)] })
  assert.equal(template.blocks[0].id, templateBlockId)
  return { hostId, targetId, targetHeadingId, targetBodyId, uuidHeadingId, uuidHeadingText, bareWikiMovedId,
    foreignId, foreignBlockId, oldOwnerId, routeBlockId,
    routeFromPath: 'Navigation Old', routeCurrentOwnerId: targetId, moveOperationId: move.operationId,
    repeatedHostId, repeatedGroupId: create.action.groupId, repeatedCanonicalHeadingId, repeatedCanonicalExternalId,
    repeatedInstanceIds: [create.action.instanceId, insert.action.instanceId], ambiguousDocumentIds: [ambiguousA, ambiguousB],
    ambiguousBodyA, ambiguousBodyB,
    unicodeUpperId, unicodeLowerId, bodyUseId, definitionId, inactiveDefinitionId, directId, contextualId, opaqueCodeId,
    bodyUse, definition, inactiveDefinition, direct, contextual, summary, templateId: template.id, templateBlockId, templateContent }
}
export type Navigation3Cases = ReturnType<typeof seedNavigation3>
export type Navigation3Fixture = Content3Fixture & { navigation: Navigation3Cases }

export async function withNavigation3Fixture(run: (fixture: Navigation3Fixture) => Promise<void>) {
  let navigation: Navigation3Cases | undefined
  const ready = () => { assert.ok(navigation); return navigation }
  return withContent3Fixture(f => run({ ...f, navigation: ready() }), source => {
    const n = ready()
    // 接收侧让另一真实文档占用来源旧路径。导航来源必须从封存 source
    // 取得，不能重查 current 的同路径对象；原 document birth 都保持。
    source.db.prepare('UPDATE documents SET path=? WHERE id=?').run('Current Navigation Target', n.targetId)
    source.db.prepare('UPDATE documents SET path=? WHERE id=?').run('Navigation Target', n.foreignId)
  }, source => {
    const n = ready(), write = source.db.prepare('UPDATE blocks SET content=? WHERE id=?')
    for (const [id, content] of [[n.bodyUseId, n.bodyUse], [n.definitionId, n.definition], [n.inactiveDefinitionId, n.inactiveDefinition],
      [n.directId, n.direct], [n.contextualId, n.contextual]]) write.run(content, id)
    source.db.prepare('UPDATE documents SET summary=? WHERE id=?').run(n.summary, n.hostId)
    // 原件读取器明确保留这些合法普通历史路径，不据路径猜树身份。
    for (const id of n.ambiguousDocumentIds) source.db.prepare('UPDATE documents SET path=? WHERE id=?').run('Navigation Duplicate', id)
    write.run('[explicit duplicated self](/Navigation%20Duplicate.md) [bare self](#navigation-twin)', n.ambiguousBodyA)
    source.db.prepare('UPDATE documents SET path=? WHERE id=?').run('Äpfel', n.unicodeUpperId)
    source.db.prepare('UPDATE documents SET path=? WHERE id=?').run('äpfel', n.unicodeLowerId)
  }, source => { navigation = seedNavigation3(source) })
}
