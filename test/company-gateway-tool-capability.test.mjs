import assert from 'node:assert/strict'
import test from 'node:test'

import { probeCompanyGatewayToolCapability } from '../apps/chrome-extension/src/company-gateway-tool-capability.mjs'

test('accepts an OpenAI-compatible model only after the forced probe tool is returned', async () => {
  const requests = []
  const result = await probeCompanyGatewayToolCapability({
    apiKey: 'secret', protocol: 'openai-completions', modelId: 'model-a',
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'accrui_capability_probe' } }] } }] }) }
    },
  })
  assert.deepEqual(result, { protocol: 'openai-completions', modelId: 'model-a', tools: true })
  assert.equal(requests[0].url, 'https://anapi-uat.annto.com/api-sse-anthropic/v1/chat/completions')
  assert.equal(JSON.parse(requests[0].init.body).tools[0].function.name, 'accrui_capability_probe')
})

test('accepts an Anthropic-compatible model only after a tool_use block is returned', async () => {
  const result = await probeCompanyGatewayToolCapability({
    apiKey: 'secret', protocol: 'anthropic-messages', modelId: 'model-a',
    fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'accrui_capability_probe', input: {} }] }) }),
  })
  assert.deepEqual(result, { protocol: 'anthropic-messages', modelId: 'model-a', tools: true })
})

test('retries a Thinking model probe without forced tool choice and still requires a real tool call', async () => {
  const bodies = []
  const result = await probeCompanyGatewayToolCapability({
    apiKey: 'secret', protocol: 'anthropic-messages', modelId: 'deepseek-v4-pro',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      if (bodies.length === 1) {
        return { ok: false, status: 400, text: async () => 'Thinking mode does not support this tool_choice.' }
      }
      return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'accrui_capability_probe', input: {} }] }) }
    },
  })
  assert.deepEqual(result, { protocol: 'anthropic-messages', modelId: 'deepseek-v4-pro', tools: true })
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0].tool_choice, { type: 'tool', name: 'accrui_capability_probe' })
  assert.equal('tool_choice' in bodies[1], false)
})

test('rejects a Thinking model when the unforced retry returns only text', async () => {
  let calls = 0
  await assert.rejects(probeCompanyGatewayToolCapability({
    apiKey: 'secret', protocol: 'anthropic-messages', modelId: 'deepseek-v4-pro',
    fetchImpl: async () => ++calls === 1
      ? { ok: false, status: 400, text: async () => 'Thinking mode does not support this tool_choice.' }
      : { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  }), /没有返回测试工具/)
  assert.equal(calls, 2)
})

test('surfaces the gateway custom-tool incompatibility and never reports a false capability', async () => {
  await assert.rejects(probeCompanyGatewayToolCapability({
    apiKey: 'secret', protocol: 'anthropic-messages', modelId: 'model-a',
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'unknown variant custom' }),
  }), /不支持 Agent 工具调用.*unknown variant custom/)
})

test('rejects a successful text-only response because ordinary chat is not an Agent capability check', async () => {
  await assert.rejects(probeCompanyGatewayToolCapability({
    apiKey: 'secret', protocol: 'openai-completions', modelId: 'model-a',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }),
  }), /没有返回测试工具/)
})
