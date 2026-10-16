import assert from 'node:assert/strict'
import test from 'node:test'
import type { Token } from 'markdown-it'
import { observeMarkdownSourceOccurrences, type MarkdownSourceOccurrenceObservation } from '../src/shared/markdownSourceOccurrences'
import { createMarkdownSourceRawTrace } from '../src/shared/markdownSourceTrace'
import { markdownEngine } from '../src/shared/markdownEngine'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { capturedMarkdownSourceLinks, type MarkdownRawOccurrenceObserver } from '../src/shared/markdownSourceLinks'

function allTokens(tokens: readonly Token[]): Token[] {
  return tokens.flatMap(token => [token, ...(token.children ? allTokens(token.children) : [])])
}
function complete(source: string): MarkdownSourceOccurrenceObservation {
  const result = observeMarkdownSourceOccurrences(source)
  assert.equal(result.complete, true, JSON.stringify(result.barriers.map(value => value.reason)))
  assert.deepEqual(result.barriers, [])
  const final = new Set(allTokens(result.tokens))
  for (const use of result.uses) {
    assert.ok(use.complete); assert.ok(use.use); assert.ok(use.destination?.destination)
    assert.ok(use.owner); assert.equal(final.has(use.owner), true)
    assert.equal(use.owner.children?.includes(use.token), true)
    assert.equal(final.has(use.token), true)
    assert.equal(use.inlineTokens.includes(use.token), true)
    assert.equal(source.slice(use.use.from, use.use.to), use.use.raw)
    assert.equal(source.slice(use.destination.destination.from, use.destination.destination.to), use.destination.destination.raw)
  }
  return result
}
function engineSnapshot() {
  return { State: markdownEngine.block.State, inline: markdownEngine.inline.parse,
    destination: markdownEngine.helpers.parseLinkDestination, label: markdownEngine.helpers.parseLinkLabel,
    rules: markdownEngine.block.ruler.__rules__.map(({ name, fn }) => ({ name, fn })) }
}
function assertRestored(snapshot: ReturnType<typeof engineSnapshot>) {
  assert.equal(markdownEngine.block.State, snapshot.State)
  assert.equal(markdownEngine.inline.parse, snapshot.inline)
  assert.equal(markdownEngine.helpers.parseLinkDestination, snapshot.destination)
  assert.equal(markdownEngine.helpers.parseLinkLabel, snapshot.label)
  assert.deepEqual(markdownEngine.block.ruler.__rules__.map(({ name, fn }) => ({ name, fn })), snapshot.rules)
}

test('raw occurrences use actual token arrays and retain repeated href, BOM, CRLF, emoji and NUL projections', () => {
  const source = '\uFEFF🙂 [A](Same.md)\r\nthen [B](Same.md)\r\n\r\n[nu\0l](Other.md)'
  const result = complete(source)
  assert.equal(result.physicalDestinations.length, 3)
  assert.equal(result.uses.length, 3)
  assert.equal(result.uses[0].inlineTokens, result.uses[1].inlineTokens)
  assert.notEqual(result.uses[0].token, result.uses[1].token)
  assert.notEqual(result.uses[0].destination, result.uses[1].destination)
  assert.deepEqual(result.physicalDestinations.map(value => value.destination?.raw), ['Same.md', 'Same.md', 'Other.md'])
  assert.deepEqual(result.uses.map(value => value.use?.raw), ['[A](Same.md)', '[B](Same.md)', '[nu\0l](Other.md)'])
  assert.equal(result.uses[2].use?.parsed, '[nu�l](Other.md)')
  assert.equal(result.uses[0].use?.from, 4, 'The BOM and both emoji code units retain their raw offsets')
  const secondParse = complete(source)
  assert.notEqual(result.uses[0].token, secondParse.uses[0].token)
  assert.notEqual(result.uses[0].inlineTokens, secondParse.uses[0].inlineTokens)
})

