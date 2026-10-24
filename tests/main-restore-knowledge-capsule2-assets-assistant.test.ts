import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { assistantApprovalId, assistantStepId, assistantToolCallId, assistantTurnId } from '../src/shared/assistant-session'
import { collectStoredMarkdownAssetDestinations } from '../src/shared/syncedBlockPortable'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { readRawCapsule2AssetReferencesOwned, type RawCapsule2AssetReferences } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { projectEvents } from '../src/renderer/src/components/AssistantConversation'
import { AiAnswerContent } from '../src/renderer/src/components/AiAnswerContent'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

function begin(f: V3Fixture, label = 'assistant-assets', modelConfig: { literal: string } | null = null) {
  const repository = f.store.assistantSessions
  const session = repository.createSession({ workspaceId: 'actual-asset-workspace', title: label, modelConfig })
  const turnId = assistantTurnId(label + ':turn'), stepId = assistantStepId(label + ':step')
  repository.append(session.id, { type: 'turn.started', payload: { turnId } })
  repository.append(session.id, { type: 'step.started', payload: { turnId, stepId, provider: 'actual', model: 'actual', visibleTools: [] } })
  const text = (type: 'assistant.chunk' | 'assistant.message', text: string, step = stepId, turn = turnId) =>
    repository.append(session.id, { type, payload: { turnId: turn, stepId: step, text } })
  return { repository, session, turnId, stepId, text }
}
const producer = (db: Database.Database) => ['assistant_sessions', 'assistant_events'].map(table => ({ table, rows: db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() }))
async function observe(f: V3Fixture, run: (value: RawCapsule2AssetReferences) => void) {
  const before = producer(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const raw = readRawCapsule2ContentOwned(db), value = readRawCapsule2AssetReferencesOwned(db)
    run(value)
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    assert.equal(value.sourceFileOwnershipVerified, false); assert.equal(value.sourceFileBytesVerified, false)
    assert.deepEqual(readRawCapsule2ContentOwned(db), raw)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(producer(f.db), before)
}
const scopes = (value: RawCapsule2AssetReferences) => value.scopes.filter(scope => scope.source[0] === 'assistant_events')
const projectionHash = (text: string) => capsuleBytesHash('knowbook.capsule2.asset-assistant-markdown-projection.v1\0' + JSON.stringify(text))

test('capsule2 assistant assets retain the actual complete rendered Markdown message and original UTF16 positions', () => withV3Fixture(async f => {
  const [asset] = await f.assets.import([{ name: '真实 reply alias.png', bytes: Buffer.from('Actual assistant source attachment') }])
  const actual = begin(f), body = `🔎 原文 [attachment](<${asset.url}>)`
  const event = actual.text('assistant.message', body)
  const rendered = projectEvents(actual.repository.listEvents(actual.session.id)).items.filter(item => item.kind === 'message' && item.role === 'assistant')
  assert.equal(rendered.length, 1); assert.equal(rendered[0].kind === 'message' && rendered[0].text, body)
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === event.id)
    assert.ok(scope)
    assert.equal(scope.bodyProjectionHash, projectionHash(body))
    assert.deepEqual(scope.assistant?.parts, [{ eventId: event.id, seq: event.seq, turnId: actual.turnId, from: 0, to: body.length }])
    const destination = scope.destinations.find(item => item.uri === asset.url)
    assert.ok(destination); assert.equal(destination.section, 'body'); assert.equal(body.slice(destination.from, destination.to), destination.raw)
  })
}))

