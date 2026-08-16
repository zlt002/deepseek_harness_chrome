/**
 * Product-owned MCP bridge for tools that are intentionally private to a
 * continuable child. It uses only Cordis's public services: `ctx.tools` and
 * `ctx.subagents.registerContinuableSetup()`.
 */
import { createHash } from 'node:crypto'

export const name = 'harness-runtime-mcp-scopes'
export const inject = ['tools', 'subagents']

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const DEFAULT_TIMEOUT_MS = 60_000

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
 * The trusted Native Connector uses a deliberately narrow MCP transport:
 * authenticated JSON-RPC POST with JSON responses and no server sessions.
 */
function createConnectorRpc(config) {
  let nextId = 1
  const post = async (message, callerSignal, expectsResponse = true) => {
    const timeoutSignal = AbortSignal.timeout(config.toolCallTimeoutMs)
    const signal = callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal])
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...config.headers },
      body: JSON.stringify(message),
      signal,
    })
    if (!response.ok) throw new Error(`Browser Connector HTTP ${response.status}`)
    if (!expectsResponse) return undefined
    const envelope = await response.json()
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
  const rpc = createConnectorRpc(config)
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
    if (config.failOnStartupError) throw error
    ctx.logger.error(`MCP startup failed: ${String(error)}`)
  }
  ctx.effect(() => () => {
    stopped = true
    stopContinuableSetup()
    for (const disposers of childDisposers.values()) for (const dispose of disposers.values()) dispose()
    childDisposers.clear()
    for (const dispose of globalDisposers.values()) dispose()
  }, 'harness-runtime-mcp-scopes.connection')
}
