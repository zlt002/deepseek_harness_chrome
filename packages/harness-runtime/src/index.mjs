/**
 * Product-owned MCP bridge for tools that are intentionally private to a
 * continuable child. It uses only Cordis's public services: `ctx.tools` and
 * `ctx.subagents.registerContinuableSetup()`.
 */
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'

export const name = 'harness-runtime-mcp-scopes'
export const inject = ['tools', 'subagents']

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const DEFAULT_TIMEOUT_MS = 60_000
const SELECTED_SOURCE_SCOPE = 'mcp__chrome__selected_source_scope'
const SELECTED_SOURCE_WRAPPERS = new Set(['search_selected_remote_code', 'search_selected_knowledge'])
const GENERIC_SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork'])

function activeParentTurn(agent) {
  if (agent === undefined || !Array.isArray(agent.session?.events)) return undefined
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'turn/end') return undefined
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) return event.data.turn
  }
  return undefined
}

const MAX_SELECTED_SOURCE_SEARCHES_PER_TURN = 1

/**
 * Admit one selected-source child per parent turn.
 * A guard is a product-owned, lifecycle-aware enforcement seam: unlike prompt
 * text, it rejects a second wrapper call after a child is published. The parent must
 * settle the first result before a later turn decides whether an independent
 * evidence gap warrants another child. Generic subagents stay blocked after
 * scope discovery.
 */
export function createSelectedSourceDispatchGuard() {
  const states = new Map()
  const stateFor = (exec) => {
    const parentId = exec.agent === undefined ? undefined : String(exec.agent.id)
    const turn = activeParentTurn(exec.agent)
    if (parentId === undefined || turn === undefined) return undefined

    const previous = states.get(parentId)
    const state = previous?.turn === turn
      ? previous
      : { turn, selectedSourceScopeRead: false, childStarted: false, searchCount: 0, searchPending: false }
    states.set(parentId, state)
    return state
  }
  const guard = (exec) => {
    const state = stateFor(exec)
    if (state === undefined) return undefined

    if (exec.name === SELECTED_SOURCE_SCOPE) {
      state.selectedSourceScopeRead = true
      return undefined
    }
    if (GENERIC_SUBAGENT_TOOLS.has(exec.name) && (state.selectedSourceScopeRead || state.childStarted || state.searchPending)) {
      return '本次请求已读取所选远程范围；请直接调用对应的 selected-source 检索工具，不要再启动通用子代理。'
    }
    if (!SELECTED_SOURCE_WRAPPERS.has(exec.name)) return undefined
    if (state.searchCount >= MAX_SELECTED_SOURCE_SEARCHES_PER_TURN || state.searchPending) {
      return '本次父会话轮次已启动一个 selected-source 检索；请先等待该结果结算。只有结算后仍存在独立证据缺口时，才在后续父会话轮次追加一个聚焦检索。'
    }
    state.searchPending = true
    return undefined
  }
  guard.childStarted = (exec) => {
    const state = stateFor(exec)
    if (state === undefined || !state.searchPending) return
    state.searchPending = false
    state.searchCount += 1
    state.childStarted = true
  }
  guard.dispatchFailed = (exec) => {
    const state = stateFor(exec)
    if (state !== undefined) state.searchPending = false
  }
  return guard
}

/**
 * Reserve a wrapper call before dispatch, then commit it only when the
 * parent-scoped lifecycle publishes a child. A tool error before publication
 * clears the reservation so the model can retry in the same parent turn.
 */
export function installSelectedSourceDispatchTracking(ctx, guard) {
  return ctx.on('tools/execute', async (exec, next) => {
    if (!SELECTED_SOURCE_WRAPPERS.has(exec.name) || exec.agent === undefined) return next()
    let childStarted = false
    const stop = exec.agent.ctx.on('subagent/start', () => {
      childStarted = true
      guard.childStarted(exec)
    })
    try {
      return await next()
    } finally {
      stop()
      if (!childStarted) guard.dispatchFailed(exec)
    }
  })
}

/** The model-visible name is stable even if an MCP server uses punctuation. */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Attach trusted Harness lineage without exposing it to the model. */
export function sessionMeta(exec, enabled) {
  if (!enabled || exec?.agent === undefined) return undefined
  const parentSession = exec.agent.session?.header?.parentSession
  return {
    'io.deepseek.harness/sessionId': String(exec.agent.id),
    ...(parentSession === undefined ? {} : { 'io.deepseek.harness/parentSessionId': String(parentSession) }),
  }
}

function textFromMcp(result, rawName) {
  if (!Array.isArray(result.content)) return typeof result.toolResult === 'undefined' ? `(${rawName} returned no text content)` : JSON.stringify(result.toolResult)
  const parts = result.content.map((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return '[unsupported content type: unknown]'
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (block.type === 'image') return '[image: content discarded]'
    if (block.type === 'audio') return '[audio: content discarded]'
    if (block.type === 'resource' || block.type === 'resource_link') return '[resource: content discarded]'
    return '[unsupported content type]'
  }).filter(Boolean)
  return parts.join('\n') || `(${rawName} returned no text content)`
}

