import assert from 'node:assert/strict'
import test from 'node:test'
import {
  highlightCode,
  isCodeHighlightLanguageLoaded,
  loadCodeHighlightLanguage,
  resolveCodeHighlightLanguage
} from '../src/renderer/src/utils/codeHighlighting.ts'

test('code highlighting resolves aliases and rejects unsupported languages', () => {
  assert.equal(resolveCodeHighlightLanguage('ts'), 'typescript')
  assert.equal(resolveCodeHighlightLanguage(' HTML '), 'xml')
  assert.equal(resolveCodeHighlightLanguage('c#'), 'csharp')
  assert.equal(resolveCodeHighlightLanguage('unsupported-language'), null)
  assert.equal(resolveCodeHighlightLanguage(null), null)
})

test('code highlighting loads only the requested grammar before rendering markup', async () => {
  const [first, second] = await Promise.all([
    loadCodeHighlightLanguage('typescript'),
    loadCodeHighlightLanguage('ts')
  ])

  assert.equal(first, 'typescript')
  assert.equal(second, 'typescript')
  assert.equal(isCodeHighlightLanguageLoaded('typescript'), true)
  const highlighted = highlightCode('const answer: number = 42', 'typescript')
  assert.equal(highlighted.language, 'typescript')
  assert.match(highlighted.value, /hljs-keyword/)
})

test('code highlighting safely escapes plaintext while a grammar is unavailable', () => {
  const highlighted = highlightCode('<script>alert("unsafe & raw")</script>', null)
  assert.equal(
    highlighted.value,
    '&lt;script&gt;alert("unsafe &amp; raw")&lt;/script&gt;'
  )
  assert.equal(highlighted.language, undefined)
})
