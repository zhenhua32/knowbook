import assert from 'node:assert/strict'
import test from 'node:test'
import { createTrailingSingleFlightRefresh } from '../src/renderer/src/utils/singleFlightRefresh.ts'

test('single-flight refresh merges overlap into one trailing refresh', async () => {
  let refreshCount = 0
  let releaseFirstRefresh!: () => void
  const firstRefreshGate = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve
  })
  const requestRefresh = createTrailingSingleFlightRefresh(async () => {
    refreshCount += 1
    if (refreshCount === 1) {
      await firstRefreshGate
    }
  })

  const first = requestRefresh()
  const overlappingA = requestRefresh()
  const overlappingB = requestRefresh()
  assert.equal(refreshCount, 1)
  assert.equal(first, overlappingA)
  assert.equal(first, overlappingB)

  releaseFirstRefresh()
  await first
  assert.equal(refreshCount, 2)

  await requestRefresh()
  assert.equal(refreshCount, 3)
})

test('single-flight refresh retries a failed request when a trailing refresh is pending', async () => {
  let refreshCount = 0
  let rejectFirstRefresh!: (error: Error) => void
  const firstRefreshGate = new Promise<void>((_resolve, reject) => {
    rejectFirstRefresh = reject
  })
  const requestRefresh = createTrailingSingleFlightRefresh(async () => {
    refreshCount += 1
    if (refreshCount === 1) {
      await firstRefreshGate
    }
  })

  const first = requestRefresh()
  const overlapping = requestRefresh()
  rejectFirstRefresh(new Error('temporary failure'))

  await first
  assert.equal(first, overlapping)
  assert.equal(refreshCount, 2)
})

test('single-flight refresh recovers after an isolated failure', async () => {
  let refreshCount = 0
  const requestRefresh = createTrailingSingleFlightRefresh(async () => {
    refreshCount += 1
    if (refreshCount === 1) {
      throw new Error('temporary failure')
    }
  })

  await assert.rejects(requestRefresh(), /temporary failure/)
  await requestRefresh()
  assert.equal(refreshCount, 2)
})