test('actual destination helper reads retain empty points, title exclusions and escaped authored bytes', () => {
  const source = '[plain]() [spaces](   ) [title](<> "😀\\\"title") [escaped](Path\\(x\\).md)'
  const result = complete(source)
  assert.equal(result.uses.length, 4)
  assert.deepEqual(result.physicalDestinations.map(value => value.destination?.raw), ['', '', '', 'Path\\(x\\).md'])
  assert.deepEqual(result.physicalDestinations.map(value => value.url), ['', '', '', 'Path(x).md'])
  const points = [source.indexOf('()') + 1, source.indexOf('(   )') + 1, source.indexOf('<>') + 1]
  for (let index = 0; index < points.length; index++) {
    const span = result.physicalDestinations[index].destination!
    assert.equal(span.from, points[index]); assert.equal(span.to, points[index])
    assert.deepEqual(span.projection.boundaries, [[points[index]]])
  }
})

test('reference uses point to the same actual first-definition object while inactive definitions remain physical', () => {
  const source = '[one][r] [r][] [r]\n\n[r]: Same.md "first"\n[r]: Other.md "ignored"\n\n[s]: Same.md\n\n[s]'
  const result = complete(source), definitions = result.physicalDestinations.filter(value => value.kind === 'definition')
  assert.equal(definitions.length, 3)
  assert.equal(result.physicalDestinations.length, 3, 'Reference uses do not add physical destinations')
  assert.deepEqual(definitions.map(value => value.active), [true, false, true])
  assert.deepEqual(definitions.map(value => value.destination?.raw), ['Same.md', 'Other.md', 'Same.md'])
  assert.equal(definitions[0].reference, definitions[1].reference)
  assert.notEqual(definitions[0].reference, definitions[2].reference)
  for (const use of result.uses.slice(0, 3)) {
    assert.equal(use.kind, 'reference'); assert.equal(use.destination, definitions[0])
    assert.equal(use.reference, definitions[0].reference)
  }
  assert.equal(result.uses[3].destination, definitions[2])
  assert.deepEqual(result.uses.map(value => value.use?.raw), ['[one][r]', '[r][]', '[r]', '[s]'])
  assert.equal(definitions[0].use?.raw, '[r]: Same.md "first"')
})

test('empty and multiline definitions use the actual StateBlock helper source and live indentation coordinates', () => {
  const source = '- [use][r]\r\n\r\n  [r]:\r\n    <Guide.md>\r\n    "title"\r\n\r\n> [q]: <>\r\n>\r\n> [q]'
  const result = complete(source), definitions = result.physicalDestinations.filter(value => value.kind === 'definition')
  assert.equal(definitions.length, 2)
  assert.equal(definitions[0].destination?.raw, 'Guide.md')
  assert.equal(definitions[0].destination?.from, source.indexOf('Guide.md'))
  assert.equal(definitions[1].destination?.from, source.indexOf('<>') + 1)
  assert.equal(definitions[1].destination?.to, source.indexOf('<>') + 1)
  assert.equal(result.uses[0].destination, definitions[0])
  assert.equal(result.uses[1].destination, definitions[1])
  assert.match(definitions[0].use!.raw, /\r\n    <Guide\.md>/)
})

test('actual task and callout slicing retains body and title token identities without mapLines authority', () => {
  const result = complete('- [x] [task](Task.md)\n\n> [!NOTE] [title](Title.md)\n> [body](Body.md)')
  assert.deepEqual(result.physicalDestinations.map(value => value.destination?.raw), ['Task.md', 'Title.md', 'Body.md'])
  assert.deepEqual(result.uses.map(value => value.use?.raw), ['[task](Task.md)', '[title](Title.md)', '[body](Body.md)'])
})

test('multiline uses carry exact raw shell gaps rather than pretending parsed text equals raw text', () => {
  const source = '> [multi\r\n> label](Guide.md)'
  const result = complete(source), use = result.uses[0].use!
  assert.equal(use.raw, '[multi\r\n> label](Guide.md)')
  assert.equal(use.parsed, '[multi\nlabel](Guide.md)')
  const newline = use.parsed.indexOf('\n')
  assert.equal(use.projection.ends[newline] - use.projection.starts[newline], 2)
  assert.ok(use.projection.boundaries[newline + 1].length > 1, 'Removed quote indentation stays an explicit boundary gap')
})

