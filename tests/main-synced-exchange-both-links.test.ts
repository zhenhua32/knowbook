import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { withBoth, overlappingGroup, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary,
  snapshot, completed, converged, assetPath } from './helpers/synced-exchange-both-fixture'

test('actual both fork joins fresh complete physical Keys to the original two equal-URL different-target Main sources and remaps its self block', () => withBoth(async f => {
  const id = await overlappingGroup(f), source = snapshot(f.B.db, id), targets = source.bindings.filter(binding => binding.raw === 'Target.md')
  assert.equal(targets.length, 2)
  assert.equal(new Set(targets.map(binding => JSON.stringify(binding.target))).size, 2, 'The real historical fixture contains independent captured targets despite equal URL strings')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c, { copies: [], hosts: 'none' })]))
  const fresh = snapshot(f.B.db, forkSummary(result, c.componentId).groups[0].groupId), block = fresh.blocks[0], tokens = collectMarkdownSourceLinks(block.content)
  assert.notEqual(block.id, source.blocks[0].id)
  for (const [label, targetId] of [['old', f.target], ['new', f.other]]) {
    const open = block.content.indexOf('[' + label + ']('), end = block.content.indexOf(')', open)
    const token = tokens.find(token => token.start > open && token.end <= end)
    assert.ok(open >= 0 && token, 'The independent parser identifies the exact original label occurrence after real fork text edits')
    const binding = fresh.bindings.find(binding => binding.blockId === block.id && binding.from === token.start && binding.to === token.end
      && binding.raw === block.content.slice(token.start, token.end) && binding.syntax === 'markdown')
    assert.ok(binding, 'The actual Main snapshot contains precisely the independently collected full destination Key')
    assert.deepEqual(binding.target, { kind: 'document', id: targetId, state: 'live' })
  }
  const self = fresh.bindings.find(binding => binding.target.kind === 'block' && binding.target.id === block.id)
  assert.ok(self && self.target.kind === 'block', 'The fresh canonical self link points to the mapped real child rather than the old G child')
  assert.equal(self.target.state, 'live')
  assert.equal(fresh.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === source.blocks[0].id), false)
  completed(await f.exchange(f.A), 'applied'); converged(f)
}, { sameUrl: true }))

test('actual both fork retains each real managed alias and typed catalog view while opaque query source text is never recursively replaced', () => withBoth(async f => {
  const id = await overlappingGroup(f), source = snapshot(f.B.db, id), sourceView = source.blocks.find(block => block.type === 'database-view')
  assert.ok(sourceView && f.aliases.length === 2, 'The real source contains a typed canonical database view and two independently imported asset names')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c, { copies: [], hosts: 'none' })]))
  const freshId = forkSummary(result, c.componentId).groups[0].groupId, fresh = snapshot(f.B.db, freshId), view = fresh.blocks.find(block => block.type === 'database-view')
  assert.ok(view, 'The complete canonical forest includes its actual fresh typed database-view child')
  const before = parseDatabaseViewPayload(sourceView.content), after = parseDatabaseViewPayload(view.content)
  assert.equal(after.databaseId, before.databaseId); assert.equal(after.config.query, before.config.query)
  assert.ok(after.config.query.includes(f.A.defaultId) && after.config.query.includes('file:///not-an-asset'), 'Authored query/config text retains the old opaque spelling while typed references are mapped')
  for (const alias of f.aliases) assert.deepEqual(readFileSync(assetPath(f.B, alias)), alias.bytes)
  completed(await f.exchange(f.A), 'applied'); const graph = converged(f)
  for (const alias of f.aliases) for (const profile of [f.A, f.B]) assert.deepEqual(readFileSync(assetPath(profile, alias)), alias.bytes)
  assert.deepEqual([...graph.a.assets].map(([hash, names]) => [hash, [...names].sort()]), [...graph.b.assets].map(([hash, names]) => [hash, [...names].sort()]))
  assert.ok(snapshot(f.A.db, freshId).blocks.some(block => block.type === 'database-view'), 'The peer actually installs the whole new group rather than only the summary result')
}, { assets: true, catalog: true }))
