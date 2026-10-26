import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { applyNavigation3TextEdits, projectNavigation3Range, renderNavigation3Destination,
  type Navigation3Destination } from '../src/main/database/restore-knowledge-navigation3-rewrite-cells'

function links(text: string): Navigation3Destination[] {
  return collectMarkdownSourceLinks(text).map(link => ({ key: { from: link.start, to: link.end,
    raw: text.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }, url: link.url,
    grammar: { kind: link.kind, syntax: link.kind === 'wiki' ? 'wiki' : link.syntax ?? null } }))
}
test('navigation3 cell rewrite keeps CRLF labels queries HTML escaping and repeated destination positions', () => {
  const original = '[first](Old.md?q=1&n=2#old)\r\n<a href="Old.md?q=1&amp;n=2#old">second</a>\r\n`[code](Old.md)`'
  const before = links(original), edits = before.map(link => {
    const rendered = renderNavigation3Destination(link, { documentId: 'host', path: 'Folder/Host' },
      { kind: 'heading', documentId: 'target', documentPath: 'Archive/New name', headingKey: 'same-occurrence', slug: 'new-title' })
    assert.ok('replacement' in rendered)
    return { from: link.key.from, to: link.key.to, before: link.key.raw, after: rendered.replacement }
  })
  const actual = applyNavigation3TextEdits(original, edits)
  assert.equal(actual, '[first](../Archive/New%20name.md?q=1&n=2#new-title)\r\n<a href="../Archive/New%20name.md?q&#61;1&#38;n&#61;2#new-title">second</a>\r\n`[code](Old.md)`')
  const parsed = links(actual)
  assert.equal(parsed.length, 2)
  for (let i = 0; i < before.length; i++) {
    const projected = projectNavigation3Range(before[i].key.from, before[i].key.to, edits)!
    assert.equal(parsed[i].key.from, projected.from); assert.equal(parsed[i].key.to, projected.to)
    assert.equal(parsed[i].url, '../Archive/New%20name.md?q=1&n=2#new-title')
  }
})
test('navigation3 cell rewrite preserves Wiki table alias spelling and emits a proven block target', () => {
  const original = '| Link |\n| --- |\n| [[Old#before\\| visible alias ]] |'
  const [link] = links(original)
  const rendered = renderNavigation3Destination(link, { documentId: 'host', path: 'Folder/Host' },
    { kind: 'block', documentId: 'target', documentPath: 'Archive/New', blockId: 'fixed-block' })
  assert.ok('replacement' in rendered)
  const actual = applyNavigation3TextEdits(original, [{ from: link.key.from, to: link.key.to, before: link.key.raw, after: rendered.replacement }])
  assert.equal(actual, '| Link |\n| --- |\n| [[Archive/New#^fixed-block\\| visible alias ]] |')
  assert.equal(links(actual)[0].url, 'Archive/New#^fixed-block| visible alias')
  assert.deepEqual(renderNavigation3Destination(link, { documentId: 'host', path: 'Folder/Host' },
    { kind: 'document', documentId: 'target', documentPath: 'Unsafe|Path' }), { reason: 'wiki-target-needs-legacy-path-disambiguation' })
})
test('navigation3 cell rewrite refuses overlapping stale ranges and never reads accessor payloads', () => {
  const original = '[a](Old.md) [b](Old.md)', before = links(original)
  const edit = { from: before[0].key.from, to: before[0].key.to, before: 'Old.md', after: 'New.md' }
  assert.throws(() => applyNavigation3TextEdits(original, [edit, edit]), /navigation-edit-original-range/)
  assert.throws(() => applyNavigation3TextEdits(original, [{ ...edit, before: 'Wrong.md' }]), /navigation-edit-original-range/)
  assert.equal(projectNavigation3Range(edit.from + 1, edit.to + 1, [edit]), null)
  let calls = 0
  const malicious = { ...edit, get after() { calls++; return 'New.md' } }
  assert.throws(() => applyNavigation3TextEdits(original, [malicious])); assert.equal(calls, 0)
})