test('safe HTML creation points and wiki rules expose authored destinations without href pairing', () => {
  const source = '<u><a href="Same&#46;md">one</a> <a href=\'Same.md\'>two</a></u> [[ Note#Part|Alias ]] <https://example.com/a>'
  const result = complete(source)
  assert.deepEqual(result.physicalDestinations.map(value => [value.format, value.destination?.raw]), [
    ['html', 'Same&#46;md'], ['html', 'Same.md'], ['wiki', 'Note#Part|Alias'], ['markdown', 'https://example.com/a']
  ])
  assert.deepEqual(result.uses.map(value => value.use?.raw), ['<a href="Same&#46;md">one</a>', "<a href='Same.md'>two</a>",
    '[[ Note#Part|Alias ]]', '<https://example.com/a>'])
  assert.equal(result.physicalDestinations[0].url, 'Same.md')
  assert.equal(result.physicalDestinations[2].syntax, 'wiki')
})

test('finite native title and body traces preserve actual definition ownership and encoded source projections', () => {
  const source = serializeBlocksToMarkdown([
    { type: 'toggle', content: '[title </summary>][r] 🙂', depth: 0 },
    { type: 'paragraph', content: '</details>\n\n[r]: Guide.md', depth: 1 },
    { type: 'paragraph', content: '[body][r]', depth: 1 }
  ])
  const snapshot = engineSnapshot(), result = complete(source)
  assertRestored(snapshot)
  const definitions = result.physicalDestinations.filter(value => value.kind === 'definition')
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].destination?.raw, 'Guide.md')
  assert.deepEqual(result.uses.map(value => value.destination), [definitions[0], definitions[0]])
  assert.deepEqual(result.uses.map(value => value.use?.parsed), ['[title </summary>][r]', '[body][r]'])
  assert.notEqual(result.uses[0].use?.raw, result.uses[0].use?.parsed, 'The same actual finite native projection proves transformed raw bytes')
})

test('excluded code, math, frontmatter and image-alt syntax does not manufacture destinations or unknown scopes', () => {
  const source = '---\nkey: "[yaml](Yaml.md)"\n---\n\n`[code](Code.md)` \\[escaped](Escaped.md) $[math](Math.md)$ ![alt [fake](Fake.md)](Image.png)\n\n```md\n[fenced](Fenced.md)\n```\n\n[actual](Actual.md)'
  const result = complete(source)
  assert.deepEqual(result.physicalDestinations.map(value => value.destination?.raw), ['Actual.md'])
})

test('unsupported table, named and inline footnotes, legacy subparses remain explicit barriers even without links', () => {
  for (const source of ['| a | b |\n| - | - |\n| x | y |', '[^n]: plain body\n\n[^n]', '^[plain note]',
    '<details>\n<summary>plain</summary>\n\nbody\n\n</details>']) {
    const result = observeMarkdownSourceOccurrences(source)
    assert.equal(result.complete, false, source)
    assert.ok(result.barriers.length > 0, source)
  }
  const table = observeMarkdownSourceOccurrences('| a | b |\n| - | - |\n| [one](Same.md) | [two](Same.md) |')
  assert.ok(table.barriers.some(value => value.reason === 'table-scope'))
  assert.equal(table.physicalDestinations.every(value => !value.complete), true, 'Legacy table cell sourceMap is not raw proof')
})

test('core fuzzy and pending-prefix linkification cannot silently produce a complete empty inventory', () => {
  for (const source of ['www.example.com', 'file:///C:/Guide.md', 'https://example.com/a']) {
    const result = observeMarkdownSourceOccurrences(source)
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.reason === 'unobserved-final-link-token'))
    assert.equal(allTokens(result.tokens).some(token => token.type === 'link_open'), true)
  }
})

