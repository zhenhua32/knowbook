import assert from 'node:assert/strict'
import test from 'node:test'
import { EffectScope } from '../src/main/plugin-platform/effect-scope.ts'

test('EffectScope disposes active effects once in reverse registration order', async () => {
  const scope = new EffectScope('root')
  const trace: string[] = []

  scope.own(() => {
    trace.push('first')
  }, 'first')
  const releaseSecond = scope.own(async () => {
    await Promise.resolve()
    trace.push('second')
  }, 'second')
  scope.own(() => {
    trace.push('third')
  }, 'third')

  await releaseSecond()
  await releaseSecond()
  assert.deepEqual(trace, ['second'])
  assert.equal(scope.size, 2)

  const firstDisposal = scope.dispose()
  const secondDisposal = scope.dispose()
  assert.equal(firstDisposal, secondDisposal)
  await firstDisposal

  assert.deepEqual(trace, ['second', 'third', 'first'])
  assert.equal(scope.state, 'disposed')
  assert.equal(scope.size, 0)
})

test('EffectScope owns child scopes and unwinds them with the parent', async () => {
  const parent = new EffectScope('parent')
  const trace: string[] = []

  parent.own(() => {
    trace.push('parent:first')
  })
  const child = parent.child('child')
  child.own(() => {
    trace.push('child')
  })
  parent.own(() => {
    trace.push('parent:last')
  })

  await parent.dispose()
  assert.deepEqual(trace, ['parent:last', 'child', 'parent:first'])
  assert.equal(child.state, 'disposed')
})

test('EffectScope attempts every disposer and aggregates labelled failures', async () => {
  const scope = new EffectScope('failures')
  const trace: string[] = []

  scope.own(() => {
    trace.push('survived')
  }, 'survivor')
  scope.own(() => {
    throw new Error('boom')
  }, 'broken')

  await assert.rejects(scope.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 1)
    assert.match(String(error.errors[0]), /Effect "broken" failed: boom/)
    return true
  })
  assert.deepEqual(trace, ['survived'])
  assert.equal(scope.state, 'disposed')
})

test('EffectScope rejects ownership after disposal starts', async () => {
  const scope = new EffectScope('closed')
  await scope.dispose()
  assert.throws(() => scope.own(() => undefined), /is disposed/)
})
