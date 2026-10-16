import assert from 'node:assert/strict'
import test from 'node:test'
import type { StateInline, Token } from 'markdown-it'
import { markdownEngine } from '../src/shared/markdownEngine'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { observeMarkdownSourceOccurrences } from '../src/shared/markdownSourceOccurrences'
import { observeMarkdownSourceCarriers, type MarkdownSourceCarrierFact,
  type MarkdownSourceCarrierObservation } from '../src/shared/markdownSourceCarriers'

function tokens(values: readonly Token[]): Token[] {
  return values.flatMap(value => [value, ...(value.children ? tokens(value.children) : [])])
}
function snapshot() {
  return { destination: markdownEngine.helpers.parseLinkDestination, label: markdownEngine.helpers.parseLinkLabel,
    title: markdownEngine.helpers.parseLinkTitle, inlineState: markdownEngine.inline.State,
    blockState: markdownEngine.block.State, inline: markdownEngine.inline.parse,
    rules: markdownEngine.inline.ruler.__rules__.map(value => ({ name: value.name, fn: value.fn })) }
}
function restored(value: ReturnType<typeof snapshot>) {
  assert.equal(markdownEngine.helpers.parseLinkDestination, value.destination)
  assert.equal(markdownEngine.helpers.parseLinkLabel, value.label)
  assert.equal(markdownEngine.helpers.parseLinkTitle, value.title)
  assert.equal(markdownEngine.inline.State, value.inlineState)
  assert.equal(markdownEngine.block.State, value.blockState)
  assert.equal(markdownEngine.inline.parse, value.inline)
  assert.deepEqual(markdownEngine.inline.ruler.__rules__.map(rule => ({ name: rule.name, fn: rule.fn })), value.rules)
}
function complete(source: string): MarkdownSourceCarrierObservation {
  const before = snapshot(), result = observeMarkdownSourceCarriers(source)
  restored(before)
  assert.equal(result.observation.complete, true, JSON.stringify(result.observation.barriers.map(value => value.reason)))
  assert.equal(result.complete, true, JSON.stringify(result.barriers.map(value => value.reason)))
  assert.deepEqual(result.barriers, [])
  assert.equal(result.carriers.length, result.observation.uses.length)
  for (const value of result.carriers) {
    assert.ok(value.complete); assert.ok(value.use.use); assert.ok(value.destination?.destination)
    assert.equal(result.observation.uses.includes(value.use), true)
    assert.equal(result.observation.physicalDestinations.includes(value.destination), true)
    for (const field of [value.display, value.title]) if (field) {
      assert.equal(source.slice(field.span.from, field.span.to), field.span.raw)
      for (const part of field.rawRanges) assert.equal(source.slice(part.from, part.to), part.raw)
    }
    for (const part of value.shell) assert.equal(source.slice(part.from, part.to), part.raw)
  }
  return result
}
function summary(source: string) {
  const result = observeMarkdownSourceOccurrences(source)
  return { complete: result.complete, physical: result.physicalDestinations.map(value => ({ kind: value.kind, url: value.url,
    raw: value.destination?.raw, use: value.use?.raw, active: value.active })), uses: result.uses.map(value => ({ kind: value.kind, raw: value.use?.raw })) }
}
function shellText(value: MarkdownSourceCarrierFact): string { return value.shell.map(part => part.raw).join('') }