test('sealed facts are independent immutable snapshots while actual parser receipts remain mutable', () => {
  const result = complete('[one](One.md)'), destination = result.physicalDestinations[0], use = result.uses[0]
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.physicalDestinations)); assert.ok(Object.isFrozen(destination))
  assert.ok(Object.isFrozen(destination.destination)); assert.ok(Object.isFrozen(destination.destination!.projection.starts))
  assert.ok(Object.isFrozen(use)); assert.equal(Object.isFrozen(use.token), false); assert.equal(Object.isFrozen(use.inlineTokens), false)
  use.token.attrSet('href', 'Changed.md')
  assert.equal(destination.url, 'One.md'); assert.equal(destination.destination?.raw, 'One.md')
  assert.equal(result.complete, true, 'The observation is a sealed receipt, not a live view of token mutation')
})

test('post-rule core rewrites or missing final actual tokens produce barriers instead of trusting a stale event', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'linkify')!, previous = rule.fn
  try {
    for (const rewrite of ['url', 'remove'] as const) {
      markdownEngine.core.ruler.at('linkify', state => {
        previous(state)
        if (rewrite === 'remove') {
          for (const token of state.tokens) if (token.children) token.children = token.children.filter(child => child.type !== 'link_open')
        } else for (const token of allTokens(state.tokens)) if (token.type === 'link_open') token.attrSet('href', 'Changed.md')
      })
      const result = observeMarkdownSourceOccurrences('[one](One.md)')
      assert.equal(result.complete, false)
      const reason = rewrite === 'url' ? 'post-rule-link-rewrite' : 'successful-use-not-in-final-parse'
      assert.ok(result.barriers.some(value => value.reason === reason))
      assert.equal(result.physicalDestinations[0].url, 'One.md')
    }
  } finally { markdownEngine.core.ruler.at('linkify', previous) }
})

test('a real post-inline core rule cannot turn an observed link into text while keeping a complete receipt', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'text_join')!, previous = rule.fn
  let changed: Token | undefined, mutationCount = 0
  try {
    markdownEngine.core.ruler.at('text_join', state => {
      // A rewrite before this real join pass is correctly merged into the
      // following label text and tests removal instead of surviving type drift.
      previous(state)
      if (state.inlineMode || !state.env.markdownRawOccurrences) return
      changed = allTokens(state.tokens).find(token => token.type === 'link_open')
      assert.ok(changed)
      changed.type = 'text'
      mutationCount++
    })
    const result = observeMarkdownSourceOccurrences('[one](One.md)')
    assert.equal(mutationCount, 1, 'Only the actual full source parse must be mutated')
    assert.equal(result.uses[0].token, changed)
    assert.equal(allTokens(result.tokens).includes(changed!), true, 'The same actual object still exists in the final tree')
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.scope === changed && value.reason === 'post-rule-link-token-rewrite'))
    assert.equal(result.physicalDestinations[0].url, 'One.md')
  } finally { markdownEngine.core.ruler.at('text_join', previous) }
})

test('a real post-inline core rule cannot mount the same observed Token object twice in the final tree', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'linkify')!, previous = rule.fn
  let duplicated: Token | undefined, mutationCount = 0
  try {
    markdownEngine.core.ruler.at('linkify', state => {
      previous(state)
      if (state.inlineMode || !state.env.markdownRawOccurrences) return
      const inline = state.tokens.find(token => token.type === 'inline')
      assert.ok(inline?.children)
      duplicated = inline.children.find(token => token.type === 'link_open')
      assert.ok(duplicated)
      inline.children.push(duplicated)
      mutationCount++
    })
    const result = observeMarkdownSourceOccurrences('[one](One.md)')
    assert.equal(mutationCount, 1, 'Only the actual full source parse must be mutated')
    assert.equal(result.uses.length, 1, 'Only one successful rule event occurred')
    assert.equal(result.uses[0].token, duplicated)
    assert.equal(allTokens(result.tokens).filter(token => token === duplicated).length, 2)
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.scope === duplicated && value.reason === 'post-rule-link-token-rewrite'))
  } finally { markdownEngine.core.ruler.at('linkify', previous) }
})