test('capsule2 assistant assets assemble real chunk references and URI fragments before Markdown parsing with complete event ranges', () => withV3Fixture(async f => {
  const actual = begin(f), uri = 'knowbook-asset://future/streamed', parts = ['🔎 ![shared][image]\n\n[image]: <knowbook-', 'asset://future/', 'streamed>']
  const events = parts.map(text => actual.text('assistant.chunk', text)), body = parts.join('')
  const rendered = projectEvents(actual.repository.listEvents(actual.session.id)).items
  assert.ok(rendered.some(item => item.kind === 'message' && item.text === body))
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === events[0].id)
    assert.ok(scope); assert.equal(scope.assistant?.kind, 'retained-stream')
    assert.ok(scope.assistant)
    let from = 0
    assert.deepEqual(scope.assistant.parts, events.map((event, index) => { const part = { eventId: event.id, seq: event.seq, turnId: actual.turnId, from, to: from + parts[index].length }; from = part.to; return part }))
    assert.equal(scope.bodyProjectionHash, projectionHash(body)); assert.ok(scope.destinations.some(item => item.uri === uri))
    for (const item of scope.destinations) assert.equal(body.slice(item.from, item.to), item.raw)
    assert.equal(Object.isFrozen(scope.assistant.parts), true)
  })
}))

test('capsule2 assistant assets preserve cross-chunk code and math exclusions and the actual literal-comment image grammar', () => withV3Fixture(async f => {
  const actual = begin(f), hidden = 'knowbook-asset://future/hidden', visible = 'knowbook-asset://future/visible', comment = 'knowbook-asset://future/literal-comment'
  const parts = ['```markdown\n![code](knowbook-', `asset://future/hidden)\n\n`, '```\n\n`[inline](knowbook-asset://future/hidden)`\n\n<!-- ', `![comment](${comment}) -->\n\n$$\n[math](${hidden})\n$$\n\n`, `[visible](${visible})`]
  const rendered = renderToStaticMarkup(createElement(AiAnswerContent, { content: `<!-- ![comment](${comment}) -->` }))
  assert.ok(rendered.includes('&lt;!--') && rendered.includes(comment), 'The existing renderer retains these comment-looking markers as literal text around an image token')
  const events = parts.map(text => actual.text('assistant.chunk', text))
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === events[0].id)
    assert.ok(scope); assert.deepEqual(scope.destinations.map(item => item.uri), [comment, visible])
  })
}))

test('capsule2 assistant assets retain the prior complete stream after a genuine final message replaces it in the renderer', () => withV3Fixture(async f => {
  const actual = begin(f), streamUri = 'knowbook-asset://future/prior-stream', finalUri = 'knowbook-asset://future/final'
  const chunk = actual.text('assistant.chunk', `[preview](${streamUri})`), final = actual.text('assistant.message', `[final](${finalUri})`)
  const rendered = projectEvents(actual.repository.listEvents(actual.session.id)).items.filter(item => item.kind === 'message')
  assert.equal(rendered.length, 1); assert.equal(rendered[0].key, final.id)
  await observe(f, value => {
    const found = scopes(value)
    assert.ok(found.find(scope => scope.source[1] === chunk.id)?.destinations.some(item => item.uri === streamUri))
    assert.ok(found.find(scope => scope.source[1] === final.id)?.destinations.some(item => item.uri === finalUri))
    assert.equal(found.length, 2)
  })
}))

test('capsule2 assistant assets start a distinct retained stream after the same real step receives its final message', () => withV3Fixture(async f => {
  const actual = begin(f), first = actual.text('assistant.chunk', '[first](knowbook-asset://future/first)')
  actual.text('assistant.message', '[final](knowbook-asset://future/final)')
  const next = actual.text('assistant.chunk', '[next](knowbook-asset://future/next)')
  await observe(f, value => {
    const found = scopes(value).filter(scope => scope.assistant?.kind === 'retained-stream')
    assert.equal(found.length, 2)
    assert.deepEqual(found.map(scope => scope.assistant?.parts.map(part => part.eventId)).sort(), [[first.id], [next.id]].sort())
  })
}))

test('capsule2 assistant assets keep independently interleaved actual step streams separate', () => withV3Fixture(async f => {
  const actual = begin(f), other = assistantStepId('other-stream')
  actual.repository.append(actual.session.id, { type: 'step.started', payload: { turnId: actual.turnId, stepId: other, provider: 'actual', model: 'actual', visibleTools: [] } })
  const a = actual.text('assistant.chunk', '[a](knowbook-'), b = actual.text('assistant.chunk', '[b](knowbook-', other)
  actual.text('assistant.chunk', 'asset://future/a)'); actual.text('assistant.chunk', 'asset://future/b)', other)
  await observe(f, value => {
    assert.deepEqual(scopes(value).find(scope => scope.source[1] === a.id)?.destinations.map(item => item.uri), ['knowbook-asset://future/a'])
    assert.deepEqual(scopes(value).find(scope => scope.source[1] === b.id)?.destinations.map(item => item.uri), ['knowbook-asset://future/b'])
  })
}))

