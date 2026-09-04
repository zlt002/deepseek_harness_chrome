/**
 * Product-owned MCP bridge for tools that are intentionally private to a
 * continuable child. It uses only Cordis's public services: `ctx.tools` and
 * `ctx.subagents.registerContinuableSetup()`.
 */
import { createHash, randomUUID } from 'node:crypto'
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
const SELECTED_SOURCE_PROGRESS_CLAIMS = [
  { toolName: 'search_selected_remote_code', pattern: /代码正在后台(?:查询|检索)|远程仓库正在(?:后台)?检索|我(?:先|正在|会)?在后台检索(?:这|已选)?(?:两个|这些)?代码库/ },
  { toolName: 'search_selected_knowledge', pattern: /知识库正在后台(?:查询|检索)|我(?:先|正在|会)?在后台检索(?:这|已选)?(?:个|些)?知识库/ },
]
const PROGRESS_GATE_SOURCE = Object.freeze({ kind: 'plugin', plugin: '@accrui/harness-runtime-mcp-scopes' })
const MAX_SELECTED_SOURCE_SEARCHES_PER_TURN = 3

function activeParentTurn(agent) {
  if (agent === undefined || !Array.isArray(agent.session?.events)) return undefined
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'turn/end') return undefined
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) return event.data.turn
  }
  return undefined
}

function userText(message) {
  if (message?.source?.kind !== 'user' || !Array.isArray(message.content)) return undefined
  const text = message.content
    .flatMap((block) => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
  return text.length === 0 ? undefined : text
}

function initialSelectedSourcePrompt(events) {
  let latestUser
  let latestPmdPrd
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const text = userText(event.data)
    if (text === undefined) continue
    const pmdPrd = /^\/pmd-prd(?:\s+([\s\S]*))?$/.exec(text)
    const pmdPrdText = pmdPrd?.[1]?.trim()
    const user = { index, text: pmdPrdText || text, pmdPrd: pmdPrdText !== undefined && pmdPrdText !== '' }
    if (pmdPrd !== null) latestPmdPrd = user
    latestUser = user
  }
  // Once the current /pmd-prd run has real selected-source evidence, later
  // user messages are process follow-ups and no longer need the first-search
  // verbatim guard. Before then, a bare continuation still belongs to the
  // original /pmd-prd request.
  if (latestPmdPrd !== undefined && hasSettledSelectedSourceEvidence(events, latestPmdPrd.index)) return latestPmdPrd
  const continuation = latestUser?.index > latestPmdPrd?.index
    && /^(?:继续|已选(?:了|好)?|已选择(?:了|好)?|选择好了)[。！!]?$/u.test(latestUser.text)
  if (latestPmdPrd !== undefined && (continuation || latestUser === latestPmdPrd)) return latestPmdPrd
  return latestUser
}

function hasSettledSelectedSourceEvidence(events, afterIndex) {
  let wrapperStarted = false
  const wrapperCalls = new Set()
  for (let index = afterIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && SELECTED_SOURCE_WRAPPERS.has(event.data?.name)) {
      wrapperStarted = true
      if (typeof event.data.callId === 'string' && event.data.callId !== '') wrapperCalls.add(event.data.callId)
      continue
    }
    if (wrapperStarted && event?.type === 'tool/result') {
      const message = event.data?.message
      const source = message?.source
      const callId = typeof source?.callId === 'string' ? source.callId : undefined
      const failed = Array.isArray(message?.content) && message.content.some(block => block?.isError === true)
      if (source?.kind === 'tool' && callId !== undefined && wrapperCalls.has(callId) && !failed) return true
    }
    if (!wrapperStarted || event?.type !== 'user/message' || event.data?.source?.kind !== 'subagent-settled') continue
    const summary = event.data.source.summary
    if (typeof summary !== 'string' || !summary.includes(' finished and will do no further work')) continue
    const text = Array.isArray(event.data.content)
      ? event.data.content.flatMap((block) => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
      : ''
    if (/Its closing message:\s*\S/.test(text)) return true
  }
  return false
}

function wrapperPrompt(arguments_) {
  if (arguments_ !== null && typeof arguments_ === 'object') return arguments_.prompt
  if (typeof arguments_ !== 'string') return undefined
  try {
    return JSON.parse(arguments_).prompt
  } catch {
    return undefined
  }
}