test('a real post-inline core relocation of one actual link pair preserves count and href but invalidates its owner receipt', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'linkify')!, previous = rule.fn
  let originalOwner: Token | undefined, newOwner: Token | undefined, mutationCount = 0
  try {
    markdownEngine.core.ruler.at('linkify', state => {
      previous(state)
      if (state.inlineMode || !state.env.markdownRawOccurrences) return
      const owners = state.tokens.filter(token => token.type === 'inline')
      assert.equal(owners.length, 2)
      originalOwner = owners[0]; newOwner = owners[1]
      assert.ok(originalOwner.children); assert.ok(newOwner.children)
      const open = originalOwner.children.find(token => token.type === 'link_open')
      const close = originalOwner.children.find(token => token.type === 'link_close')
      assert.ok(open); assert.ok(close)
      originalOwner.children = originalOwner.children.filter(token => token !== open && token !== close)
      newOwner.children = [open, ...newOwner.children, close]
      mutationCount++
    })
    const result = observeMarkdownSourceOccurrences('[one](One.md)\n\nplain B'), use = result.uses[0]
    assert.equal(mutationCount, 1, 'Only the actual full source parse must be mutated')
    assert.equal(use.owner, originalOwner)
    assert.equal(newOwner?.children?.includes(use.token), true)
    assert.equal(allTokens(result.tokens).filter(token => token === use.token).length, 1)
    assert.equal(use.token.type, 'link_open'); assert.equal(use.token.attrGet('href'), 'One.md')
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.scope === use.token && value.reason === 'post-rule-inline-owner-relocation'))
  } finally { markdownEngine.core.ruler.at('linkify', previous) }
})

test('an entire actual inline array cannot change owner, while a replacement array under the same owner remains proven', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'linkify')!, previous = rule.fn
  try {
    for (const relocate of [false, true]) {
      let originalOwner: Token | undefined, newOwner: Token | undefined, mutationCount = 0
      markdownEngine.core.ruler.at('linkify', state => {
        previous(state)
        if (state.inlineMode || !state.env.markdownRawOccurrences) return
        const owners = state.tokens.filter(token => token.type === 'inline')
        assert.equal(owners.length, 2)
        originalOwner = owners[0]; newOwner = owners[1]
        assert.ok(originalOwner.children)
        if (relocate) {
          newOwner.children = originalOwner.children
          originalOwner.children = []
        } else originalOwner.children = [...originalOwner.children]
        mutationCount++
      })
      const result = observeMarkdownSourceOccurrences('[one](One.md)\n\nplain B'), use = result.uses[0]
      assert.equal(mutationCount, 1, 'Each full source parse must execute its selected mutation exactly once')
      assert.equal(use.owner, originalOwner)
      assert.equal(allTokens(result.tokens).filter(token => token === use.token).length, 1)
      if (relocate) {
        assert.equal(use.inlineTokens, newOwner?.children, 'Even the original actual array identity is unchanged')
        assert.equal(result.complete, false)
        assert.ok(result.barriers.some(value => value.scope === use.token && value.reason === 'post-rule-inline-owner-relocation'))
      } else {
        assert.notEqual(use.inlineTokens, originalOwner?.children, 'A normal core may replace an array while retaining the actual owner')
        assert.equal(result.complete, true)
        assert.deepEqual(result.barriers, [])
      }
    }
  } finally { markdownEngine.core.ruler.at('linkify', previous) }
})

test('a nonempty document title uses a separate cold slug parse without becoming an unproven source scope', () => {
  const snapshot = engineSnapshot()
  const result = observeMarkdownSourceOccurrences('[a](A.md)', { documentTitle: 'Title [not source](TitleOnly.md)' })
  assert.equal(result.complete, true)
  assert.deepEqual(result.barriers, [])
  assert.deepEqual(result.physicalDestinations.map(value => value.destination?.raw), ['A.md'])
  assert.equal(result.uses.length, 1)
  assertRestored(snapshot)
})

