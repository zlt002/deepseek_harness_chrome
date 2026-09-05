import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

export const KNOWLEDGE_PROXY_PATH = '/knowledge-proxy'

const KNOWLEDGE_API_ORIGIN = 'https://anapi-uat.annto.com'
const KNOWLEDGE_API_PREFIX = '/api-sse-kd'
const KNOWLEDGE_MAX_COOKIE_HEADER_LENGTH = 64_000
const KNOWLEDGE_ALLOWED_GET_PATHS = new Set(['/api/auth/me', '/api/tags/controlled-vocabulary', '/api/domains', '/api/domains/systems', '/api/repos'])
const KNOWLEDGE_ALLOWED_POST_PATHS = new Set(['/api/rag/retrieval', '/api/rag/repo-search'])
const KNOWLEDGE_TRANSPORT_RETRY_LIMIT = 2
const KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS = 250
const RETRYABLE_KNOWLEDGE_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

/** Render a thrown value with its cause chain so undici's `fetch failed` stays diagnostic. */
export function knowledgeErrorChain(value) {
  const path = new Set()
  const render = (current) => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const message = typeof current.message === 'string' ? current.message : undefined
          const code = typeof current.code === 'string' ? current.code : undefined
          if (message && code && !message.includes(code)) return `${message}: ${code}`
          if (message) return message
          if (code) return code
          try { return JSON.stringify(current) } catch { return Object.prototype.toString.call(current) }
        }
        return String(current)
      }
      const code = typeof current.code === 'string' ? current.code : undefined
      let text = current.message || current.name
      if (code && !text.includes(code)) text = `${text}: ${code}`
      if (current.cause !== undefined) {
        const cause = render(current.cause)
        if (cause && cause !== text && !text.includes(cause)) text = `${text}: ${cause}`
      }
      return text
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

function knowledgeTransportCode(value) {
  let current = value
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === 'object' && typeof current.code === 'string' && current.code.length > 0) return current.code
    current = typeof current === 'object' && current !== null ? current.cause : undefined
  }
  return undefined
}

export function isRetryableKnowledgeTransport(error) {
  const code = knowledgeTransportCode(error)
  if (code !== undefined && RETRYABLE_KNOWLEDGE_TRANSPORT_CODES.has(code)) return true
  return /fetch failed|socket hang up|network error|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|other side closed/i.test(knowledgeErrorChain(error))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validKnowledgeProxyRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.method !== 'GET' && value.method !== 'POST') return false
  if (typeof value.path !== 'string' || typeof value.cookie !== 'string' || value.cookie.length > KNOWLEDGE_MAX_COOKIE_HEADER_LENGTH || /[\r\n]/.test(value.cookie)) return false
  if (value.body !== undefined && (typeof value.body !== 'string' || value.body.length > 1_000_000)) return false
  if (value.headers !== undefined && (!Array.isArray(value.headers) || !value.headers.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((item) => typeof item === 'string')))) return false
  let target
  try { target = new URL(value.path, KNOWLEDGE_API_ORIGIN) } catch { return false }
  if (target.origin !== KNOWLEDGE_API_ORIGIN || !target.pathname.startsWith(`${KNOWLEDGE_API_PREFIX}/`)) return false
  const relative = target.pathname.slice(KNOWLEDGE_API_PREFIX.length)
  return value.method === 'GET' ? KNOWLEDGE_ALLOWED_GET_PATHS.has(relative) : KNOWLEDGE_ALLOWED_POST_PATHS.has(relative)
}

function knowledgeProxyHeaders(entries, cookie) {
  const allowed = new Set(['accept', 'content-type'])
  const headers = new Headers((entries ?? []).filter(([name]) => allowed.has(name.toLowerCase())))
  headers.set('cookie', cookie)
  headers.set('origin', 'https://wb-uat.annto.com')
  headers.set('referer', 'https://wb-uat.annto.com/')
  headers.set('cache-control', 'no-cache')
  return headers
}

async function readKnowledgeProxyJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Node fetch uses undici's 300s bodyTimeout. Repo-search SSE stays quiet
 * while Explore agents run, so we stream with https.request instead. */