test('ordinary parsing and the original raw observer retain their shape and do not install the new title/push path', () => {
  const source = '[one](One.md "title") [two][r]\n\n[r]: Two.md', environment: Record<string, unknown> = {}
  const before = snapshot(), output = markdownEngine.parse(source, environment), rawBefore = summary(source)
  const original = observeMarkdownSourceOccurrences(source)
  assert.equal('carriers' in original, false)
  assert.equal('markdownSourceLinks' in environment, false)
  const Previous = markdownEngine.inline.State, seen: Array<{ mode: string; own: boolean }> = [], states: StateInline[] = []
  let mode = 'ordinary'
  class InspectState extends Previous {
    constructor(...args: ConstructorParameters<typeof Previous>) { super(...args); states.push(this) }
    override push(type: string, tag: string, nesting: -1 | 0 | 1): Token {
      if (type === 'link_open') seen.push({ mode, own: Object.hasOwn(this, 'push') })
      return super.push(type, tag, nesting)
    }
  }
  try {
    markdownEngine.inline.State = InspectState
    markdownEngine.parse(source, {})
    mode = 'original'; observeMarkdownSourceOccurrences(source)
    mode = 'carrier'; complete(source)
    assert.equal(seen.filter(value => value.mode !== 'carrier').every(value => !value.own), true)
    assert.equal(seen.some(value => value.mode === 'carrier' && value.own), true)
    assert.equal(states.every(state => !Object.hasOwn(state, 'push')), true, 'Inherited push is restored after every actual rule')
  } finally { markdownEngine.inline.State = Previous }
  restored(before)
  assert.deepEqual(markdownEngine.parse(source, {}), output)
  assert.deepEqual(summary(source), rawBefore)
})

test('repeated destinations keep separate actual tokens and exact display/title roles without pairing by URL', () => {
  const source = '[A](Same.md "one") [B](Same.md \'two\')', result = complete(source), [one, two] = result.carriers
  assert.notEqual(one.use.token, two.use.token); assert.notEqual(one.destination, two.destination)
  assert.deepEqual(result.carriers.map(value => value.form), ['direct', 'direct'])
  assert.deepEqual(result.carriers.map(value => value.display?.span.raw), ['A', 'B'])
  assert.deepEqual(result.carriers.map(value => value.title?.span.raw), ['one', 'two'])
  assert.deepEqual(result.carriers.map(value => value.titleConsumed), [true, true])
  assert.deepEqual(result.carriers.map(value => value.destination?.destination?.raw), ['Same.md', 'Same.md'])
  assert.equal(one.display?.span.from, source.indexOf('A'))
  assert.equal(two.title?.span.from, source.indexOf('two'))
  assert.equal(shellText(one), '[]( "")'); assert.equal(shellText(two), "[]( '')")
})

test('actual display and title retain emphasis, escapes and authored delimiter bodies', () => {
  const source = '[**A** and \\[B\\]](<Guide.md> "x \\"y\\"")', result = complete(source), value = result.carriers[0]
  assert.equal(value.display?.span.parsed, '**A** and \\[B\\]')
  assert.equal(value.title?.span.raw, 'x \\"y\\"')
  assert.equal(value.destination?.destination?.raw, 'Guide.md')
  assert.equal(shellText(value), '[](<> "")')
})

test('an actually consumed empty title has an exact empty slot while an absent title remains null', () => {
  const source = '[empty](<> "") [absent](<>)', [empty, absent] = complete(source).carriers
  assert.equal(empty.titleConsumed, true); assert.ok(empty.title)
  assert.equal(empty.title.span.from, source.indexOf('""') + 1); assert.equal(empty.title.span.to, empty.title.span.from)
  assert.equal(empty.title.span.raw, ''); assert.deepEqual(empty.title.rawRanges, [])
  assert.equal(empty.use.token.attrGet('title'), null, 'Installed rule intentionally omits the empty title attribute')
  assert.equal(absent.titleConsumed, false); assert.equal(absent.title, null)
  assert.ok(empty.shell.some(value => value.to === empty.title!.span.from))
  assert.ok(empty.shell.some(value => value.from === empty.title!.span.from))
})

test('real single-quote and parenthesized title helpers provide their own consumed body ranges', () => {
  const source = '[one](One.md \'A\\\'B\') [two](Two.md (C\\)D))', result = complete(source)
  assert.deepEqual(result.carriers.map(value => value.title?.span.raw), ["A\\'B", 'C\\)D'])
  assert.deepEqual(result.carriers.map(value => value.titleConsumed), [true, true])
  assert.equal(shellText(result.carriers[0]), "[]( '')")
  assert.equal(shellText(result.carriers[1]), '[]( ())')
})

