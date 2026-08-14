import { createServer } from 'node:http'
import net from 'node:net'

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function parseLoopbackUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('Harness Web URL must be an http 127.0.0.1 loopback URL with a port')
  }
  return url
}

function isProxyPath(pathname) {
  return pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/plugins/events'
}

function headerEntries(headers) {
  return Object.entries(headers)
    .filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()))
    .filter(([name]) => !['host', 'origin', 'sec-fetch-site', 'content-length'].includes(name.toLowerCase()))
    .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')])
}

function upgradeHeaderEntries(headers) {
  return Object.entries(headers)
    .filter(([name]) => !['host', 'origin', 'sec-fetch-site'].includes(name.toLowerCase()))
    .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')])
}

function responseHeaders(response) {
  return Object.fromEntries([...response.headers].filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())))
}

function requestPath(value) {
  const parsed = new URL(value ?? '/', 'http://extension.invalid')
  if (parsed.origin !== 'http://extension.invalid') {
    throw new Error('proxy request target must be origin-form')
  }
  return `${parsed.pathname}${parsed.search}`
}

/**
 * Loopback proxy for extension-origin API calls. It is intentionally narrow:
 * only Harness `/api` HTTP requests and the two event WebSocket paths pass.
 * @param {string} upstreamUrl - Harness Web server URL.
 */
export class LoopbackProxy {
  constructor(upstreamUrl) {
    this.upstreamUrl = parseLoopbackUrl(upstreamUrl)
    this.server = undefined
    this.url = undefined
    this.sockets = new Set()
  }

  /** @returns {Promise<string>} */
  start() {
    if (this.url) return Promise.resolve(this.url)
    this.server = createServer((request, response) => {
      void this.#handleHttp(request, response)
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.#handleUpgrade(request, socket, head)
    })
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('loopback proxy did not expose a TCP address'))
          return
        }
        this.url = `http://127.0.0.1:${String(address.port)}`
        resolve(this.url)
      })
    })
  }

  /** @returns {Promise<void>} */
  async stop() {
    const server = this.server
    this.server = undefined
    this.url = undefined
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  async #handleHttp(request, response) {
    let target
    try {
      target = new URL(requestPath(request.url), this.upstreamUrl)
    } catch {
      response.writeHead(400)
      response.end('invalid upstream path')
      return
    }
    if (!isProxyPath(target.pathname)) {
      response.writeHead(404)
      response.end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    try {
      const method = request.method ?? 'GET'
      const upstream = await fetch(target, {
        method,
        headers: Object.fromEntries(headerEntries(request.headers)),
        ...method === 'GET' || method === 'HEAD' || body.length === 0 ? {} : { body, duplex: 'half' },
      })
      response.writeHead(upstream.status, responseHeaders(upstream))
      if (upstream.body === null) {
        response.end()
        return
      }
      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve))
      }
      response.end()
    } catch (error) {
      if (!response.headersSent) response.writeHead(502)
      response.end(`Harness proxy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #handleUpgrade(request, socket, head) {
    let target
    try {
      target = new URL(requestPath(request.url), this.upstreamUrl)
    } catch {
      socket.destroy()
      return
    }
    if (target.pathname !== '/api/events.mux' && target.pathname !== '/api/events.host') {
      socket.destroy()
      return
    }
    const upstream = net.connect({
      host: target.hostname,
      port: Number(target.port || 80),
    })
    let connected = false
    const closeBoth = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.once('connect', () => {
      connected = true
      const lines = [
        `${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        ...upgradeHeaderEntries(request.headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ]
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.once('error', (error) => {
      if (!connected) socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${error.message}`)
      else closeBoth()
    })
    socket.once('error', closeBoth)
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  }
}
