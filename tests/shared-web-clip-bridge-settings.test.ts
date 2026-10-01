import assert from 'node:assert/strict'
import test from 'node:test'
import { isWebClipBridgePort, parseWebClipBridgePortDraft } from '../src/shared/web-clip-bridge-settings'

test('bridge port drafts accept full decimal integers within the listening-port range', () => {
  for (const [input, expected] of [['1', 1], ['3210', 3210], ['65535', 65535], [' 4321\n', 4321], ['0004321', 4321]] as const) {
    assert.equal(parseWebClipBridgePortDraft(input), expected, input)
  }
})

test('bridge port drafts reject incomplete, fractional, exponential and out-of-range input without truncating it', () => {
  for (const input of ['', ' ', '0', '-1', '+4321', '65536', '4321.9', '4321.0', '.1', '1e4', '0x10', '4_321', '3,210',
    '43 21', '4321abc', 'NaN', 'Infinity', '９９', '9999999999999999999999999999999999']) {
    assert.equal(parseWebClipBridgePortDraft(input), null, input)
  }
})

test('numeric bridge settings require an actual integer port rather than coercing strings or invalid numbers', () => {
  for (const port of [1, 4321, 65535]) assert.equal(isWebClipBridgePort(port), true)
  for (const value of [0, -1, 65536, 4321.9, Number.NaN, Number.POSITIVE_INFINITY, '4321', '', null, undefined, true, {}]) {
    assert.equal(isWebClipBridgePort(value), false)
  }
})