test('capsule2 assistant assets never join chunks from different genuine sessions even when their stored step IDs match', () => withV3Fixture(async f => {
  const a = begin(f, 'session-A'), b = begin(f, 'session-B'), shared = assistantStepId('same-literal-step')
  a.text('assistant.chunk', '[cross](knowbook-', shared); b.text('assistant.chunk', 'asset://future/cross)', shared)
  await observe(f, value => { assert.equal(scopes(value).length, 2); assert.ok(scopes(value).every(scope => scope.destinations.length === 0)) })
}))

test('capsule2 assistant assets preserve the actual renderer step-key meaning across ended turns without inventing source normalization', () => withV3Fixture(async f => {
  const actual = begin(f), a = actual.text('assistant.chunk', '[legacy](knowbook-')
  actual.repository.append(actual.session.id, { type: 'turn.ended', payload: { turnId: actual.turnId, status: 'completed' } })
  const nextTurn = assistantTurnId('actual-next-turn')
  actual.repository.append(actual.session.id, { type: 'turn.started', payload: { turnId: nextTurn } })
  const b = actual.text('assistant.chunk', 'asset://future/legacy)', actual.stepId, nextTurn), expected = '[legacy](knowbook-asset://future/legacy)'
  assert.ok(projectEvents(actual.repository.listEvents(actual.session.id)).items.some(item => item.kind === 'message' && item.text === expected))
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === a.id)
    assert.ok(scope); assert.deepEqual(scope.assistant?.parts.map(part => [part.eventId, part.turnId]), [[a.id, actual.turnId], [b.id, nextTurn]])
    assert.ok(scope.destinations.some(item => item.uri === 'knowbook-asset://future/legacy'))
  })
}))

test('capsule2 assistant assets keep real user inbox tool approval and model fields as their original non-Markdown roles', () => withV3Fixture(async f => {
  const literal = '[opaque](knowbook-asset://future/not-a-message)', actual = begin(f, 'opaque-assets', { literal }), tool = assistantToolCallId('actual-tool'), approvalId = assistantApprovalId('actual-approval')
  actual.repository.append(actual.session.id, { type: 'user.message', payload: { turnId: actual.turnId, text: literal, attachments: [{ literal }] } })
  actual.repository.append(actual.session.id, { type: 'inbox.message', payload: { messageId: 'actual-inbox', text: literal, mode: 'next-turn' } })
  actual.repository.append(actual.session.id, { type: 'tool.call', payload: { turnId: actual.turnId, stepId: actual.stepId, toolCallId: tool, tool: 'actual.read', version: 1, arguments: { literal }, reasoningContent: literal } })
  actual.repository.append(actual.session.id, { type: 'tool.result', payload: { turnId: actual.turnId, stepId: actual.stepId, toolCallId: tool, status: 'failed', result: { message: literal } } })
  actual.repository.append(actual.session.id, { type: 'approval.requested', payload: { turnId: actual.turnId, toolCallId: tool, approvalId, pluginId: 'actual-plugin', revisionId: 'sha256:' + 'a'.repeat(64),
    scope: { kind: 'workspace', workspaceId: 'actual-asset-workspace' }, permissions: [], summary: literal, risk: 'low', expiresAt: '2040-01-01T00:00:00Z', revisionPreview: { literal } } })
  await observe(f, value => { assert.equal(scopes(value).length, 0); assert.ok(!value.scopes.some(scope => scope.destinations.some(item => item.uri === 'knowbook-asset://future/not-a-message'))) })
  assert.equal(actual.repository.getSession(actual.session.id)?.activeTurnId, actual.turnId)
}))

