import assert from 'node:assert/strict'
import test from 'node:test'
import { editCodeIndentation } from '../src/renderer/src/utils/codeIndentation'

test('collapsed Tab inserts two spaces at the caret without rewriting surrounding source', () => {
  assert.deepEqual(editCodeIndentation('abc', 1, 1, false), {
    content: 'a  bc', start: 3, end: 3, direction: 'none'
  })
  assert.deepEqual(editCodeIndentation('', 0, 0, false), {
    content: '  ', start: 2, end: 2, direction: 'none'
  })
  assert.deepEqual(editCodeIndentation('a\n', 2, 2, false), {
    content: 'a\n  ', start: 4, end: 4, direction: 'none'
  })
})

test('Tab indents every touched line instead of replacing a single or multiline selection', () => {
  assert.deepEqual(editCodeIndentation('x = y', 4, 5, false, 'forward'), {
    content: '  x = y', start: 6, end: 7, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation('one\ntwo', 0, 7, false, 'backward'), {
    content: '  one\n  two', start: 2, end: 11, direction: 'backward'
  })
  const partial = editCodeIndentation('alpha\nbeta\ngamma', 2, 8, false, 'backward')
  assert.deepEqual(partial, {
    content: '  alpha\n  beta\ngamma', start: 4, end: 12, direction: 'backward'
  })
  assert.equal(partial.content.slice(partial.start, partial.end), 'pha\n  be')
})

test('an endpoint at the next line column zero excludes that line during indent and outdent', () => {
  const indented = editCodeIndentation('alpha\nbeta\n', 0, 6, false, 'forward')
  assert.deepEqual(indented, {
    content: '  alpha\nbeta\n', start: 2, end: 8, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation(indented.content, indented.start, indented.end, true, indented.direction), {
    content: 'alpha\nbeta\n', start: 0, end: 6, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation('  alpha\n  beta', 0, 8, true, 'backward'), {
    content: 'alpha\n  beta', start: 0, end: 6, direction: 'backward'
  })
})

test('Shift+Tab removes one leading tab or at most two leading ASCII spaces without normalizing mixed indentation', () => {
  const content = '\talpha\n \tbeta\n  gamma\n   delta\nx'
  const result = editCodeIndentation(content, 0, content.length, true, 'backward')
  assert.deepEqual(result, {
    content: 'alpha\n\tbeta\ngamma\n delta\nx', start: 0, end: content.length - 6, direction: 'backward'
  })
  const original = '\talpha\n \tbeta'
  const indented = editCodeIndentation(original, 0, original.length, false, 'forward')
  assert.equal(indented.content, '  \talpha\n   \tbeta')
  assert.deepEqual(editCodeIndentation(indented.content, indented.start, indented.end, true, indented.direction), {
    content: original, start: 0, end: original.length, direction: 'forward'
  })
})

test('collapsed Shift+Tab removes only the current line prefix and clamps a caret inside that prefix', () => {
  for (const [caret, after] of [[0, 0], [1, 0], [2, 0], [4, 2]] as const) {
    assert.deepEqual(editCodeIndentation('  alpha', caret, caret, true), {
      content: 'alpha', start: after, end: after, direction: 'none'
    })
  }
  assert.deepEqual(editCodeIndentation('before\n\talpha', 10, 10, true), {
    content: 'before\nalpha', start: 9, end: 9, direction: 'none'
  })
  assert.deepEqual(editCodeIndentation('  alpha', 1, 3, true, 'backward'), {
    content: 'alpha', start: 0, end: 1, direction: 'backward'
  })
})

test('canceling indentation on unindented text is a complete content and selection no-op', () => {
  const content = 'alpha\nbeta\n'
  assert.deepEqual(editCodeIndentation(content, 1, 10, true, 'backward'), {
    content, start: 1, end: 10, direction: 'backward'
  })
  assert.deepEqual(editCodeIndentation(content, content.length, content.length, true), {
    content, start: content.length, end: content.length, direction: 'none'
  })
  assert.deepEqual(editCodeIndentation('', 0, 0, true), {
    content: '', start: 0, end: 0, direction: 'none'
  })
  assert.deepEqual(editCodeIndentation('\u00a0alpha', 0, 6, true, 'forward'), {
    content: '\u00a0alpha', start: 0, end: 6, direction: 'forward'
  })
})

test('UTF-16 offsets and backwards selection survive Chinese and emoji line edits', () => {
  const content = '😀中文\n  🚀 tail\nend'
  const result = editCodeIndentation(content, 2, 9, false, 'backward')
  assert.deepEqual(result, {
    content: '  😀中文\n    🚀 tail\nend', start: 4, end: 13, direction: 'backward'
  })
  assert.equal(result.content.slice(result.start, result.end), '中文\n    🚀')
  assert.deepEqual(editCodeIndentation(result.content, result.start, result.end, true, result.direction), {
    content, start: 2, end: 9, direction: 'backward'
  })
})

test('selected empty lines are indented while a trailing unselected empty line keeps its newline', () => {
  const content = 'a\n\nb\n'
  const result = editCodeIndentation(content, 0, content.length, false, 'forward')
  assert.deepEqual(result, {
    content: '  a\n  \n  b\n', start: 2, end: 11, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation(result.content, result.start, result.end, true, result.direction), {
    content, start: 0, end: content.length, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation('\n', 0, 1, false), {
    content: '  \n', start: 2, end: 3, direction: 'none'
  })
})

test('CRLF and mixed line endings are preserved with correct column-zero and partial-line endpoints', () => {
  const content = 'alpha\r\nbeta\n\tgamma\r\n'
  assert.deepEqual(editCodeIndentation(content, 0, 7, false, 'backward'), {
    content: '  alpha\r\nbeta\n\tgamma\r\n', start: 2, end: 9, direction: 'backward'
  })
  const result = editCodeIndentation(content, 2, 9, false, 'forward')
  assert.deepEqual(result, {
    content: '  alpha\r\n  beta\n\tgamma\r\n', start: 4, end: 13, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation(result.content, result.start, result.end, true, result.direction), {
    content, start: 2, end: 9, direction: 'forward'
  })
  assert.deepEqual(editCodeIndentation('  a\r\n\r\n  b\r\n', 0, 12, true), {
    content: 'a\r\n\r\nb\r\n', start: 0, end: 8, direction: 'none'
  })
})

test('a large multiline selection edits every line in one result without dropping source', () => {
  const content = '\tline\n'.repeat(10_000)
  assert.deepEqual(editCodeIndentation(content, 0, content.length, true, 'forward'), {
    content: 'line\n'.repeat(10_000), start: 0, end: 50_000, direction: 'forward'
  })
})