test('a successful empty-title trial discarded by actual reference fallback is not a consumed direct title', () => {
  const source = '[x](<u> ""X[r]\n\n[r]: Ref.md', helper = markdownEngine.helpers.parseLinkTitle
  let actualEmptyTrial = 0
  try {
    markdownEngine.helpers.parseLinkTitle = (text, from, max, previous) => {
      const result = helper(text, from, max, previous)
      if (result.ok && result.str === '' && text === source.split('\n')[0]) actualEmptyTrial++
      return result
    }
    const result = observeMarkdownSourceCarriers(source), value = result.carriers[0]
    assert.ok(actualEmptyTrial > 0, 'The actual installed direct branch really tried and accepted the empty title helper')
    assert.equal(result.observation.complete, true)
    assert.equal(result.observation.uses[0].kind, 'reference')
    assert.equal(result.observation.uses[0].destination?.destination?.raw, 'Ref.md')
    assert.equal(value.complete, false); assert.equal(value.reason, 'nonadjacent-reference-selector')
    assert.equal(value.titleConsumed, false); assert.equal(value.title, null)
    assert.equal(result.complete, false)
  } finally { markdownEngine.helpers.parseLinkTitle = helper }
  complete('[x](<> "")')
})

test('full references expose only independent display and protect the actual selector; collapsed and shortcut combine the roles', () => {
  const source = '[A][r] [r][] [r]\n\n[r]: Same.md "definition title"', result = complete(source), definitions = result.observation.physicalDestinations
  assert.deepEqual(result.carriers.map(value => value.form), ['reference-full', 'reference-collapsed', 'reference-shortcut'])
  assert.deepEqual(result.carriers.map(value => value.display?.span.raw ?? null), ['A', null, null])
  assert.deepEqual(result.carriers.map(value => value.selector?.role), ['reference-selector', 'combined-selector-display', 'combined-selector-display'])
  assert.deepEqual(result.carriers.map(value => value.selector?.span.raw), ['r', 'r', 'r'])
  assert.equal(shellText(result.carriers[0]), '[][r]')
  assert.equal(shellText(result.carriers[1]), '[r][]'); assert.equal(shellText(result.carriers[2]), '[r]')
  assert.equal(result.carriers.every(value => !value.titleConsumed && value.title === null), true)
  assert.equal(result.carriers.every(value => value.destination === definitions[0]), true)
})

test('empty full-reference display is a certified insertion point and normalized selectors remain authored raw bytes', () => {
  const source = '[][ r ]\n\n[r]: Guide.md', result = complete(source), value = result.carriers[0]
  assert.equal(value.form, 'reference-full'); assert.ok(value.display)
  assert.equal(value.display.span.from, 1); assert.equal(value.display.span.to, 1)
  assert.equal(value.selector?.span.raw, ' r ')
  assert.deepEqual(value.display.rawRanges, [])
  assert.deepEqual(value.shell.map(part => part.raw), ['[', '][ r ]'])
})

test('active and inactive definitions remain physical and reference roles point at the actual first definition', () => {
  const source = '[A][r] [B][r]\n\n[r]: Same.md "first"\n[r]: Same.md "inactive"', result = complete(source)
  const definitions = result.observation.physicalDestinations.filter(value => value.kind === 'definition')
  assert.equal(definitions.length, 2); assert.deepEqual(definitions.map(value => value.active), [true, false])
  assert.notEqual(definitions[0], definitions[1])
  assert.equal(result.carriers.every(value => value.destination === definitions[0]), true)
  assert.equal(result.carriers.length, 2, 'No declaration label/title role or extra use-level physical key is invented')
})

