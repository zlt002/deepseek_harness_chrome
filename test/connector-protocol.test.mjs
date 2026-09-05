import assert from 'node:assert/strict'
import test from 'node:test'
import { sameBrowserTarget, sameConnectorCorrelation, validBrowserTarget, validBrowserTargetBinding, validConnectorResponseEnvelope } from '../apps/native-server/src/transport/connector-protocol.mjs'

const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://docs.example.test/a' }

test('Browser Target contract is exact and supports a selected target set', () => {
  assert.equal(validBrowserTarget(target), true)
  assert.equal(validBrowserTarget({ ...target, title: 'not identity' }), false)
  assert.equal(sameBrowserTarget(target, { ...target }), true)
  assert.equal(validBrowserTargetBinding(target, [target], []), true)
  assert.equal(validBrowserTargetBinding(target, [target, { ...target }], []), false)
})

test('Connector response contract requires correlation and one outcome', () => {
  const correlation = { requestId: 'request-1', runId: 'run-1', generation: 'generation-1' }
  assert.equal(sameConnectorCorrelation(correlation, { ...correlation }), true)
  assert.equal(validConnectorResponseEnvelope({ type: 'connector_response', ...correlation, result: {} }), true)
  assert.equal(validConnectorResponseEnvelope({ type: 'connector_response', ...correlation, error: 'failed' }), true)
  assert.equal(validConnectorResponseEnvelope({ type: 'connector_response', ...correlation, result: {}, error: 'failed' }), false)
  assert.equal(validConnectorResponseEnvelope({ type: 'connector_response', ...correlation }), false)
})