function focusedFollowupReason(exec, previousPrompt) {
  const prompt = wrapperPrompt(exec.arguments)
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt === previousPrompt) {
    return '上一次检索已结算，但本次 prompt 与上次相同或为空。只有明确的新证据缺口才能补查；请说明缺少或矛盾的返回内容，并提交聚焦后的 prompt。'
  }
  const description = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments.description : undefined
  if (typeof description !== 'string' || !/(?:证据缺口|缺失|缺少|矛盾|未返回|待核实|evidence gap|missing|conflict|incomplete|not returned|verify)/iu.test(description)) {
    return '上一次检索已结算。补查的 description 必须具体说明证据缺口（例如“初次结果缺少分页接口”或“两个结果的状态规则矛盾”），不能无理由重复检索。'
  }
  return undefined
}

function initialPromptGuardReason(exec) {
  const events = exec.agent?.session?.events
  if (!Array.isArray(events)) return undefined
  const initial = initialSelectedSourcePrompt(events)
  if (initial === undefined || hasSettledSelectedSourceEvidence(events, initial.index)) return undefined
  const prompt = exec.arguments !== null && typeof exec.arguments === 'object'
    ? exec.arguments.prompt
    : undefined
  if (initial.pmdPrd) {
    if (typeof prompt !== 'string' || prompt.trim() === initial.text) {
      return '这是 /pmd-prd 的首次检索，先基于用户需求整理检索 prompt，不能原样传递业务文本。prompt 必须覆盖“需求理解、现状或问题、相关功能与代码位置、影响范围”，且只使用用户已提供的信息。'
    }
    const requiredParts = [
      ['需求理解', /需求(?:理解|概述|目标|问题)/u],
      ['现状或问题', /(?:现状|问题)/u],
      ['相关功能', /(?:功能|页面|模块|流程|组件|接口)/u],
      ['代码位置', /(?:代码位置|文件位置|代码路径|实现位置|研发定位)/u],
      ['影响范围', /影响范围/u],
    ]
    const missing = requiredParts.filter(([, pattern]) => !pattern.test(prompt)).map(([label]) => label)
    if (missing.length === 0) return undefined
    return `这是 /pmd-prd 的首次检索，prompt 缺少：${missing.join('、')}。请先理解用户需求，再用面向资料检索的结构化 prompt 重试；不能原样传递业务文本。`
  }
  if (prompt === initial.text) return undefined
  return `这是首次检索，prompt 必须使用用户原始业务文本。请把 prompt 原样改为：${JSON.stringify(initial.text)} 后重试。`
}

/**
 * Admit serial selected-source children per parent turn.
 * A guard is a product-owned, lifecycle-aware enforcement seam: unlike prompt
 * text, it rejects an overlapping wrapper call and admits a settled, focused
 * follow-up only when its evidence gap is explicit. Generic subagents stay
 * blocked after scope discovery.
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
      : {
          turn,
          selectedSourceScopeRead: false,
          anyChildStarted: false,
          currentSearchStarted: false,
          searchCount: 0,
          searchPending: false,
          lastPrompt: undefined,
          pendingPrompt: undefined,
        }
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
    if (GENERIC_SUBAGENT_TOOLS.has(exec.name) && (state.selectedSourceScopeRead || state.anyChildStarted || state.searchPending)) {
      return '本次请求已读取所选远程范围；请直接调用对应的 selected-source 检索工具，不要再启动通用子代理。'
    }
    if (!SELECTED_SOURCE_WRAPPERS.has(exec.name)) return undefined
    if (state.searchPending) {
      return '本次父会话轮次已有 selected-source 检索尚未结算；请先等待结果返回，不能并发或排队发起下一次检索。'
    }
    if (state.searchCount >= MAX_SELECTED_SOURCE_SEARCHES_PER_TURN) {
      return `本次父会话轮次已完成 ${MAX_SELECTED_SOURCE_SEARCHES_PER_TURN} 次 selected-source 检索；请在下一父会话轮次基于已有证据继续聚焦补查。`
    }
    if (state.searchCount > 0) {
      const reason = focusedFollowupReason(exec, state.lastPrompt)
      if (reason !== undefined) return reason
    }
    const promptGuardReason = initialPromptGuardReason(exec)
    if (promptGuardReason !== undefined) return promptGuardReason
    state.searchPending = true
    state.currentSearchStarted = false
    state.pendingPrompt = wrapperPrompt(exec.arguments)
    return undefined
  }
  guard.childStarted = (exec) => {
    const state = stateFor(exec)
    if (state === undefined || !state.searchPending || state.currentSearchStarted) return
    state.searchCount += 1
    state.anyChildStarted = true
    state.currentSearchStarted = true
    state.lastPrompt = state.pendingPrompt
  }
  guard.dispatchSettled = (exec) => {
    const state = stateFor(exec)
    if (state === undefined) return
    state.searchPending = false
    state.currentSearchStarted = false
    state.pendingPrompt = undefined
  }
  guard.hasStartedChild = (agent, turn) => {
    const state = states.get(String(agent?.id))
    return state?.turn === turn && state.anyChildStarted === true
  }
  return guard
}

/**
 * Reserve a wrapper call before dispatch, commit it only when the
 * parent-scoped lifecycle publishes a child, then settle it from the actual
 * dispatch result. Rejected calls never enter this seam and cannot consume a
 * parent turn's follow-up budget.
 */