test('nested image lookahead helpers cannot become the outer link destination or display receipt', () => {
  const source = '[outer ![alt](Image.png)](Target.md "actual")', helper = markdownEngine.helpers.parseLinkDestination
  const calls: string[] = []
  try {
    markdownEngine.helpers.parseLinkDestination = (text, from, max) => {
      const result = helper(text, from, max)
      if (result.ok) calls.push(result.str)
      return result
    }
    const result = complete(source), value = result.carriers[0]
    assert.ok(calls.includes('Image.png')); assert.ok(calls.includes('Target.md'))
    assert.equal(result.carriers.length, 1); assert.equal(value.display?.span.raw, 'outer ![alt](Image.png)')
    assert.equal(value.destination?.destination?.raw, 'Target.md'); assert.equal(value.title?.span.raw, 'actual')
  } finally { markdownEngine.helpers.parseLinkDestination = helper }
})

test('real skipToken cache hits change silent helper counts without changing top-level role facts', () => {
  const source = '[outer ![alt](Image.png) end](Target.md)', previous = markdownEngine.inline.skipToken
  let cacheHits = 0
  try {
    markdownEngine.inline.skipToken = state => {
      const from = state.pos
      previous.call(markdownEngine.inline, state)
      const end = state.pos
      assert.equal(state.cache[from], end)
      state.pos = from
      previous.call(markdownEngine.inline, state)
      assert.equal(state.pos, end)
      cacheHits++
    }
    const result = complete(source)
    assert.ok(cacheHits > 0)
    assert.equal(result.carriers[0].display?.span.raw, 'outer ![alt](Image.png) end')
    assert.equal(result.carriers[0].destination?.destination?.raw, 'Target.md')
  } finally { markdownEngine.inline.skipToken = previous }
})

test('nested cold observers own their actual helper frames and restore the outer wrappers', () => {
  const helper = markdownEngine.helpers.parseLinkDestination, before = snapshot()
  let entered = false, nested: MarkdownSourceCarrierObservation | undefined
  try {
    markdownEngine.helpers.parseLinkDestination = (text, from, max) => {
      if (!entered) {
        entered = true
        nested = complete('[inner](Inner.md "I")')
      }
      return helper(text, from, max)
    }
    const result = complete('[outer](Outer.md "O")')
    assert.ok(nested)
    assert.equal(nested.carriers[0].title?.span.raw, 'I')
    assert.equal(result.carriers[0].title?.span.raw, 'O')
    assert.notEqual(nested.carriers[0].use.token, result.carriers[0].use.token)
  } finally { markdownEngine.helpers.parseLinkDestination = helper }
  restored(before)
})

test('helper throws restore every temporary helper and inherited StateInline.push before the next successful parse', () => {
  const original = snapshot(), Previous = markdownEngine.inline.State, states: StateInline[] = []
  class InspectState extends Previous { constructor(...args: ConstructorParameters<typeof Previous>) { super(...args); states.push(this) } }
  const failure = new Error('actual cold helper failed')
  try {
    markdownEngine.inline.State = InspectState
    for (const name of ['label', 'destination', 'title'] as const) {
      const before = snapshot()
      if (name === 'label') markdownEngine.helpers.parseLinkLabel = () => { throw failure }
      else if (name === 'destination') markdownEngine.helpers.parseLinkDestination = () => { throw failure }
      else markdownEngine.helpers.parseLinkTitle = () => { throw failure }
      const failing = snapshot()
      assert.throws(() => observeMarkdownSourceCarriers('[x](Target.md "T")'), error => error === failure)
      restored(failing)
      assert.equal(states.every(state => !Object.hasOwn(state, 'push')), true)
      markdownEngine.helpers.parseLinkLabel = before.label; markdownEngine.helpers.parseLinkDestination = before.destination; markdownEngine.helpers.parseLinkTitle = before.title
      complete('[x](Target.md "T")')
    }
  } finally {
    markdownEngine.helpers.parseLinkLabel = original.label; markdownEngine.helpers.parseLinkDestination = original.destination; markdownEngine.helpers.parseLinkTitle = original.title
    markdownEngine.inline.State = Previous
  }
  restored(original)
})

