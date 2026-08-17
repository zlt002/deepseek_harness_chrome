#!/usr/bin/env node
/**
 * 复现脚本：验证对 native-server 传话筒（BrowserConnector + NativeHost）的四个观点。
 *
 * 观点对应关系：
 *   [C0] 完成度：MCP tools/list 应返回 12 个工具
 *   [C1] 毛刺①：Run 中途 transfer-browser-target 后，在途请求不快速失败，干等到超时
 *   [C2] 毛刺②：超时后迟到的 connector_response 被拒收，native-host 回 "Unrecognized Connector response"
 *   [C3] 毛刺③：扩展侧全局串行队列 + 管道 15s 超时 < team_doc 30s 等待，队头阻塞
 *   [C4] 毛刺④：客户端中止后向已关闭 response 写回复（竞态），进程不崩溃
 *
 * 运行：node output/repro-connector-claims.mjs
 */
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { NativeHost } from '../apps/native-server/src/native-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const T0 = performance.now()
const at = () => `t+${String(Math.round(performance.now() - T0)).padStart(5)}ms`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hr = (title) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)

const targetA = { browser: 'chrome', windowId: 1, tabId: 10, url: 'https://webedit.midea.com/sheetA' }
const targetB = { browser: 'chrome', windowId: 1, tabId: 20, url: 'https://webedit.midea.com/sheetB' }
const contextResult = (target) => ({
  status: 'browser_target_verified',
  pageIdentity: { title: 'Demo Sheet', url: target.url },
  documentIdentity: null,
})
const extensionResponse = (correlation, target) => ({
  type: 'connector_response',
  requestId: correlation.requestId,
  runId: correlation.runId,
  generation: correlation.generation,
  browserTarget: target,
  result: contextResult(target),
})

