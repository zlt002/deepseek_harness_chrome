#!/usr/bin/env node
/**
 * 复现：扩展侧错误字符串被 connector 吞掉，模型只看到 generic 文案。
 *
 * 背景：真实会话日志中 4 次 office 工具调用均以
 *   "Error: Extension peer returned no Connector result" 失败（~20ms 内），
 * 说明扩展侧快速抛了真错误（字符串），但 acceptExtensionResponse 的错误分支
 * 只认 read/write/document 的对象错误和 knowledge 的字符串错误，
 * office_get_context / office_spreadsheet / team_* 的字符串错误全部落入 generic else。
 *
 * 运行：node output/repro-error-swallowing.mjs
 */
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'

const target = { browser: 'chrome', windowId: 1, tabId: 10, url: 'https://webedit.midea.com/sheetA' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function callTool(connector, name, args) {
  const pending = fetch(`${connector.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connector.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }).then((response) => response.json())
  await sleep(30) // 等 correlation 进入 pending 表
  const correlation = lastCorrelation
  connector.acceptExtensionResponse({
    type: 'connector_response',
    requestId: correlation.requestId,
    runId: correlation.runId,
    generation: correlation.generation,
    browserTarget: correlation.browserTarget,
    [replyKind]: replyPayload, // 'error' 或 'result'
  })
  return pending
}

let lastCorrelation
let replyKind = 'error'
let replyPayload = ''

async function scenario(title, tool, args, kind, payload) {
  const connector = new BrowserConnector({ requestExtension: (request) => { lastCorrelation = request } })
  connector.bindBrowserTarget('run-x', target)
  await connector.start()
  replyKind = kind
  replyPayload = payload
  const body = await callTool(connector, tool, args)
  const text = body.result.content[0].text
  console.log(`\n--- ${title}`)
  console.log(`    模型实际看到: ${text.slice(0, 120)}`)
  await connector.stop()
  return text
}

console.log('===== 场景 A【真实会话遇到的路径】office_get_context，扩展回字符串错误 =====')
await scenario('office_get_context', 'office_get_context', {}, 'error', 'No Browser Target is bound to this Run by the Extension.')

console.log('\n===== 场景 B【真实会话遇到的路径】office_spreadsheet(action=context)，扩展回字符串错误 =====')
await scenario('office_spreadsheet', 'office_spreadsheet', { action: 'context' }, 'error', 'Browser use is disabled for the next Office turn.')

console.log('\n===== 场景 C【对照】office_read_range，扩展回对象错误 {code,message} =====')
await scenario('office_read_range', 'office_read_range', { range: 'A1' }, 'error', { code: 'navigation', message: 'The trusted Browser Target changed before the range could be read.' })

console.log('\n结论：A/B 的真实错误文案被替换为 generic 消息（模型无从判断该不该重试）；C 证明对象错误本可透传。')