test('an existing own push descriptor is restored exactly and an unwrappable push cannot grant role authority', () => {
  const Previous = markdownEngine.inline.State, records: Array<{ state: StateInline; descriptor: PropertyDescriptor }> = []
  let configurable = true
  class OwnPushState extends Previous {
    constructor(...args: ConstructorParameters<typeof Previous>) {
      super(...args)
      const inherited = this.push
      Object.defineProperty(this, 'push', { value: inherited, writable: false, enumerable: true, configurable })
      records.push({ state: this, descriptor: Object.getOwnPropertyDescriptor(this, 'push')! })
    }
  }
  try {
    markdownEngine.inline.State = OwnPushState
    complete('[x](Target.md "T")')
    configurable = false
    const result = observeMarkdownSourceCarriers('[x](Target.md "T")')
    assert.equal(result.observation.complete, true)
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.reason === 'unsupported-use-role'))
    for (const { state, descriptor } of records) assert.deepEqual(Object.getOwnPropertyDescriptor(state, 'push'), descriptor)
  } finally { markdownEngine.inline.State = Previous }
})

test('an error in an actual nested native body rule restores the cold hooks before reuse', () => {
  const source = serializeBlocksToMarkdown([{ type: 'toggle', content: 'title', depth: 0 },
    { type: 'paragraph', content: '[body](Body.md "T")', depth: 1 }])
  const original = snapshot(), failure = new Error('nested title helper'), helper = markdownEngine.helpers.parseLinkTitle
  try {
    markdownEngine.helpers.parseLinkTitle = () => { throw failure }
    const failing = snapshot()
    assert.throws(() => observeMarkdownSourceCarriers(source), error => error === failure)
    restored(failing)
  } finally { markdownEngine.helpers.parseLinkTitle = helper }
  restored(original); complete(source); restored(original)
})

test('an actual own push getter keeps its dynamic delegate sequence without an extra observer read', () => {
  const Previous = markdownEngine.inline.State
  const records: Array<{ state: StateInline; descriptor: PropertyDescriptor; mode: string }> = []
  const reads = { ordinary: 0, original: 0, carrier: 0 }
  let mode: keyof typeof reads = 'ordinary'
  class GetterState extends Previous {
    constructor(...args: ConstructorParameters<typeof Previous>) {
      super(...args)
      const inherited = this.push, ownMode = mode
      let serial = 0
      Object.defineProperty(this, 'push', { configurable: true, enumerable: true, get() {
        reads[ownMode]++; const delegate = ++serial
        return function(this: StateInline, type: string, tag: string, nesting: -1 | 0 | 1): Token {
          const token = inherited.call(this, type, tag, nesting)
          token.info = `actual-delegate-${delegate}`
          return token
        }
      } })
      records.push({ state: this, descriptor: Object.getOwnPropertyDescriptor(this, 'push')!, mode: ownMode })
    }
  }
  const inlineFacts = (values: readonly Token[]) => tokens(values).filter(value => value.type === 'link_open' || value.type === 'link_close')
    .map(value => ({ type: value.type, tag: value.tag, nesting: value.nesting, attrs: value.attrs, info: value.info }))
  try {
    markdownEngine.inline.State = GetterState
    const source = '[x](Target.md "T")', ordinary = inlineFacts(markdownEngine.parse(source, {}))
    mode = 'original'; const original = observeMarkdownSourceOccurrences(source)
    mode = 'carrier'; const result = observeMarkdownSourceCarriers(source)
    assert.equal(result.observation.complete, true); assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.reason === 'unsupported-use-role'))
    assert.deepEqual(inlineFacts(original.tokens), ordinary)
    assert.deepEqual(inlineFacts(result.observation.tokens), ordinary)
    assert.deepEqual(ordinary.map(value => value.info), ['actual-delegate-1', 'actual-delegate-2'])
    assert.equal(reads.carrier, reads.ordinary); assert.equal(reads.original, reads.ordinary)
    for (const record of records) assert.deepEqual(Object.getOwnPropertyDescriptor(record.state, 'push'), record.descriptor)
  } finally { markdownEngine.inline.State = Previous }
})