test('capsule2 assistant assets use the same last-key stored JSON meaning as the actual Main and renderer readers', () => withV3Fixture(async f => {
  const actual = begin(f), event = actual.text('assistant.message', 'initial'), body = '[last](knowbook-asset://future/last)'
  f.db.prepare('UPDATE assistant_events SET payload_json=? WHERE id=?').run(`{"turnId":${JSON.stringify(actual.turnId)},"stepId":${JSON.stringify(actual.stepId)},"text":"[discarded](knowbook-asset://future/ignored)","text":${JSON.stringify(body)}}`, event.id)
  const read = actual.repository.listEvents(actual.session.id).find(row => row.id === event.id)
  assert.equal(read?.type === 'assistant.message' && read.payload.text, body)
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === event.id)
    assert.ok(scope); assert.deepEqual(scope.destinations.map(item => item.uri), ['knowbook-asset://future/last'])
  })
}))

test('capsule2 assistant assets scan the complete real event family beyond the public1000 event page', () => withV3Fixture(async f => {
  const actual = begin(f)
  for (let index = 0; index < 1000; index++) actual.text('assistant.message', 'Actual retained message ' + index)
  const last = actual.text('assistant.message', '[last](knowbook-asset://future/beyond-page)')
  const firstPage = actual.repository.listEvents(actual.session.id, 0, 1000)
  assert.equal(firstPage.length, 1000); assert.ok(!firstPage.some(row => row.id === last.id))
  await observe(f, value => { assert.equal(scopes(value).length, 1001); assert.ok(scopes(value).find(scope => scope.source[1] === last.id)?.destinations.some(item => item.uri === 'knowbook-asset://future/beyond-page')) })
}))

test('capsule2 assistant assets preserve complete stored Markdown beyond provider context item limits and raw provider-looking tags', () => withV3Fixture(async f => {
  const actual = begin(f), body = '原文😀'.repeat(9000) + '\n\n<tool_call marker\n\n[retained](knowbook-asset://future/full-text)'
  assert.ok(body.length > 32000)
  const event = actual.text('assistant.message', body)
  assert.ok(projectEvents(actual.repository.listEvents(actual.session.id)).items.some(item => item.kind === 'message' && item.text === body))
  assert.ok(collectStoredMarkdownAssetDestinations(body).some(item => item.url === 'knowbook-asset://future/full-text'))
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === event.id)
    assert.ok(scope); assert.equal(scope.bodyProjectionHash, projectionHash(body)); assert.ok(scope.destinations.some(item => item.uri === 'knowbook-asset://future/full-text'))
  })
}))

test('capsule2 assistant assets preserve original leading and trailing whitespace while the real writer still refuses empty text', () => withV3Fixture(async f => {
  const actual = begin(f)
  assert.throws(() => actual.text('assistant.chunk', ''), /requires text/)
  assert.throws(() => actual.text('assistant.message', '  '), /requires text/)
  const first = actual.text('assistant.chunk', '  [x](knowbook-'), second = actual.text('assistant.chunk', 'asset://future/x)  '), final = actual.text('assistant.message', '  final  ')
  await observe(f, value => {
    const stream = scopes(value).find(scope => scope.source[1] === first.id), message = scopes(value).find(scope => scope.source[1] === final.id)
    assert.ok(stream); assert.ok(message); assert.deepEqual(stream.assistant?.parts.map(part => [part.eventId, part.from, part.to]), [[first.id, 0, first.payload.text.length], [second.id, first.payload.text.length, first.payload.text.length + second.payload.text.length]])
    assert.equal(stream.bodyProjectionHash, projectionHash(first.payload.text + second.payload.text))
    assert.equal(message.bodyProjectionHash, projectionHash(final.payload.text))
    assert.equal(message.destinations.length, 0)
  })
}))

