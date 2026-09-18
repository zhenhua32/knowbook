import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { auditMarkdownExample, canonicalMarkdownHtml, loadMarkdownPolicies, loadMarkdownSpec, markdownSpecNames } from './helpers/markdownSpec'

const policies = loadMarkdownPolicies()
test('official fixture content is pinned independently of local line endings', () => {
  const hashes = {
    'commonmark-0.31.2': 'd431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20',
    'gfm-0.29': 'ae2bb0ea40e77f55bfb758fdcbb1562063ee058a5b9348024fd3fff1221780cf'
  }
  for (const name of markdownSpecNames) {
    const source = readFileSync(new URL(`./fixtures/markdown-spec/${name}.json`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(createHash('sha256').update(source).digest('hex'), hashes[name])
  }
})
for (const name of markdownSpecNames) {
  test(`${name}: every official example, explicit policies and three plain/backup cycles`, () => {
    const examples = loadMarkdownSpec(name)
    assert.equal(examples.length, name === 'commonmark-0.31.2' ? 652 : 677)
    assert.deepEqual(examples.map((e) => e.example), Array.from({ length: examples.length }, (_, i) => i + 1))
    const results = examples.map((e) => auditMarkdownExample(e, policies[name][e.example]))
    assert.deepEqual(results.filter((r) => r.failures.length), [])
    assert.deepEqual(Object.keys(policies[name]).map(Number).sort((a, b) => a - b), results.filter((r) => r.grammar === 'policy').map((r) => r.example))
  })
}

test('the HTML comparator retains content, list structure, code whitespace and link targets', () => {
  for (const [a, b] of [
    ['<ul><li>a</li></ul>', '<ul><li><p>a</p></li></ul>'],
    ['<ul><li>a</li><li>b</li></ul>', '<ul><li>a</li></ul><ul><li>b</li></ul>'],
    ['<pre><code></code></pre>', '<pre><code>\n</code></pre>'],
    ['<pre><code> a\n</code></pre>', '<pre><code>a\n</code></pre>'],
    ['<a href="/a">link</a>', '<a href="/b">link</a>'],
    ['<ol start="3"><li>a</li></ol>', '<ol><li>a</li></ol>']
  ]) assert.notEqual(canonicalMarkdownHtml(a), canonicalMarkdownHtml(b))
})