test('a push accessor inherited from the actual State prototype is never read early or shadowed', () => {
  const Previous = markdownEngine.inline.State, inherited = Previous.prototype.push
  const records: StateInline[] = [], reads = { ordinary: 0, carrier: 0 }
  let mode: keyof typeof reads = 'ordinary'
  class GetterState extends Previous { constructor(...args: ConstructorParameters<typeof Previous>) { super(...args); records.push(this) } }
  Object.defineProperty(GetterState.prototype, 'push', { configurable: true, get() {
    reads[mode]++
    return inherited
  } })
  try {
    markdownEngine.inline.State = GetterState
    markdownEngine.parse('[x](Target.md)', {})
    mode = 'carrier'; const result = observeMarkdownSourceCarriers('[x](Target.md)')
    assert.equal(result.observation.complete, true); assert.equal(result.complete, false)
    assert.equal(reads.carrier, reads.ordinary)
    assert.equal(records.every(state => !Object.hasOwn(state, 'push')), true)
    assert.equal(typeof Object.getOwnPropertyDescriptor(GetterState.prototype, 'push')?.get, 'function')
  } finally { markdownEngine.inline.State = Previous }
})

test('CRLF, BOM and emoji use actual UTF16 positions and leave quote/list structural gaps protected', () => {
  for (const prefix of ['> ', '- ']) {
    const continuation = prefix === '> ' ? '> ' : '  '
    const source = '\uFEFF' + prefix + '[😀 first\r\n' + continuation + 'second](Guide.md "T")', value = complete(source).carriers[0]
    assert.equal(value.display?.span.parsed, '😀 first\nsecond')
    assert.equal(value.display.span.from, source.indexOf('😀'))
    assert.equal(value.display.rawRanges.some(part => part.raw.includes(continuation + 'second')), false)
    assert.ok(value.shell.some(part => part.raw === continuation), 'The removed prefix is protected, not authorized display hull')
    const newline = value.display.span.parsed.indexOf('\n')
    assert.equal(value.display.span.projection.ends[newline] - value.display.span.projection.starts[newline], 2)
  }
})

test('native title/body codec preserves actual role projections without confusing encoded shell text with markup', () => {
  const source = serializeBlocksToMarkdown([
    { type: 'toggle', content: '[label </summary>](Guide.md "T </summary>")', depth: 0 },
    { type: 'paragraph', content: '[body </details>][r]\n\n[r]: Body.md', depth: 1 }
  ]), result = complete(source)
  assert.equal(result.carriers[0].display?.span.parsed, 'label </summary>')
  assert.equal(result.carriers[0].title?.span.parsed, 'T </summary>')
  assert.notEqual(result.carriers[0].display?.span.raw, result.carriers[0].display?.span.parsed)
  assert.equal(result.carriers[1].display?.span.parsed, 'body </details>')
  assert.equal(result.carriers[1].form, 'reference-full')
})

test('bare/angled empty destinations keep unique points separate from empty label and title slots', () => {
  const source = '[]() [x](   ) [](<> "")', result = complete(source)
  assert.equal(result.carriers[0].display?.span.from, 1)
  assert.equal(result.carriers[0].destination?.destination?.from, 3)
  assert.equal(result.carriers[1].destination?.destination?.from, source.indexOf('(   )') + 1)
  assert.equal(result.carriers[2].titleConsumed, true)
  for (const value of result.carriers) {
    const destination = value.destination!.destination!
    assert.equal(destination.from, destination.to)
    assert.ok(value.shell.some(part => part.to === destination.from))
    assert.ok(value.shell.some(part => part.from === destination.from))
  }
})

