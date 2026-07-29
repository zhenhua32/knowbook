import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getOpenLinkContext,
  getSlashCommandContext,
  removeSlashCommand
} from '../src/renderer/src/utils/editorAssist.ts'

test('link assist finds the latest unclosed wiki link at the cursor', () => {
  assert.deepEqual(
    getOpenLinkContext('See [[Old]] and [[  Home/Project  ', 34),
    { query: 'Home/Project', start: 16 }
  )
  assert.deepEqual(
    getOpenLinkContext('prefix [[target suffix', 15),
    { query: 'target', start: 7 }
  )
})

test('link assist ignores closed links, multiline segments, and text without an opener', () => {
  assert.equal(getOpenLinkContext('See [[Home]]', 12), null)
  assert.equal(getOpenLinkContext('See [[Home\nProject', 18), null)
  assert.equal(getOpenLinkContext('ordinary text', 8), null)
  assert.equal(getOpenLinkContext('[[future]] [[active', 10), null)
})

test('slash assist recognizes an indented command only on the current line', () => {
  assert.deepEqual(
    getSlashCommandContext('first line\n   /rew', 18),
    { query: 'rew', start: 14 }
  )
  assert.deepEqual(
    getSlashCommandContext('/todo trailing text', 5),
    { query: 'todo', start: 0 }
  )
})

test('slash assist closes after any whitespace or non-command prefix', () => {
  assert.equal(getSlashCommandContext('prefix /todo', 12), null)
  assert.equal(getSlashCommandContext('/todo more', 10), null)
  assert.equal(getSlashCommandContext('/todo\tmore', 10), null)
  assert.equal(getSlashCommandContext('line\n /todo more', 16), null)
})

test('slash removal preserves trailing content and returns the corrected cursor', () => {
  assert.deepEqual(
    removeSlashCommand('Before /rewrite after', 7, 15),
    {
      content: 'Before  after',
      cursorPosition: 7
    }
  )
  assert.deepEqual(removeSlashCommand('/todo', 0, 5), {
    content: '',
    cursorPosition: 0
  })
})

test('slash removal clamps invalid ranges without deleting unrelated prefixes', () => {
  assert.deepEqual(removeSlashCommand('abc/todo rest', -5, 8), {
    content: ' rest',
    cursorPosition: 0
  })
  assert.deepEqual(removeSlashCommand('abc/todo', 3, 99), {
    content: 'abc',
    cursorPosition: 3
  })
})