export function installSelectedSourceDispatchTracking(ctx, guard) {
  return ctx.on('tools/execute', async (exec, next) => {
    if (!SELECTED_SOURCE_WRAPPERS.has(exec.name) || exec.agent === undefined) return next()
    const stop = exec.agent.ctx.on('subagent/start', () => {
      guard.childStarted(exec)
    })
    try {
      const result = await next()
      guard.dispatchSettled(exec)
      return result
    } catch (error) {
      guard.dispatchSettled(exec)
      throw error
    } finally {
      stop()
    }
  })
}

function latestAssistantTextInTurn(events, turn) {
  let inTurn = false
  let latest = ''
  for (const event of events) {
    if (event?.type === 'turn/start') {
      inTurn = event.data?.turn === turn
      continue
    }
    if (!inTurn) continue
    if (event?.type === 'turn/end') break
    if (event?.type !== 'assistant/message' || !Array.isArray(event.data?.message?.content)) continue
    latest = event.data.message.content
      .flatMap((block) => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
      .join('')
  }
  return latest
}

function progressGateMessage(toolName, events) {
  const source = toolName === 'search_selected_remote_code' ? '代码' : '知识库'
  const pmdPrd = initialSelectedSourcePrompt(events)?.pmdPrd === true
  const promptInstruction = pmdPrd
    ? '这是显式 /pmd-prd 请求：先理解用户需求，再整理包含需求理解、现状或问题、相关功能与代码位置、影响范围的结构化 prompt，不能原样传递业务文本。'
    : '普通非 /pmd-prd 检索的 prompt 仍需原样使用当前用户消息。'
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: `运行时校验失败：你刚才声称${source}正在后台查询，但本轮没有真实创建 selected-source 子代理。不要再输出进度说明；立即调用 ${toolName}，只传 description 和 prompt。${promptInstruction}只有收到子代理启动事件后，才能告诉用户后台查询已开始。` })]),
    source: PROGRESS_GATE_SOURCE,
  })
}

/**
 * Keep the parent turn open when the model narrates selected-source progress
 * without a published child. This turns the user-visible promise into a
 * runtime invariant instead of relying on prompt compliance alone.
 */
export function installSelectedSourceProgressCompletionGate(ctx, guard) {
  return ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent?.session?.header?.origin === 'subagent') return
    const events = agent?.session?.events
    if (!Array.isArray(events)) return
    const latestText = latestAssistantTextInTurn(events, turn)
    const claim = SELECTED_SOURCE_PROGRESS_CLAIMS.find((item) => item.pattern.test(latestText))
    if (claim === undefined || guard.hasStartedChild(agent, turn)) return
    agent.steer(progressGateMessage(claim.toolName, events))
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
  const stopSelectedSourceProgressCompletionGate = installSelectedSourceProgressCompletionGate(ctx, selectedSourceDispatchGuard)
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
    stopSelectedSourceProgressCompletionGate()
    if (config.failOnStartupError) throw error
    ctx.logger.error(`MCP startup failed: ${String(error)}`)
  }
  ctx.effect(() => () => {
    stopped = true
    stopContinuableSetup()
    stopSelectedSourceDispatchGuard()
    stopSelectedSourceDispatchTracking()
    stopSelectedSourceProgressCompletionGate()
    for (const disposers of childDisposers.values()) for (const dispose of disposers.values()) dispose()
    childDisposers.clear()
    for (const dispose of globalDisposers.values()) dispose()
  }, 'harness-runtime-mcp-scopes.connection')
}
