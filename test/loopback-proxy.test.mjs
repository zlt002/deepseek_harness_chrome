import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { LoopbackProxy } from '../native-server/src/loopback-proxy.mjs'

test('rejects an upstream outside the local Harness server', () => {
  assert.throws(
    () => new LoopbackProxy('https://example.com/'),
    /127\.0\.0\.1 loopback URL with a port/,
  )
})

test('proxies Harness API requests while removing the extension origin', async () => {
  const seen = {}
  const upstream = createServer((request, response) => {
    seen.origin = request.headers.origin
    seen.host = request.headers.host
    if (request.url !== '/api/session.list') {
      response.writeHead(404)
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.notEqual(typeof address, 'string')
  const upstreamUrl = `http://127.0.0.1:${String(address.port)}`
  const proxy = new LoopbackProxy(upstreamUrl)
  const proxyUrl = await proxy.start()
  try {
    const response = await fetch(`${proxyUrl}/api/session.list`, {
      headers: { origin: 'chrome-extension://test-extension' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(seen.origin, undefined)
    assert.match(seen.host, /^127\.0\.0\.1:\d+$/)
  } finally {
    await proxy.stop()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('rejects absolute-form requests instead of forwarding their authority', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.notEqual(typeof address, 'string')
  const proxy = new LoopbackProxy(`http://127.0.0.1:${String(address.port)}`)
  const proxyUrl = await proxy.start()
  const proxyAddress = new URL(proxyUrl)
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyAddress.port), proxyAddress.hostname)
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { data += chunk })
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
    socket.on('connect', () => {
      socket.write([
        `GET http://127.0.0.1:${String(address.port)}/api/session.list HTTP/1.1`,
        `Host: ${proxyAddress.host}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'))
    })
  })
  try {
    assert.match(response, /^HTTP\/1\.1 400 Bad Request/m)
    assert.equal(upstreamRequests, 0)
  } finally {
    await proxy.stop()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('proxies the Harness client HMR event stream', async () => {
  const upstream = createServer((request, response) => {
    if (request.url !== '/plugins/events') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    response.end(': connected\n\ndata: {"type":"graph"}\n\n')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.notEqual(typeof address, 'string')
  const proxy = new LoopbackProxy(`http://127.0.0.1:${String(address.port)}`)
  const proxyUrl = await proxy.start()
  try {
    const response = await fetch(`${proxyUrl}/plugins/events`, {
      headers: { origin: 'chrome-extension://test-extension' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(await response.text(), ': connected\n\ndata: {"type":"graph"}\n\n')
  } finally {
    await proxy.stop()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('proxies event WebSocket upgrades without extension trust markers', async () => {
  const seen = {}
  const upstream = createServer()
  upstream.on('upgrade', (request, socket) => {
    seen.origin = request.headers.origin
    seen.fetchSite = request.headers['sec-fetch-site']
    seen.connection = request.headers.connection
    socket.end([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      '',
      '',
    ].join('\r\n'))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.notEqual(typeof address, 'string')
  const proxy = new LoopbackProxy(`http://127.0.0.1:${String(address.port)}`)
  const proxyUrl = await proxy.start()
  const proxyAddress = new URL(proxyUrl)
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyAddress.port), proxyAddress.hostname)
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { data += chunk })
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
    socket.on('connect', () => {
      socket.write([
        'GET /api/events.mux HTTP/1.1',
        `Host: ${proxyAddress.host}`,
        'Origin: chrome-extension://test-extension',
        'Sec-Fetch-Site: cross-site',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGVzdC1rZXk=',
        '',
        '',
      ].join('\r\n'))
    })
  })
  try {
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/m)
    assert.equal(seen.origin, undefined)
    assert.equal(seen.fetchSite, undefined)
    assert.equal(seen.connection, 'Upgrade')
  } finally {
    await proxy.stop()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('stops while an event WebSocket is still connected', async () => {
  const upstream = createServer()
  let upstreamSocket
  upstream.on('upgrade', (_request, socket) => {
    upstreamSocket = socket
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.notEqual(typeof address, 'string')
  const proxy = new LoopbackProxy(`http://127.0.0.1:${String(address.port)}`)
  const proxyUrl = await proxy.start()
  const proxyAddress = new URL(proxyUrl)
  const client = net.connect(Number(proxyAddress.port), proxyAddress.hostname)
  client.write([
    'GET /api/events.mux HTTP/1.1',
    `Host: ${proxyAddress.host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGVzdC1rZXk=',
    '',
    '',
  ].join('\r\n'))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream upgrade timeout')), 2_000)
    const check = () => {
      if (upstreamSocket !== undefined) {
        clearTimeout(timer)
        resolve()
        return
      }
      setTimeout(check, 5)
    }
    check()
  })
  try {
    await Promise.race([
      proxy.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('proxy stop timeout')), 2_000)),
    ])
  } finally {
    client.destroy()
    upstreamSocket?.destroy()
    await new Promise((resolve) => upstream.close(resolve))
  }
})
