import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnchangedMergeRangeProjector, MERGE_DIFF_BUDGET_CELLS } from '../src/main/sync/merge-kernel'

type Pair = readonly [source: number, destination: number]
type Matching = readonly Pair[]
type Range = { from: number; to: number }

// Every increasing equal-character pair sequence is generated exactly once.
// This oracle neither builds an LCS table nor uses prefix/suffix optimality.
function allMaximumMatchings(source: string, destination: string): Matching[] {
  const every: Matching[] = []
  function enumerate(sourceStart: number, destinationStart: number, pairs: Pair[]) {
    every.push(pairs)
    for (let i = sourceStart; i < source.length; i++) {
      for (let j = destinationStart; j < destination.length; j++) {
        if (source[i] === destination[j]) enumerate(i + 1, j + 1, [...pairs, [i, j]])
      }
    }
  }
  enumerate(0, 0, [])
  assert.ok(every.length <= 70, 'Four-character words have at most 70 increasing equal-pair subsequences, including the empty matching')
  const maximum = Math.max(...every.map(pairs => pairs.length))
  return every.filter(pairs => pairs.length === maximum)
}

function expectedRange(matchings: readonly Matching[], range: Range): Range | null {
  let agreed: number[] | null = null
  for (const matching of matchings) {
    const projected: number[] = []
    for (let i = range.from; i < range.to; i++) {
      const pair = matching.find(pair => pair[0] === i)
      if (!pair) return null // Some optimal matching drops this source token.
      projected.push(pair[1])
    }
    for (let i = 1; i < projected.length; i++) {
      if (projected[i] !== projected[i - 1] + 1) return null
    }
    if (agreed && projected.some((value, i) => value !== agreed![i])) return null
    agreed = projected
  }
  assert.ok(agreed && agreed.length > 0, 'A valid nonempty range is checked against at least the empty-or-longer optimal matching set')
  return { from: agreed[0], to: agreed[agreed.length - 1] + 1 }
}

function smallWords(): string[] {
  const result = ['']
  for (let length = 1; length <= 4; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) {
      let text = ''
      for (let position = 0; position < length; position++) text += bits & (1 << position) ? 'b' : 'a'
      result.push(text)
    }
  }
  return result
}

test('synced unchanged ranges match exhaustive all-optimal pair subsequences for every binary word through length four', () => {
  const words = smallWords()
  assert.equal(words.length, 31)
  assert.equal(new Set(words).size, 31)
  let pairsChecked = 0, rangesChecked = 0, identicalPairs = 0, zeroLcsPairs = 0
  for (const source of words) for (const destination of words) {
    const matchings = allMaximumMatchings(source, destination)
    const project = createUnchangedMergeRangeProjector(source, destination, { cells: MERGE_DIFF_BUDGET_CELLS })
    if (source === destination) {
      identicalPairs++
      assert.equal(typeof project, 'function', 'Identical source/destination, including empty text, retain the identity projector fast path')
    }
    if (matchings[0].length === 0) zeroLcsPairs++
    for (let from = 0; from < source.length; from++) {
      for (let to = from + 1; to <= source.length; to++) {
        const range = { from, to }, expected = expectedRange(matchings, range)
        assert.deepEqual(project?.(range) ?? null, expected,
          'All-optimal matching range: ' + JSON.stringify({ source, destination, from, to }))
        rangesChecked++
      }
    }
    pairsChecked++
  }
  assert.equal(pairsChecked, 961)
  assert.equal(rangesChecked, 6882)
  assert.equal(identicalPairs, 31)
  assert.ok(zeroLcsPairs > 0, 'The exhaustive set includes empty and unequal zero-LCS pairs, whose valid source ranges have no surviving proof')
})
