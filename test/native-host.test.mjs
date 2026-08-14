import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NativeHost } from '../native-server/src/native-host.mjs'

test('starts one Harness proxy for repeated start requests and exits on close', async () => {
  const upstream = createServer((_request, response) => response.end('ok'))
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.notEqual(typeof address, 'string')
  const harnessUrl = `http://127.0.0.1:${String(address.port)}`
  let starts = 0
  let stops = 0
  const exited = []
  const host = new NativeHost({
    processFactory: () => ({
      start: async () => {
        starts += 1
        return harnessUrl
      },
      stop: async () => { stops += 1 },
    }),
    exit: (code) => exited.push(code),
  })
  const messages = []
  host.send = (message) => messages.push(message)
  try {
    await Promise.all([host.startHarness(), host.startHarness()])
    assert.equal(starts, 1)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].type, 'server_started')
    assert.equal(messages[0].payload.url, messages[1].payload.url)

    await host.close('stop requested')
    assert.equal(stops, 1)
    assert.deepEqual(exited, [0])
  } finally {
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('cleans up a Harness when proxy startup fails', async () => {
  let stopped = 0
  const host = new NativeHost({
    processFactory: () => ({
      start: async () => 'not-a-url',
      stop: async () => { stopped += 1 },
    }),
    exit: () => {},
  })
  const messages = []
  host.send = (message) => messages.push(message)

  await host.startHarness()
  assert.equal(stopped, 1)
  assert.equal(messages[0].type, 'error')
  assert.equal(host.harness, undefined)
  assert.equal(host.proxy, undefined)
})
