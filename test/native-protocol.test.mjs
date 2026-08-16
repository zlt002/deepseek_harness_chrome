import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeNativeFrames, encodeNativeFrame } from '../apps/native-server/src/protocol.mjs'

test('decodes fragmented and multiple native frames', () => {
  const input = Buffer.concat([
    encodeNativeFrame({ type: 'ping' }),
    encodeNativeFrame({ type: 'start', payload: { port: 0 } }),
  ])
  const first = decodeNativeFrames(input.subarray(0, 7))
  assert.deepEqual(first.messages, [])
  const second = decodeNativeFrames(Buffer.concat([first.remainder, input.subarray(7)]))
  assert.deepEqual(second.messages, [
    { type: 'ping' },
    { type: 'start', payload: { port: 0 } },
  ])
  assert.equal(second.remainder.length, 0)
})

test('reports invalid JSON without losing the next frame', () => {
  const invalidBody = Buffer.from('{not-json', 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(invalidBody.length, 0)
  const decoded = decodeNativeFrames(Buffer.concat([header, invalidBody, encodeNativeFrame({ type: 'ping' })]))
  assert.equal(decoded.messages.length, 1)
  assert.deepEqual(decoded.messages[0], { type: 'ping' })
  assert.equal(decoded.errors.length, 1)
})

test('round trips unicode payloads', () => {
  const message = { type: 'error', error: '模型配置缺失' }
  const decoded = decodeNativeFrames(encodeNativeFrame(message))
  assert.deepEqual(decoded.messages, [message])
})