test('an actual successful inline rule with a non-string href produces an incomplete fact and explicit barrier', () => {
  const previousState = markdownEngine.inline.State
  class NumericHrefState extends previousState {
    override push(type: string, tag: string, nesting: -1 | 0 | 1): Token {
      const token = super.push(type, tag, nesting)
      if (type === 'link_close') for (const emitted of this.tokens) if (emitted.type === 'link_open') emitted.attrSet('href', 17)
      return token
    }
  }
  try {
    markdownEngine.inline.State = NumericHrefState
    const result = observeMarkdownSourceOccurrences('[one](One.md)')
    assert.equal(result.uses[0].token.attrGet('href'), 17)
    assert.equal(result.physicalDestinations[0].destination?.raw, 'One.md', 'The actual raw destination remains a separate fact')
    assert.equal(result.physicalDestinations[0].complete, false)
    assert.equal(result.uses[0].complete, false)
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.reason === 'non-string-link-href'))
  } finally { markdownEngine.inline.State = previousState }
  assert.equal(complete('[empty]()').physicalDestinations[0].url, '', 'A legitimate empty string remains supported')
})

test('a real post-inline core rule cannot change a sealed href to a non-string value', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'linkify')!, previous = rule.fn
  try {
    markdownEngine.core.ruler.at('linkify', state => {
      previous(state)
      for (const token of allTokens(state.tokens)) if (token.type === 'link_open') token.attrSet('href', 17)
    })
    const result = observeMarkdownSourceOccurrences('[one](One.md)')
    assert.equal(result.uses[0].token.attrGet('href'), 17)
    assert.equal(result.physicalDestinations[0].url, 'One.md', 'The earlier fact is immutable')
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.reason === 'non-string-link-href'))
  } finally { markdownEngine.core.ruler.at('linkify', previous) }
})

test('cold parser hooks and actual reference helper are restored after helper failure and subsequent success', () => {
  const original = engineSnapshot(), helper = markdownEngine.helpers.parseLinkDestination
  const failure = new Error('actual reference helper failed')
  markdownEngine.helpers.parseLinkDestination = () => { throw failure }
  const failing = engineSnapshot()
  try {
    for (const source of ['[r]: Guide.md\n\n[r]', '[one](One.md)']) {
      assert.throws(() => observeMarkdownSourceOccurrences(source), error => error === failure)
      assertRestored(failing)
    }
  } finally { markdownEngine.helpers.parseLinkDestination = helper }
  assertRestored(original)
  complete('[r]: Guide.md\n\n[r]'); assertRestored(original)
})

test('cold parser hooks restore on a throwing raw inline observer and remain isolated from ordinary parser shape', () => {
  const source = '[one](One.md)', snapshot = engineSnapshot(), failure = new Error('actual raw observer failed')
  const observer: MarkdownRawOccurrenceObserver = { definition() {}, link() { throw failure }, unknownInline() {} }
  assert.throws(() => createMarkdownSourceRawTrace(source).parse({ markdownRawOccurrences: observer }), error => error === failure)
  assertRestored(snapshot)
  const environment: Record<string, unknown> = {}, before = markdownEngine.parse(source, environment)
  assert.equal(environment.markdownSourceLinks, undefined)
  complete(source)
  assert.deepEqual(markdownEngine.parse(source, {}), before)
  assert.equal(allTokens(before).some(token => token.meta?.sourceMap || token.meta?.sourceLinkProvenance), false)
  const legacy: Record<string, unknown> = { captureSourceLinks: true }, expected: Record<string, unknown> = { captureSourceLinks: true }
  markdownEngine.parse(source, legacy); complete(source); markdownEngine.parse(source, expected)
  assert.deepEqual(capturedMarkdownSourceLinks(legacy), capturedMarkdownSourceLinks(expected))
  assertRestored(snapshot)
})

test('nested native parsing also restores hooks after an inline observer throws, and trace receipts are single-use', () => {
  const source = serializeBlocksToMarkdown([
    { type: 'toggle', content: 'title', depth: 0 }, { type: 'paragraph', content: '[body](Body.md)', depth: 1 }
  ])
  const snapshot = engineSnapshot(), failure = new Error('nested actual observer failed')
  const observer: MarkdownRawOccurrenceObserver = { definition() {}, link() { throw failure }, unknownInline() {} }
  const trace = createMarkdownSourceRawTrace(source)
  assert.throws(() => trace.parse({ markdownRawOccurrences: observer }), error => error === failure)
  assertRestored(snapshot)
  assert.throws(() => trace.parse({}), /already sealed/)
  complete(source); assertRestored(snapshot)
})
