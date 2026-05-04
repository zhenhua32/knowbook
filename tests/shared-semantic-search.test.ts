import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreKeywordSearchCandidate } from '../src/shared/semantic-search.ts'

test('scoreKeywordSearchCandidate matches Chinese queries across whitespace and punctuation', () => {
  const score = scoreKeywordSearchCandidate(
    '路由器搜索',
    '这篇笔记介绍了路由器，搜索面板以及筛选条件的设计。'
  )

  assert.equal(score > 0, true)
})

test('scoreKeywordSearchCandidate keeps whitespace token matching for latin queries', () => {
  const relevant = scoreKeywordSearchCandidate('router search', 'router search panel and ranking logic')
  const unrelated = scoreKeywordSearchCandidate('router search', 'document backup exporter and plugin loader')

  assert.equal(relevant > unrelated, true)
  assert.equal(unrelated, 0)
})