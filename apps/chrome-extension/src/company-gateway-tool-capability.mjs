const PROBE_TOOL = 'accrui_capability_probe'
const ENDPOINTS = {
  'anthropic-messages': 'https://anapi-uat.annto.com/api-sse-anthropic/v1/messages',
  'openai-completions': 'https://anapi-uat.annto.com/api-sse-anthropic/v1/chat/completions',
}

function anthropicBody(modelId) {
  return {
    model: modelId,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Call the capability probe tool exactly once.' }],
    tools: [{ name: PROBE_TOOL, description: 'Verifies Agent tool-call support.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
    tool_choice: { type: 'tool', name: PROBE_TOOL },
  }
}

function openAiBody(modelId) {
  return {
    model: modelId,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Call the capability probe tool exactly once.' }],
    tools: [{ type: 'function', function: { name: PROBE_TOOL, description: 'Verifies Agent tool-call support.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
    tool_choice: { type: 'function', function: { name: PROBE_TOOL } },
  }
}

function returnedProbe(protocol, value) {
  if (protocol === 'anthropic-messages') return Array.isArray(value?.content)
    && value.content.some(block => block?.type === 'tool_use' && block.name === PROBE_TOOL)
  return Array.isArray(value?.choices)
    && value.choices.some(choice => Array.isArray(choice?.message?.tool_calls)
      && choice.message.tool_calls.some(call => call?.function?.name === PROBE_TOOL))
}

export async function probeCompanyGatewayToolCapability({ apiKey, protocol, modelId, fetchImpl = fetch, signal }) {
  const endpoint = ENDPOINTS[protocol]
  if (endpoint === undefined) throw new Error('不支持的公司网关 API 协议。')
  const headers = protocol === 'anthropic-messages'
    ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers, signal,
    body: JSON.stringify(protocol === 'anthropic-messages' ? anthropicBody(modelId) : openAiBody(modelId)),
  })
  if (!response.ok) {
    const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 1_000) : `HTTP ${response.status}`
    throw new Error(`当前模型或协议不支持 Agent 工具调用：${detail || `HTTP ${response.status}`}`)
  }
  const value = await response.json()
  if (!returnedProbe(protocol, value)) throw new Error('当前模型没有返回测试工具，不能作为 Agent 模型。')
  return { protocol, modelId, tools: true }
}