export function knowledgeHttpsFetch(input, init = {}, timeouts = {}) {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input))
  const headers = new Headers(init.headers)
  const connectTimeout = timeouts.connectTimeout ?? 30_000
  const headersTimeout = timeouts.headersTimeout ?? 0
  const bodyTimeout = timeouts.bodyTimeout ?? 0
  const transport = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (error) => {
      request.destroy(error)
      if (settled) return
      settled = true
      reject(error)
    }
    const request = transport({
      protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', headers: Object.fromEntries(headers),
    }, (incoming) => {
      if (headerTimer !== undefined) clearTimeout(headerTimer)
      settled = true
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode ?? 502, statusText: incoming.statusMessage ?? '', headers: incoming.headers }))
    })
    if (bodyTimeout > 0) request.setTimeout(bodyTimeout, () => abort(Object.assign(new Error('body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' })))
    const headerTimer = headersTimeout > 0 ? setTimeout(() => abort(Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' })), headersTimeout) : undefined
    const connectTimer = setTimeout(() => abort(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), connectTimeout)
    request.once('socket', (socket) => socket.once('connect', () => clearTimeout(connectTimer)))
    request.once('error', (error) => {
      clearTimeout(connectTimer)
      if (headerTimer !== undefined) clearTimeout(headerTimer)
      if (!settled) { settled = true; reject(error) }
    })
    if (init.signal !== undefined) {
      if (init.signal.aborted) { abort(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted')); return }
      init.signal.addEventListener('abort', () => abort(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted')), { once: true })
    }
    if (typeof init.body === 'string') request.end(init.body)
    else request.end()
  })
}

/**
 * Handle the authenticated browser-owned Knowledge Connector proxy. The
 * caller supplies only the upstream fetch adapter and the two timeout policy
 * values; validation, credentials, retry, cancellation, and streaming stay
 * local to this module.
 */
export async function proxyKnowledgeRequest({ request, response, fetchImpl, catalogTimeoutMs, requestTimeoutMs }) {
  let message
  try { message = await readKnowledgeProxyJson(request) } catch {
    response.writeHead(400); response.end('invalid knowledge proxy request'); return
  }
  if (!validKnowledgeProxyRequest(message)) {
    response.writeHead(400); response.end('invalid knowledge proxy request'); return
  }
  const controller = new AbortController()
  const abortUpstream = () => controller.abort()
  request.once('aborted', abortUpstream)
  response.once('close', abortUpstream)
  const timeout = setTimeout(() => controller.abort(), message.method === 'GET' ? catalogTimeoutMs : requestTimeoutMs)
  try {
    const target = new URL(message.path, `${KNOWLEDGE_API_ORIGIN}${KNOWLEDGE_API_PREFIX}/`)
    const init = { method: message.method, headers: knowledgeProxyHeaders(message.headers, message.cookie), redirect: 'follow', signal: controller.signal, ...(message.method === 'POST' ? { body: message.body ?? '' } : {}) }
    let lastError
    let upstream
    for (let attempt = 0; attempt <= KNOWLEDGE_TRANSPORT_RETRY_LIMIT; attempt += 1) {
      try { upstream = await fetchImpl(target, init); lastError = undefined; break } catch (error) {
        lastError = error
        if (controller.signal.aborted || !isRetryableKnowledgeTransport(error) || attempt === KNOWLEDGE_TRANSPORT_RETRY_LIMIT) throw error
        await delay(KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS * (attempt + 1))
      }
    }
    if (upstream === undefined) throw lastError ?? new Error('knowledge_proxy_unreachable')
    // Undici already decodes the body; forwarding content-encoding would make Chrome decode it twice.
    const responseHeaders = Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())))
    responseHeaders['x-knowledge-final-url'] = upstream.url
    responseHeaders['x-knowledge-redirected'] = String(upstream.redirected)
    response.writeHead(upstream.status, responseHeaders)
    if (upstream.body === null) { response.end(); return }
    for await (const chunk of upstream.body) if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve))
    response.end()
  } catch (error) {
    if (controller.signal.aborted && (request.aborted || response.destroyed)) return
    if (!response.headersSent) response.writeHead(502)
    if (!response.destroyed) response.end(`Knowledge proxy failed: ${knowledgeErrorChain(error)}`)
  } finally {
    clearTimeout(timeout)
    request.off('aborted', abortUpstream)
    response.off('close', abortUpstream)
  }
}
