import assert from 'node:assert/strict'
import test from 'node:test'
import { getErrorMessage } from '../src/renderer/src/utils/errorMessage'

test('getErrorMessage strips ipc invoke prefixes', () => {
  const error = new Error("Error invoking remote method 'knowbook:preview-document-block-ai-edit': AI block edit request failed before the AI service responded.")

  assert.equal(
    getErrorMessage(error, 'fallback'),
    'AI block edit request failed before the AI service responded.'
  )
})

test('getErrorMessage falls back for non-error values', () => {
  assert.equal(getErrorMessage('boom', 'fallback'), 'fallback')
})