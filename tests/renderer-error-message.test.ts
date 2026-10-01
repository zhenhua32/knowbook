import assert from 'node:assert/strict'
import test from 'node:test'
import { getErrorMessage, normalizeErrorMessage } from '../src/renderer/src/utils/errorMessage'

test('getErrorMessage strips ipc invoke prefixes', () => {
  const error = new Error("Error invoking remote method 'knowbook:preview-document-block-ai-edit': AI block edit request failed before the AI service responded.")

  assert.equal(
    getErrorMessage(error, 'fallback'),
    'AI block edit request failed before the AI service responded.'
  )
})

test('getErrorMessage falls back for non-error values', () => {
  for (const value of ['boom', '', null, undefined, 42, { message: 'Error: object text' }]) {
    assert.equal(getErrorMessage(value, 'fallback'), 'fallback')
  }
})

test('normalization removes nested IPC and recognized native error prefixes from the beginning only', () => {
  const message = "Error invoking remote method 'knowbook:restore-backup-from-folder': Error: "
    + "Error invoking remote method 'knowbook:trigger-backup': AggregateError: TypeError: RangeError: SyntaxError: Error: Backup failed."
  assert.equal(normalizeErrorMessage(message), 'Backup failed.')
  assert.equal(getErrorMessage(new Error(message), 'fallback'), 'Backup failed.')
  assert.equal(normalizeErrorMessage("error invoking remote method 'knowbook:trigger-backup': Error: disk full"), 'disk full')
})

test('normalization preserves plain text formatting, paths, quotes, internal Error labels and multiline explanations', () => {
  const plainMessages = [
    '  操作失败，输入仍保留。  ', '\n  Retry the operation.\r\n  Your draft is preserved.\n',
    '保存失败：Error: document changed', 'Disk Error: the path is unavailable.',
    "The provider returned Error invoking remote method 'provider:request': Error: unavailable.",
    'D:\\Notes\\Error: guide.md', '/home/user/Error: notes.md',
    'An Error: string is part of the message.', 'CustomError: Keep this domain-specific label.',
    'HttpError: 429 Too Many Requests', 'SQLiteError: SQLITE_FULL',
    'error: this is ordinary lowercase prose', 'TYPEERROR: preserve non-native uppercase labels',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError'
  ]
  for (const message of plainMessages) {
    assert.equal(normalizeErrorMessage(message, 'fallback'), message)
  }
  const reason = 'Failed to write "D:\\用户资料\\Error: notes.md".\r\n'
    + '保留原文件，关闭占用它的程序后重试。\n  Details: Error: access denied.\n'
  const wrapped = "Error invoking remote method 'knowbook:save-markdown-file': Error: " + reason
  assert.equal(normalizeErrorMessage(wrapped), reason)
  assert.equal(getErrorMessage(new Error(wrapped), 'fallback'), reason.trim())
})

test('malformed IPC envelopes and unrecognized exception labels are not treated as wrappers', () => {
  for (const message of [
    "Error invoking remote method '': Error: unavailable", "Error invoking remote method '   ': Error: unavailable",
    'Error invoking remote method "knowbook:trigger-backup": Error: disk full',
    "Error invoking remote method 'knowbook:trigger-backup' Error: disk full",
    "Error invoking remote method 'knowbook:trigger-backup: Error: disk full",
    "Error invoking remote method 'knowbook:\ntrigger-backup': Error: disk full",
    'Error without a colon', 'TypeError without a colon', 'ProviderError: Error: provider detail',
    'ReferenceError: missing application symbol', 'URIError: malformed URI'
  ]) assert.equal(normalizeErrorMessage(message, 'fallback'), message)
})

test('empty reasons and wrapper-only errors use an optional fallback without modifying the fallback text', () => {
  for (const message of ['', '   ', '\r\n\t', 'Error:', 'Error:  \n',
    "Error invoking remote method 'knowbook:trigger-backup': Error: TypeError: \t\n"]) {
    assert.equal(normalizeErrorMessage(message), '')
    assert.equal(normalizeErrorMessage(message, '请重试。'), '请重试。')
    assert.equal(normalizeErrorMessage(message, '  fallback\n'), '  fallback\n')
    assert.equal(getErrorMessage(new Error(message), '  fallback\n'), '  fallback\n')
  }
})

test('getErrorMessage retains trimming, Error subclass and empty fallback compatibility', () => {
  assert.equal(getErrorMessage(new Error('  ordinary reason\n'), 'fallback'), 'ordinary reason')
  assert.equal(getErrorMessage(new Error("  Error invoking remote method 'knowbook:trigger-backup': Error: disk full  \n"), 'fallback'), 'disk full')
  assert.equal(getErrorMessage(new TypeError('Incorrect input.'), 'fallback'), 'Incorrect input.')
  assert.equal(getErrorMessage(new RangeError('Out of range.'), 'fallback'), 'Out of range.')
  assert.equal(getErrorMessage(new Error('Error:'), ''), '')
  assert.equal(getErrorMessage('Error: raw string', ''), '')
  assert.equal(getErrorMessage(new Error('Error: quota exceeded\nTry again later.'), 'fallback'), 'quota exceeded\nTry again later.')
})

test('Electron IPC errors with only an exception name have no reason and use the caller fallback', () => {
  for (const name of ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError']) {
    const wrapped = `Error invoking remote method 'knowbook:write-clipboard-text': ${name}`
    assert.equal(normalizeErrorMessage(wrapped), '')
    assert.equal(normalizeErrorMessage(wrapped, '  请重试。\n'), '  请重试。\n')
    assert.equal(getErrorMessage(new Error(wrapped), '复制失败。'), '复制失败。')
    assert.equal(normalizeErrorMessage('Error: ' + wrapped + '  \n', 'fallback'), 'fallback')
    assert.equal(normalizeErrorMessage(wrapped + ': Clipboard unavailable', 'fallback'), 'Clipboard unavailable')
  }
  assert.equal(normalizeErrorMessage("Error invoking remote method 'knowbook:write-clipboard-text': Error count: 3"), 'Error count: 3')
  assert.equal(normalizeErrorMessage("Error invoking remote method 'knowbook:write-clipboard-text': CustomError"), 'CustomError')
})

test('wrapper matching stops as soon as the failure reason begins and leaves later technical-looking lines intact', () => {
  const reason = "Remote backup failed.\nError invoking remote method 'diagnostic:retry': Error: timeout\n"
    + 'TypeError: a nested diagnostic detail\n  Keep indentation and trailing whitespace.  '
  assert.equal(normalizeErrorMessage('Error: ' + reason), reason)
  assert.equal(normalizeErrorMessage('TypeError: CustomError: Error: provider detail'), 'CustomError: Error: provider detail')
  assert.equal(normalizeErrorMessage('Error: Error count: 3'), 'Error count: 3')
})
