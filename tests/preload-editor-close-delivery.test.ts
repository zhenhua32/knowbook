import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createEditorCloseDelivery } from '../src/preload/editor-close-delivery'
import type { EditorCloseRequest, EditorCloseCancelled } from '../src/shared/editor-close'

test('preload replays only the original live Main close nonce after the App lazy listener registers', () => {
  const delivery = createEditorCloseDelivery(), original: EditorCloseRequest = Object.freeze({ requestId: randomUUID(), reason: 'window' })
  delivery.request(original)
  const observed: EditorCloseRequest[] = [], remove = delivery.onRequest(value => observed.push(value))
  assert.equal(observed.length, 1); assert.equal(observed[0], original)
  delivery.request({ ...original })
  assert.equal(observed.length, 1, 'ready replay of the same real nonce may not start a second renderer flush')
  assert.deepEqual(Object.keys(observed[0]).sort(), ['reason', 'requestId'])
  remove()
  delivery.cancel({ ...original, message: 'actual Main cancellation' })
  delivery.onRequest(value => observed.push(value))
  assert.equal(observed.length, 1, 'an expired attempt must never be replayed as a new close request')
})

test('an actual cancellation between request and cancel subscriptions is retained without inventing an ACK', () => {
  const delivery = createEditorCloseDelivery(), request: EditorCloseRequest = { requestId: randomUUID(), reason: 'quit' }
  const cancelled: EditorCloseCancelled = { ...request, message: 'Main cancelled its original attempt' }
  delivery.request(request)
  let frozen: string | null = null
  delivery.onRequest(value => { frozen = value.requestId })
  delivery.cancel(cancelled)
  const cancellations: EditorCloseCancelled[] = []
  delivery.onCancelled(value => { cancellations.push(value); if (value.requestId === frozen) frozen = null })
  assert.equal(cancellations[0], cancelled); assert.equal(frozen, null)
})

test('a late different-nonce cancellation cannot remove the new real pending close request', () => {
  const delivery = createEditorCloseDelivery(), old: EditorCloseRequest = { requestId: randomUUID(), reason: 'window' }
  const current: EditorCloseRequest = { requestId: randomUUID(), reason: 'quit' }
  delivery.request(old); delivery.request(current); delivery.cancel({ ...old, message: 'late old cancellation' })
  const requests: EditorCloseRequest[] = []
  delivery.onRequest(value => requests.push(value))
  assert.deepEqual(requests, [current]); assert.equal(requests[0], current)
})