function outputDefinition(rawName) {
  return {
    schema: {
      type: 'object', additionalProperties: false, required: ['content'],
      properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    },
    render(_args, value) { return [{ type: 'text', text: textFromMcp(value, rawName) }] },
  }
}

function toolDefinition(rpc, tool, config) {
  const rawName = tool.name
  return {
    rawName,
    definition: {
      name: publicToolName(config.serverName, rawName),
      description: tool.description ?? '',
      parameters: tool.inputSchema,
      output: outputDefinition(rawName),
      async execute(args, exec) {
        if (tool.execution?.taskSupport === 'required') throw new Error(`Tool "${rawName}" requires task-based execution`)
        const argumentsObject = typeof args === 'object' && args !== null ? args : {}
        const meta = sessionMeta(exec, config.forwardSessionIdentity)
        const result = await rpc.request('tools/call', {
          name: rawName,
          arguments: argumentsObject,
          ...(meta === undefined ? {} : { _meta: meta }),
        }, exec.signal)
        if (result.isError === true) throw new Error(textFromMcp(result, rawName))
        return {
          content: Array.isArray(result.content) ? result.content : [{ type: 'text', text: textFromMcp(result, rawName) }],
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        }
      },
    },
  }
}

/** Keep raw-name policy separate from MCP discovery for direct unit testing. */
export function partitionTools(definitions, toolScopes, defaultScope = 'global') {
  const global = new Map()
  const continuableChild = new Map()
  for (const [publicName, item] of definitions) {
    const scope = toolScopes[item.rawName] ?? toolScopes.default ?? defaultScope
    if (scope !== 'global' && scope !== 'continuable-child') throw new Error(`tool scope for "${item.rawName}" is invalid`)
    ;(scope === 'global' ? global : continuableChild).set(publicName, item)
  }
  return { global, continuableChild }
}

function replaceTools(ctx, definitions, previous) {
  for (const dispose of previous.values()) dispose()
  const next = new Map()
  try {
    for (const [publicName, item] of definitions) next.set(publicName, ctx.tools.register(item.definition))
  } catch (error) {
    for (const dispose of next.values()) dispose()
    throw error
  }
  return next
}

async function discover(rpc, config) {
  const definitions = new Map()
  let cursor
  do {
    const response = await rpc.request('tools/list', cursor === undefined ? {} : { cursor })
    if (!Array.isArray(response?.tools)) throw new Error('Browser Connector returned an invalid tools/list result')
    for (const tool of response.tools) {
      if (typeof tool?.name !== 'string' || tool.name.length === 0) throw new Error('Browser Connector returned a tool without a name')
      const item = toolDefinition(rpc, tool, config)
      const publicName = item.definition.name
      if (definitions.has(publicName)) throw new Error(`MCP server listed duplicate tool "${tool.name}"`)
      definitions.set(publicName, item)
    }
    cursor = response.nextCursor
  } while (cursor !== undefined)
  return definitions
}

/**
 * Node fetch (undici) defaults headersTimeout to 300s. A knowledge tools/call
 * can stay quiet that long before the Connector writes the JSON-RPC body, so
 * the child MCP client must not use the default dispatcher.
 */
export function connectorHttpFetch(input, init = {}) {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input))
  const headers = new Headers(init.headers)
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (error) => {
      request.destroy(error)
      if (settled) return
      settled = true
      reject(error)
    }
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers),
    }, (incoming) => {
      settled = true
      resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode ?? 502,
        statusText: incoming.statusMessage ?? '',
        headers: incoming.headers,
      }))
    })
    request.once('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    if (init.signal !== undefined) {
      if (init.signal.aborted) {
        abort(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted'))
        return
      }
      init.signal.addEventListener('abort', () => abort(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted')), { once: true })
    }
    if (typeof init.body === 'string') request.end(init.body)
    else request.end()
  })
}

function connectorFetchError(error) {
  const parts = []
  const seen = new Set()
  let current = error
  for (let depth = 0; depth < 6 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current)
    if (current instanceof Error) {
      const code = typeof current.code === 'string' ? current.code : undefined
      let text = current.message || current.name
      if (code && !text.includes(code)) text = `${text}: ${code}`
      if (text && !parts.includes(text)) parts.push(text)
      current = current.cause
      continue
    }
    const text = typeof current === 'object' && typeof current.code === 'string' ? current.code : String(current)
    if (text && !parts.includes(text)) parts.push(text)
    break
  }
  return new Error(`Browser Connector request failed: ${parts.join(': ') || 'unknown transport error'}`, { cause: error instanceof Error ? error : undefined })
}

