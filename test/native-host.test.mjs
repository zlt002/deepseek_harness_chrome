import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NativeHost } from '../native-server/src/native-host.mjs'
import { BrowserConnector } from '../native-server/src/connector.mjs'

test('returns the Harness Web URL for repeated start requests and exits on close', async () => {
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
  const target = { browser: 'chrome', windowId: 3, tabId: 4, url: 'https://docs.example.test/first' }
  try {
    await Promise.all([host.startHarness(target), host.startHarness(target)])
    assert.equal(starts, 1)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].type, 'server_started')
    assert.equal(messages[0].payload.url, harnessUrl)
    assert.equal(typeof messages[0].payload.runId, 'string')
    assert.equal(messages[1].payload.url, harnessUrl)
  } finally {
    await host.close('stop requested')
    await new Promise((resolve) => upstream.close(resolve))
  }
  assert.equal(stops, 1)
  assert.deepEqual(exited, [0])
})

test('cleans up a Harness when its Web URL is invalid', async () => {
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

  await host.startHarness({ browser: 'chrome', windowId: 1, tabId: 2, url: 'https://docs.example.test/invalid' })
  assert.equal(stopped, 1)
  assert.equal(messages[0].type, 'error')
  assert.equal(host.harness, undefined)
})

test('starts a pure Harness Run without a Browser Target and leaves browser tools explicitly unbound', async () => {
  let harnessOptions
  const host = new NativeHost({
    processFactory: (options) => {
      harnessOptions = options
      return { start: async () => 'http://127.0.0.1:48124', stop: async () => {} }
    },
    exit: () => {},
  })
  const messages = []
  host.send = (message) => messages.push(message)

  try {
    await host.handle({ type: 'start' })
    const started = messages.find((message) => message.type === 'server_started')
    assert.equal(typeof started?.payload.runId, 'string')
    const response = await fetch(harnessOptions.mcpConnector.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessOptions.mcpConnector.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'office_get_context', arguments: {} },
      }),
    })
    const body = await response.json()
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /no Browser Target is bound/i)
  } finally {
    await host.close('stop requested')
  }
})

test('creates a trusted Run from the explicit Browser Target supplied at Native start and forwards correlated Extension replies', async () => {
  let harnessOptions
  let stopped = 0
  const host = new NativeHost({
    processFactory: (options) => {
      harnessOptions = options
      return {
        start: async () => 'http://127.0.0.1:48123',
        stop: async () => { stopped += 1 },
      }
    },
    connectorFactory: (options) => new BrowserConnector(options),
    exit: () => {},
  })
  const messages = []
  host.send = (message) => messages.push(message)
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://docs.example.test/' }

  try {
    await host.handle({ type: 'start', browserTarget: target })
    assert.match(harnessOptions.mcpConnector.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.match(harnessOptions.mcpConnector.token, /^[A-Za-z0-9_-]{32,}$/)
    const started = messages.find((message) => message.type === 'server_started')
    assert.equal(typeof started.payload.runId, 'string')

    const secondTarget = { browser: 'chrome', windowId: 1, tabId: 3, url: 'https://docs.example.test/other' }
    await host.handle({ type: 'start', browserTarget: secondTarget })
    assert.equal(messages.at(-1).type, 'error')
    assert.match(messages.at(-1).error, /already bound to a different Browser Target/i)

    let pendingCall
    const request = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connector request timeout')), 2_000)
      const connectorRequest = messages.find((message) => message.type === 'connector_request')
      if (connectorRequest !== undefined) {
        clearTimeout(timer)
        resolve(connectorRequest)
        return
      }
      const original = host.send
      host.send = (message) => {
        original(message)
        if (message.type === 'connector_request') {
          clearTimeout(timer)
          resolve(message)
        }
      }
      pendingCall = fetch(`${harnessOptions.mcpConnector.url}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harnessOptions.mcpConnector.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'office_get_context',
            arguments: {},
          },
        }),
      })
    })
    assert.equal(request.runId, started.payload.runId)
    assert.equal(request.browserTarget.tabId, 2)
    await host.handle({
      type: 'connector_response',
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      browserTarget: request.browserTarget,
      result: {
        status: 'browser_target_verified',
        pageIdentity: { title: 'Native.xlsx', url: target.url },
        documentIdentity: null,
      },
    })
    const response = await pendingCall
    const body = await response.json()
    assert.equal(body.result.structuredContent.officeContext.pageIdentity.title, 'Native.xlsx')
  } finally {
    await host.close('stop requested')
  }
  assert.equal(stopped, 1)
})

test('moves a running Run only through an explicit transfer-browser-target message', async () => {
  let harnessOptions
  const host = new NativeHost({
    processFactory: (options) => {
      harnessOptions = options
      return { start: async () => 'http://127.0.0.1:48125', stop: async () => {} }
    },
    exit: () => {},
  })
  const messages = []
  host.send = (message) => messages.push(message)
  const first = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://docs.example.test/first' }
  const second = { browser: 'chrome', windowId: 1, tabId: 3, url: 'https://docs.example.test/second' }

  try {
    await host.handle({ type: 'start', browserTarget: first })
    const runId = messages.find((message) => message.type === 'server_started').payload.runId
    await host.handle({ type: 'transfer-browser-target', requestId: 'transfer-existing', runId, browserTarget: second })
    assert.deepEqual(messages.at(-1), {
      type: 'browser_target_transferred', requestId: 'transfer-existing',
      payload: { runId, browserTarget: second },
    })

    let request
    const pendingCall = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connector request timeout')), 2_000)
      const original = host.send
      host.send = (message) => {
        original(message)
        if (message.type === 'connector_request') {
          request = message
          clearTimeout(timer)
          resolve()
        }
      }
    })
    const fetchCall = fetch(harnessOptions.mcpConnector.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${harnessOptions.mcpConnector.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'office_get_context', arguments: {} } }),
    })
    await pendingCall
    assert.deepEqual(request.browserTarget, second)
    await host.handle({
      type: 'connector_response', requestId: request.requestId, runId, generation: request.generation,
      browserTarget: second,
      result: { status: 'browser_target_verified', pageIdentity: { title: 'Second', url: second.url }, documentIdentity: null },
    })
    assert.equal((await fetchCall).status, 200)
  } finally {
    await host.close('stop requested')
  }
})

test('correlates transfer ACK and rejects a wrong Run id with an immediate transfer NACK', async () => {
  const host = new NativeHost({
    processFactory: () => ({ start: async () => 'http://127.0.0.1:48126', stop: async () => {} }),
    exit: () => {},
  })
  const messages = []
  host.send = (message) => messages.push(message)
  const first = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://docs.example.test/first' }
  const second = { browser: 'chrome', windowId: 1, tabId: 3, url: 'https://docs.example.test/second' }
  try {
    await host.handle({ type: 'start', browserTarget: first })
    const runId = messages.find((message) => message.type === 'server_started').payload.runId
    await host.handle({ type: 'transfer-browser-target', requestId: 'transfer-ok', runId, browserTarget: second })
    assert.deepEqual(messages.at(-1), {
      type: 'browser_target_transferred', requestId: 'transfer-ok',
      payload: { runId, browserTarget: second },
    })
    await host.handle({ type: 'transfer-browser-target', requestId: 'transfer-wrong-run', runId: 'other-run', browserTarget: first })
    assert.deepEqual(messages.at(-1), {
      type: 'browser_target_transfer_failed', requestId: 'transfer-wrong-run',
      error: 'Browser Target transfer does not match the active Harness Run.',
    })
  } finally {
    await host.close('stop requested')
  }
})