test('final core title/selector/tag mutation invalidates role completeness even if href and use identity survive', () => {
  const rule = markdownEngine.core.ruler.__rules__.find(value => value.name === 'linkify')!, previous = rule.fn
  try {
    for (const mutation of ['title', 'selector', 'tag'] as const) {
      markdownEngine.core.ruler.at('linkify', state => {
        previous(state)
        if (state.inlineMode) return
        const emitted = tokens(state.tokens).find(value => value.type === 'link_open')!
        if (mutation === 'title') emitted.attrSet('title', 'changed')
        else if (mutation === 'selector') { assert.ok(emitted.meta); emitted.meta.label = 'different' }
        else emitted.tag = 'span'
      })
      const source = mutation === 'selector' ? '[A][r]\n\n[r]: Target.md' : '[A](Target.md "T")', result = observeMarkdownSourceCarriers(source)
      assert.equal(result.observation.complete, true, 'The existing raw href/type/owner receipt alone does not prove title/branch roles')
      assert.equal(result.complete, false)
      assert.ok(result.barriers.some(value => value.reason === 'post-rule-carrier-token-rewrite'))
    }
  } finally { markdownEngine.core.ruler.at('linkify', previous) }
})

test('the cold title result descriptor read does not invoke a caller getter before the installed rule', () => {
  const helper = markdownEngine.helpers.parseLinkTitle
  let reads = 0
  try {
    markdownEngine.helpers.parseLinkTitle = (text, from, max, previous) => {
      const result = helper(text, from, max, previous), ok = result.ok
      Object.defineProperty(result, 'ok', { configurable: true, get() { reads++; return ok } })
      return result
    }
    const result = observeMarkdownSourceCarriers('[A](Target.md "T")')
    assert.equal(reads, 1, 'Only the real installed branch reads the accessor; the observer merely rejects the layout')
    assert.equal(result.complete, false)
    assert.equal(result.carriers[0].reason, 'unproven-rule-frame')
  } finally { markdownEngine.helpers.parseLinkTitle = helper }
})

test('facts and ranges are deeply immutable snapshots without freezing actual parser tokens or arrays', () => {
  const result = complete('[A](Target.md "T")'), value = result.carriers[0]
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.carriers)); assert.ok(Object.isFrozen(result.barriers))
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.display)); assert.ok(Object.isFrozen(value.display?.rawRanges))
  assert.ok(Object.isFrozen(value.title?.span.projection.starts)); assert.ok(Object.isFrozen(value.shell)); assert.ok(Object.isFrozen(value.shell[0]))
  assert.equal(Object.isFrozen(value.use.token), false); assert.equal(Object.isFrozen(value.use.inlineTokens), false)
  value.use.token.attrSet('title', 'later')
  assert.equal(value.title?.span.raw, 'T'); assert.equal(value.titleConsumed, true); assert.equal(result.complete, true)
})

test('unsupported Wiki/HTML/autolink roles and existing unknown scopes remain explicit barriers', () => {
  for (const source of ['[[Note|Alias]]', '<a href="Target.md">body</a>', '<https://example.com/a>']) {
    const result = observeMarkdownSourceCarriers(source)
    assert.equal(result.observation.complete, true)
    assert.equal(result.complete, false)
    assert.ok(result.barriers.some(value => value.reason === 'unsupported-use-role'))
    assert.equal(result.carriers.every(value => value.display === null && value.title === null), true)
  }
  for (const source of ['| a | b |\n| - | - |\n| [a](A.md) | b |', '^[plain]', '[^n]: plain\n\n[^n]']) {
    const result = observeMarkdownSourceCarriers(source)
    assert.equal(result.observation.complete, false); assert.equal(result.complete, false)
  }
})