test('capsule2 assistant assets bind original chunk contributions even when a valid source repartition keeps the full Markdown equal', () => withV3Fixture(async f => {
  const actual = begin(f), a = actual.text('assistant.chunk', '[x](knowbook-'), b = actual.text('assistant.chunk', 'asset://future/partition)')
  let originalHash = '', originalProjection = ''
  await observe(f, value => { const scope = scopes(value).find(scope => scope.source[1] === a.id); assert.ok(scope); originalHash = scope.contentHash; originalProjection = scope.bodyProjectionHash })
  const left = '[x](know', right = 'book-asset://future/partition)'
  for (const [event, text] of [[a, left], [b, right]] as const) f.db.prepare('UPDATE assistant_events SET payload_json=? WHERE id=?').run(JSON.stringify({ turnId: actual.turnId, stepId: actual.stepId, text }), event.id)
  assert.ok(projectEvents(actual.repository.listEvents(actual.session.id)).items.some(item => item.kind === 'message' && item.text === a.payload.text + b.payload.text))
  await observe(f, value => {
    const scope = scopes(value).find(scope => scope.source[1] === a.id)
    assert.ok(scope); assert.equal(scope.bodyProjectionHash, originalProjection); assert.notEqual(scope.contentHash, originalHash)
    assert.equal(scope.assistant?.parts[0].to, left.length)
  })
}))

test('capsule2 assistant assets retain every real stream contribution beyond the public page before resolving its final reference definition', () => withV3Fixture(async f => {
  const actual = begin(f), first = actual.text('assistant.chunk', '![complete][asset]\n\n')
  for (let index = 0; index < 1000; index++) actual.text('assistant.chunk', 'Actual retained stream text ' + index + ' ')
  const last = actual.text('assistant.chunk', '\n\n[asset]: <knowbook-asset://future/complete-stream>')
  const page = actual.repository.listEvents(actual.session.id, 0, 1000)
  assert.ok(!page.some(row => row.id === last.id))
  const all = [...page, ...actual.repository.listEvents(actual.session.id, page.at(-1)!.seq, 1000)]
  const rendered = projectEvents(all).items.find(item => item.kind === 'message' && item.role === 'assistant')
  assert.ok(rendered?.kind === 'message' && rendered.text.endsWith(last.payload.text))
  await observe(f, value => {
    const found = scopes(value); assert.equal(found.length, 1)
    const scope = found[0]; assert.equal(scope.source[1], first.id); assert.equal(scope.assistant?.parts.length, 1002)
    assert.equal(scope.assistant?.parts.at(-1)?.eventId, last.id)
    assert.ok(scope.destinations.some(item => item.uri === 'knowbook-asset://future/complete-stream'))
  })
}))

test('capsule2 assistant asset projection hashes preserve distinct stored UTF16 source units before any UTF8 replacement', () => withV3Fixture(async f => {
  const actual = begin(f), a = actual.text('assistant.message', 'source-\ud800'), b = actual.text('assistant.message', 'source-\ufffd')
  const stored = actual.repository.listEvents(actual.session.id).find(row => row.id === a.id)
  assert.ok(stored?.type === 'assistant.message'); assert.equal(stored.payload.text, a.payload.text)
  await observe(f, value => {
    const left = scopes(value).find(scope => scope.source[1] === a.id), right = scopes(value).find(scope => scope.source[1] === b.id)
    assert.ok(left); assert.ok(right); assert.equal(left.bodyProjectionHash, projectionHash(a.payload.text)); assert.equal(right.bodyProjectionHash, projectionHash(b.payload.text))
    assert.notEqual(left.bodyProjectionHash, right.bodyProjectionHash)
  })
}))

test('capsule2 assistant assets reject an actual malformed source payload before parsing Markdown and leave the readonly source unchanged', () => withV3Fixture(async f => {
  const actual = begin(f), event = actual.text('assistant.message', 'actual')
  f.db.prepare('UPDATE assistant_events SET payload_json=? WHERE id=?').run(JSON.stringify({ turnId: actual.turnId, stepId: actual.stepId, text: 17 }), event.id)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const raw = readRawCapsule2ContentOwned(db)
    assert.throws(() => readRawCapsule2AssetReferencesOwned(db), /assistant|助手|payload|text/)
    assert.deepEqual(readRawCapsule2ContentOwned(db), raw); assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
}))