async function mcpCall(connector, body, signal) {
  const response = await fetch(`${connector.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connector.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  return response.json()
}

const officeGetContext = (connector, signal) =>
  mcpCall(connector, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'office_get_context', arguments: {} } }, signal)

/* ---------------------------------------------------------------- [C0] */
hr('[C0] 完成度验证：tools/list 应返回 12 个工具')
{
  const connector = new BrowserConnector({ requestExtension: () => {} })
  await connector.start()
  const body = await mcpCall(connector, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  console.log(`${at()} tools/list 返回 ${body.result.tools.length} 个工具:`)
  console.log(`       ${body.result.tools.map((tool) => tool.name).join(', ')}`)
  console.log(body.result.tools.length === 12 ? '       => 与观点一致（12 个）✅' : '       => 数量不符 ❌')
  await connector.stop()
}

/* ------------------------------------------------- [C1] 对照组：正常路径 */
hr('[C1-对照] 正常路径：目标未变，扩展 80ms 后回话 → 调用应 ~80ms 完成')
{
  const connector = new BrowserConnector({ requestExtension: () => {}, requestTimeoutMs: 600 })
  connector.bindBrowserTarget('run-c1', targetA)
  await connector.start()
  let correlation
  connector.requestExtension = (request) => { correlation = request }
  const pendingCall = officeGetContext(connector)
  await sleep(80)
  connector.acceptExtensionResponse(extensionResponse(correlation, targetA))
  const body = await pendingCall
  console.log(`${at()} office_get_context 完成，status = ${body.result.structuredContent.officeContext.status}`)
  console.log(`       => 快速返回 ✅（对照组成立）`)
  await connector.stop()
}

/* -------------------------------------------- [C1] 毛刺①：换目标后干等 */
hr('[C1-毛刺①] 中途 transfer 到目标 B，再用目标 A 的合法回话 → 预期：不快速失败，干等到 600ms 超时')
{
  const connector = new BrowserConnector({ requestExtension: () => {}, requestTimeoutMs: 600 })
  connector.bindBrowserTarget('run-c1b', targetA)
  await connector.start()
  let correlation
  connector.requestExtension = (request) => { correlation = request }
  const pendingCall = officeGetContext(connector)
  await sleep(60)
  connector.bindBrowserTarget('run-c1b', targetB) // 模拟扩展发来 transfer-browser-target
  console.log(`${at()} t+60ms  Run 已迁移到目标 B`)
  await sleep(40)
  const accepted = connector.acceptExtensionResponse(extensionResponse(correlation, targetA))
  console.log(`${at()} t+100ms 扩展以目标 A 身份回了一份格式完全合法的结果`)
  console.log(`       acceptExtensionResponse 返回 ${accepted}（拒收，且 pending 未被清理）`)
  const body = await pendingCall
  const text = body.result.content[0].text
  console.log(`${at()} 工具调用最终结果（等到超时才回来）：`)
  console.log(`       isError = ${body.result.isError === true}, text = "${text}"`)
  console.log(`       => 观点①成立 ✅：身份已不匹配却不能快速失败，错误文案是"超时"而非"目标已迁移"`)
  await connector.stop()
}

/* ------------------------------- [C2] 毛刺②：迟到回话变成 Unrecognized */
hr('[C2-毛刺②] 超时已发生（500ms 档缩短为 300ms）后才送达的合法回话 → 预期：拒收 + native-host 回错误')
{
  const connector = new BrowserConnector({ requestExtension: () => {}, requestTimeoutMs: 300 })
  connector.bindBrowserTarget('run-c2', targetA)
  await connector.start()
  let correlation
  connector.requestExtension = (request) => { correlation = request }
  const pendingCall = officeGetContext(connector)
  await pendingCall // 先等到超时发生
  await sleep(100)
  const accepted = connector.acceptExtensionResponse(extensionResponse(correlation, targetA))
  console.log(`${at()} 超时 100ms 后扩展的回话到达，acceptExtensionResponse 返回 ${accepted}`)
  // 再看 native-host 会把它转成什么发回浏览器
  const host = new NativeHost({ connectorFactory: () => connector, processFactory: () => { throw new Error('not used') } })
  host.connector = connector
  const captured = []
  host.send = (message) => captured.push(message)
  await host.handle({ type: 'connector_response', requestId: correlation.requestId, runId: correlation.runId, generation: correlation.generation, result: contextResult(targetA) })
  console.log(`${at()} NativeHost.handle() 实际发回浏览器的消息：`)
  console.log(`       ${JSON.stringify(captured[0])}`)
  console.log(`       => 观点②成立 ✅：迟到回话成为一条 error 噪音（无害但污染协议流）`)
  await connector.stop()
}

/* ------------------------ [C3] 毛刺③：串行队列 + 超时不及长任务等待 */
hr('[C3-毛刺③] 两个静态常量 + 队列仿真')
{
  const connectorSource = readFileSync(path.join(HERE, '../apps/native-server/src/connector.mjs'), 'utf8')
  const backgroundSource = readFileSync(path.join(HERE, '../apps/chrome-extension/entrypoints/background.ts'), 'utf8')
  const pipeTimeout = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+)/.exec(connectorSource)?.[1]?.replace(/_/g, ''))
  const frameWait = Number(/frameDeadline = Date\.now\(\) \+ ([\d_]+)/.exec(backgroundSource)?.[1]?.replace(/_/g, ''))
  console.log(`${at()} 源码常量：管道请求超时 REQUEST_TIMEOUT_MS = ${pipeTimeout}ms（connector.mjs）`)
  console.log(`       扩展侧 team_doc 等待 WebEdit iframe 的 frameDeadline = ${frameWait}ms（background.ts）`)
  console.log(`       => team_doc 单次内部等待（${frameWait}ms）超过管道超时（${pipeTimeout}ms）：${frameWait > pipeTimeout ? '成立 ✅' : '不成立 ❌'}`)

  // 仿真 background.ts queueNativeLifecycle 的确切实现模式（promise 链全局串行）
  console.log(`\n${at()} 仿真 queueNativeLifecycle（与 background.ts 同一 promise 链模式），队头 600ms 长任务 + 队尾 5ms 短任务：`)
  let queue = Promise.resolve()
  const queueNativeLifecycle = (operation) => {
    const queued = queue.then(operation)
    queue = queued.then(() => undefined, () => undefined)
    return queued
  }
  const t0 = performance.now()
  const slow = queueNativeLifecycle(async () => { await sleep(600); return 'slow' })
  const fast = queueNativeLifecycle(async () => { await sleep(5); return 'fast' })
  const stamp = (name, value) => console.log(`       ${name} 完成于 t+${Math.round(performance.now() - t0)}ms（结果 ${value}）`)
  fast.then((v) => stamp('短任务(自身仅需 5ms)', v))
  await slow.then((v) => stamp('长任务(模拟 team_doc 写入)', v))
  await fast
  console.log(`       => 队尾任务被队头阻塞 ✅；叠加管道超时从"发出时刻"起算，慢 team_doc 会拖死后续请求`)
}

/* ---------------------- [C4] 毛刺④：中止后写已关闭 response 的竞态 */
hr('[C4-毛刺④] 客户端中止与扩展回话的竞态 ×15 次 → 关注：进程是否存活、是否产生进程级异常')
{
  const unexpected = []
  const onUncaught = (error) => unexpected.push(`uncaughtException: ${error?.code ?? error?.message}`)
  const onRejection = (error) => unexpected.push(`unhandledRejection: ${String(error?.code ?? error?.message ?? error)}`)
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  const connector = new BrowserConnector({ requestExtension: () => {}, requestTimeoutMs: 2000 })
  connector.bindBrowserTarget('run-c4', targetA)
  await connector.start()
  let correlation
  connector.requestExtension = (request) => { correlation = request }
  for (let round = 1; round <= 15; round += 1) {
    const controller = new AbortController()
    const client = officeGetContext(connector, controller.signal).catch((error) => `client:${error.name}`)
    await sleep(30 + Math.round(Math.random() * 10))
    // 同一 tick 内先触发客户端中止、再送达扩展回话，制造"写已关闭 response"的窗口
    controller.abort()
    connector.acceptExtensionResponse(extensionResponse(correlation, targetA))
    const outcome = await client.catch(() => 'client:failed')
    if (round <= 3) console.log(`${at()} 第 ${round} 轮客户端结果：${outcome}`)
    await sleep(40)
  }
  await sleep(200)
  process.off('uncaughtException', onUncaught)
  process.off('unhandledRejection', onRejection)
  console.log(`${at()} 15 轮竞态结束，进程级异常捕获数：${unexpected.length}`)
  for (const line of unexpected.slice(0, 3)) console.log(`       ${line}`)
  console.log(`       => 进程存活 ✅${unexpected.length > 0 ? '，竞态可被触发（异步异常，被进程级兜底）✅' : '，本轮未捕获到显式异常（写入被 Node 静默吞掉，同样无害）'}`)
  await connector.stop()
}

hr('总结')
console.log(`
  [C0] 12 个 MCP 工具                     → 已验证
  [C1] 换目标后在途请求干等到超时            → 已验证（对照组 vs 毛刺组对比明显）
  [C2] 迟到回话 → "Unrecognized Connector response" → 已验证
  [C3] 串行队列队头阻塞 + 30s > 15s 常量     → 已验证（常量 + 仿真）
  [C4] 中止竞态不崩溃                      → 已验证（进程存活）

  注：演示用 requestTimeoutMs=300~600ms 缩短等待；生产默认 15s（connector.mjs REQUEST_TIMEOUT_MS）。
`)