test('actual direct and nested-image helper calls preserve receiver and exact argument arity', () => {
  const helpers = markdownEngine.helpers
  const previous = { label: helpers.parseLinkLabel, destination: helpers.parseLinkDestination, title: helpers.parseLinkTitle }
  const calls: Array<{ helper: string; arity: number; source: string; from: number; max: number; disableNested?: boolean }> = []
  const facts = (values: readonly Token[]) => tokens(values).filter(value => value.type === 'link_open' || value.type === 'image')
    .map(value => ({ type: value.type, href: value.attrGet('href'), src: value.attrGet('src'), title: value.attrGet('title') }))
  try {
    helpers.parseLinkLabel = function (this: typeof helpers, state, from, disableNested) {
      assert.equal(this, helpers)
      calls.push({ helper: 'label', arity: arguments.length, source: state.src, from, max: state.posMax, disableNested })
      return Reflect.apply(previous.label, this, arguments)
    }
    helpers.parseLinkDestination = function (this: typeof helpers, source, from, max) {
      assert.equal(this, helpers)
      calls.push({ helper: 'destination', arity: arguments.length, source, from, max })
      return Reflect.apply(previous.destination, this, arguments)
    }
    helpers.parseLinkTitle = function (this: typeof helpers, source, from, max, continuation) {
      assert.equal(this, helpers)
      calls.push({ helper: 'title', arity: arguments.length, source, from, max })
      return Reflect.apply(previous.title, this, arguments)
    }
    const source = '[outer ![alt](Image.png "image title")](Target.md "link title")'
    const ordinary = facts(markdownEngine.parse(source, { captureSourceLinks: true })), actualCalls = calls.splice(0)
    assert.ok(actualCalls.some(value => value.helper === 'label'))
    assert.ok(actualCalls.some(value => value.helper === 'destination'))
    assert.ok(actualCalls.some(value => value.helper === 'title' && value.arity === 3))
    const result = complete(source)
    assert.deepEqual(facts(result.observation.tokens), ordinary)
    assert.deepEqual(calls, actualCalls, 'Preserve every actual delegate call, including silent and nested image invocations')
    assert.equal(result.carriers[0].display?.span.raw, 'outer ![alt](Image.png "image title")')
    assert.equal(result.carriers[0].title?.span.raw, 'link title')
  } finally { helpers.parseLinkLabel = previous.label; helpers.parseLinkDestination = previous.destination; helpers.parseLinkTitle = previous.title }
})

test('actual reference title continuations and nested cold observers preserve receiver and arity', () => {
  const helpers = markdownEngine.helpers, title = helpers.parseLinkTitle
  const calls: Array<{ arity: number; source: string; from: number; max: number; continuing: boolean }> = []
  let nesting = false, nested: MarkdownSourceCarrierObservation | undefined, observeNested = false
  try {
    helpers.parseLinkTitle = function (this: typeof helpers, source, from, max, continuation) {
      assert.equal(this, helpers)
      calls.push({ arity: arguments.length, source, from, max, continuing: continuation !== undefined })
      if (observeNested && !nesting) {
        nesting = true
        try { nested = complete('[inner](Inner.md "inner")') } finally { nesting = false }
      }
      return Reflect.apply(title, this, arguments)
    }
    const source = '[full][r] [r][] [r] [outer ![alt](Image.png "image")](Target.md "outer")\n\n[r]: Ref.md "reference\ncontinued"'
    markdownEngine.parse(source, { captureSourceLinks: true })
    const ordinaryCalls = calls.splice(0)
    assert.ok(ordinaryCalls.some(value => value.arity === 4 && value.continuing), 'The installed reference rule really continues its title helper')
    const result = complete(source)
    assert.deepEqual(calls, ordinaryCalls)
    assert.deepEqual(result.carriers.map(value => value.form), ['reference-full', 'reference-collapsed', 'reference-shortcut', 'direct'])
    calls.length = 0; observeNested = true
    const nestedResult = complete('[outer](Outer.md "outer")')
    assert.ok(nested)
    assert.equal(nested.carriers[0].title?.span.raw, 'inner')
    assert.equal(nestedResult.carriers[0].title?.span.raw, 'outer')
    assert.equal(calls.every(value => value.arity === 3), true)
  } finally { helpers.parseLinkTitle = title }
})
