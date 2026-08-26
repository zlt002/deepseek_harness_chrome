const PROBE_TOOL = 'accrui_capability_probe'
const ENDPOINTS = {
  'anthropic-messages': 'https://anapi-uat.annto.com/api-sse-anthropic/v1/messages',
  'openai-completions': 'https://anapi-uat.annto.com/api-sse-anthropic/v1/chat/completions',
}

function anthropicBody(modelId, forceTool = true) {
  const body = {
    model: modelId,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Call the capability probe tool exactly once.' }],
    tools: [{ name: PROBE_TOOL, description: 'Verifies Agent tool-call support.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
  }
  return forceTool ? { ...body, tool_choice: { type: 'tool', name: PROBE_TOOL } } : body
}

function openAiBody(modelId, forceTool = true) {
  const body = {
    model: modelId,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Call the capability probe tool exactly once.' }],
    tools: [{ type: 'function', function: { name: PROBE_TOOL, description: 'Verifies Agent tool-call support.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
  }
  return forceTool ? { ...body, tool_choice: { type: 'function', function: { name: PROBE_TOOL } } } : body
}

function thinkingRejectsForcedToolChoice(detail) {
  const normalized = detail.toLowerCase()
  return normalized.includes('thinking mode does not support this tool_choice')
    || (detail.includes('Thinking mode') && detail.includes('不支持') && detail.includes('tool_choice'))
}

function capabilityFailure(detail) {
  const normalized = detail.toLowerCase()
  if (normalized.includes('invalid model name') || normalized.includes('model_not_found')) {
    return `所选模型已不在当前模型目录中，请重新加载后选择。原始错误：${detail}`
  }
  if (normalized.includes('protocol_restricted') || normalized.includes('访问协议受限') || normalized.includes('访问客户端受限')) {
    return `所选模型不允许使用当前 API 协议，请切换协议或选择其他模型。原始错误：${detail}`
  }
  return `所选模型暂不支持 Agent 工具调用，请换用当前目录中的其他模型。原始错误：${detail}`
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
  const request = forceTool => fetchImpl(endpoint, {
    method: 'POST', headers, signal,
    body: JSON.stringify(protocol === 'anthropic-messages' ? anthropicBody(modelId, forceTool) : openAiBody(modelId, forceTool)),
  })
  let response = await request(true)
  if (!response.ok) {
    const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 1_000) : `HTTP ${response.status}`
    if (!thinkingRejectsForcedToolChoice(detail)) {
      throw new Error(capabilityFailure(detail || `HTTP ${response.status}`))
    }
    response = await request(false)
    if (!response.ok) {
      const retryDetail = typeof response.text === 'function' ? (await response.text()).slice(0, 1_000) : `HTTP ${response.status}`
      throw new Error(capabilityFailure(retryDetail || `HTTP ${response.status}`))
    }
  }
  const value = await response.json()
  if (!returnedProbe(protocol, value)) throw new Error('当前模型没有返回测试工具，不能作为 Agent 模型。')
  return { protocol, modelId, tools: true }
}
