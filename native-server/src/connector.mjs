import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const REQUEST_TIMEOUT_MS = 15_000
const MCP_PATH = '/mcp'

const officeGetContextTool = {
  name: 'office_get_context',
  title: 'Get Office context',
  description: 'Read the current Office context from the Browser Target bound to a Harness Run.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['runId', 'browserTarget'],
    properties: {
      runId: { type: 'string', minLength: 1 },
      browserTarget: {
        type: 'object',
        additionalProperties: false,
        required: ['browser', 'windowId', 'tabId', 'url'],
        properties: {
          browser: { const: 'chrome' },
          windowId: { type: 'integer', minimum: 0 },
          tabId: { type: 'integer', minimum: 0 },
          url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function validBrowserTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value
  return target.browser === 'chrome'
    && Number.isInteger(target.windowId) && target.windowId >= 0
    && Number.isInteger(target.tabId) && target.tabId >= 0
    && typeof target.url === 'string' && target.url.length > 0
}

function validOfficeGetContextArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof value.runId === 'string' && value.runId.length > 0 && validBrowserTarget(value.browserTarget)
}

function sameIdentity(request, response) {
  return response.requestId === request.requestId
    && response.runId === request.runId
    && response.generation === request.generation
    && JSON.stringify(response.browserTarget) === JSON.stringify(request.browserTarget)
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON-RPC request')
  }
}

/**
 * Stateless, authenticated MCP endpoint managed by the Native Host. It is
 * deliberately the narrow Issue #2 tracer-bullet: only office_get_context
 * crosses into Native Messaging.
 */
export class BrowserConnector {
  /** @param {{ requestExtension: (request: object) => void, requestTimeoutMs?: number }} options */
  constructor(options) {
    this.requestExtension = options.requestExtension
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.server = undefined
    this.url = undefined
    this.token = undefined
    this.generation = undefined
    this.pending = new Map()
  }

  /** @returns {Promise<{ url: string, token: string, generation: string }>} */
  start() {
    if (this.url && this.token && this.generation) {
      return Promise.resolve({ url: this.url, token: this.token, generation: this.generation })
    }
    this.token = randomBytes(32).toString('base64url')
    this.generation = randomUUID()
    this.server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Connector did not expose a TCP address'))
          return
        }
        this.url = `http://127.0.0.1:${String(address.port)}`
        resolve({ url: this.url, token: this.token, generation: this.generation })
      })
    })
  }

  /** @returns {Promise<void>} */
  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Browser Connector stopped'))
    }
    this.pending.clear()
    const server = this.server
    this.server = undefined
    this.url = undefined
    this.token = undefined
    this.generation = undefined
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** Accept one correlated response received from the Extension peer. */
  acceptExtensionResponse(response) {
    if (!response || typeof response !== 'object' || response.type !== 'connector_response'
      || typeof response.requestId !== 'string') return false
    const pending = this.pending.get(response.requestId)
    if (!pending || !sameIdentity(pending.request, response)) return false
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    if (!Object.hasOwn(response, 'result')) {
      pending.reject(new Error('Extension peer returned no Office context'))
      return true
    }
    pending.resolve(response.result)
    return true
  }

  async #handle(request, response) {
    if (request.url !== MCP_PATH) {
      response.writeHead(404)
      response.end()
      return
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }

    let message
    try {
      message = await readJson(request)
    } catch (error) {
      this.#reply(response, errorResponse(null, -32700, error.message))
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      this.#reply(response, errorResponse(message?.id, -32600, 'invalid JSON-RPC request'))
      return
    }

    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    if (message.method === 'initialize') {
      this.#reply(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'deepseek-harness-browser-connector', version: '0.1.0' },
        },
      })
      return
    }
    if (message.method === 'tools/list') {
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: [officeGetContextTool] } })
      return
    }
    if (message.method !== 'tools/call') {
      this.#reply(response, errorResponse(message.id, -32601, 'method not found'))
      return
    }
    if (message.params?.name !== 'office_get_context' || !validOfficeGetContextArguments(message.params.arguments)) {
      this.#reply(response, errorResponse(message.id, -32602, 'office_get_context requires a Run and Browser Target'))
      return
    }

    const requestId = randomUUID()
    const correlation = {
      type: 'connector_request',
      requestId,
      runId: message.params.arguments.runId,
      generation: this.generation,
      browserTarget: message.params.arguments.browserTarget,
      tool: 'office_get_context',
    }
    try {
      const officeContext = await this.#requestExtension(correlation)
      const structuredContent = {
        runId: correlation.runId,
        requestId: correlation.requestId,
        generation: correlation.generation,
        browserTarget: correlation.browserTarget,
        officeContext,
      }
      this.#reply(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent,
        },
      })
    } catch (error) {
      this.#reply(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'Browser Connector request failed' }],
          isError: true,
        },
      })
    }
  }

  #requestExtension(correlation) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(correlation.requestId)
        reject(new Error('Browser Connector timed out waiting for the Extension peer'))
      }, this.requestTimeoutMs)
      this.pending.set(correlation.requestId, { request: correlation, resolve, reject, timeout })
      try {
        this.requestExtension(correlation)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(correlation.requestId)
        reject(error)
      }
    })
  }

  #reply(response, body) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}
