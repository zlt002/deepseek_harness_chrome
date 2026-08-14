import assert from 'node:assert/strict'
import test from 'node:test'

import { HarnessFrameSource } from '../entrypoints/sidepanel/harness-frame.ts'

test('uses the native loopback URL as the Harness iframe source', () => {
  assert.equal(HarnessFrameSource('http://127.0.0.1:62070'), 'http://127.0.0.1:62070')
})