/**
 * The trusted Native Connector uses a deliberately narrow MCP transport:
 * authenticated JSON-RPC POST with JSON responses and no server sessions.
 */
function createConnectorRpc(config, fetchImpl = connectorHttpFetch) {
  let nextId = 1
  const post = async (message, callerSignal, expectsResponse = true) => {
    const timeoutSignal = AbortSignal.timeout(config.toolCallTimeoutMs)
    const signal = callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal])
    let response
    try {
      response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...config.headers },
        body: JSON.stringify(message),
        signal,
      })
    } catch (error) {
      throw connectorFetchError(error)
    }
    if (!response.ok) throw new Error(`Browser Connector HTTP ${response.status}`)
    if (!expectsResponse) return undefined
    const envelope = JSON.parse(await response.text())
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Browser Connector returned an invalid JSON-RPC envelope')
    if (envelope.error !== undefined) throw new Error(envelope.error?.message ?? 'Browser Connector JSON-RPC error')
    return envelope.result
  }
  return {
    request(method, params, signal) {
      return post({ jsonrpc: '2.0', id: nextId++, method, params }, signal)
    },
    async initialize() {
      await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'accrui-harness-runtime', version: '0.1.0' },
      })
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, undefined, false)
    },
  }
}

function normalizeConfig(input = {}) {
  const config = {
    serverName: input.serverName,
    url: input.url,
    headers: input.headers ?? {},
    toolScopes: input.toolScopes ?? {},
    toolScope: input.toolScope ?? 'global',
    forwardSessionIdentity: input.forwardSessionIdentity === true,
    toolCallTimeoutMs: input.toolCallTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    failOnStartupError: input.failOnStartupError === true,
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName ?? '')) throw new Error('serverName must contain 1-32 letters, digits, _ or -')
  if (typeof config.url !== 'string' || config.url.length === 0) throw new Error('url is required')
  new URL(config.url)
  if (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0) throw new Error('toolCallTimeoutMs must be positive')
  if (config.toolScope !== 'global' && config.toolScope !== 'continuable-child') throw new Error('toolScope must be global or continuable-child')
  for (const [rawName, scope] of Object.entries(config.toolScopes)) {
    if (rawName.length === 0 || (scope !== 'global' && scope !== 'continuable-child')) throw new Error(`invalid toolScopes entry "${rawName}"`)
  }
  return config
}

/**
 * Connect, expose global MCP tools on the root, and attach private MCP tools
 * through the public continuable-child setup seam before child publication.
 */
export async function apply(ctx, input = {}) {
  const config = normalizeConfig(input)
  const rpc = createConnectorRpc(config, input.fetch ?? connectorHttpFetch)
  const selectedSourceDispatchGuard = createSelectedSourceDispatchGuard()
  const stopSelectedSourceDispatchGuard = ctx.tools.guard(selectedSourceDispatchGuard)
  const stopSelectedSourceDispatchTracking = installSelectedSourceDispatchTracking(ctx, selectedSourceDispatchGuard)
  const childDisposers = new Map()
  let globalDisposers = new Map()
  let definitions = new Map()
  let stopped = false

  const installChild = (childCtx) => {
    const privateTools = partitionTools(definitions, config.toolScopes, config.toolScope).continuableChild
    const disposers = replaceTools(childCtx, privateTools, new Map())
    childDisposers.set(childCtx, disposers)
    return () => {
      const owned = childDisposers.get(childCtx)
      if (owned === undefined) return
      for (const dispose of owned.values()) dispose()
      childDisposers.delete(childCtx)
    }
  }
  const stopContinuableSetup = ctx.subagents.registerContinuableSetup(installChild)
  const sync = async () => {
    const next = await discover(rpc, config)
    if (stopped) return
    definitions = next
    const partitioned = partitionTools(next, config.toolScopes, config.toolScope)
    globalDisposers = replaceTools(ctx, partitioned.global, globalDisposers)
    for (const [childCtx, previous] of childDisposers) childDisposers.set(childCtx, replaceTools(childCtx, partitioned.continuableChild, previous))
  }
  try {
    await rpc.initialize()
    await sync()
  } catch (error) {
    stopContinuableSetup()
    stopSelectedSourceDispatchGuard()
    stopSelectedSourceDispatchTracking()
    if (config.failOnStartupError) throw error
    ctx.logger.error(`MCP startup failed: ${String(error)}`)
  }
  ctx.effect(() => () => {
    stopped = true
    stopContinuableSetup()
    stopSelectedSourceDispatchGuard()
    stopSelectedSourceDispatchTracking()
    for (const disposers of childDisposers.values()) for (const dispose of disposers.values()) dispose()
    childDisposers.clear()
    for (const dispose of globalDisposers.values()) dispose()
  }, 'harness-runtime-mcp-scopes.connection')
}
