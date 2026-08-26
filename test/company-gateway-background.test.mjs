import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')

test('company gateway uses the current AccrUI model and quota contracts', () => {
  assert.match(source, /COMPANY_GATEWAY_BASE_URL = `\$\{KNOWLEDGE_API_ORIGIN\}\/api-sse-anthropic\/v1`/)
  assert.match(source, /companyGatewayJson\('\/models', apiKey\)/)
  assert.match(source, /companyGatewayJson\('\/key\/quota', apiKey\)/)
  assert.match(source, /path === '\/models' \? \{ 'x-api-key': apiKey \} : \{ authorization: `Bearer \$\{apiKey\}` \}/)
})

test('the probe is sidepanel-only, bounded, and never returns the key', () => {
  assert.match(source, /request\.type === 'company-gateway-probe\/v1'/)
  assert.match(source, /!isSidePanelSender\(sender\)/)
  assert.match(source, /value\.length <= 512/)
  assert.match(source, /sendResponse\(\{ ok: true, requestId, gateway \}\)/)
  assert.doesNotMatch(source, /sendResponse\(\{[^\n]*apiKey/)
  assert.match(source, /request\.protocol !== 'anthropic-messages' && request\.protocol !== 'openai-completions'/)
  assert.match(source, /request\.requestedModelId/)
})

test('safe model and quota metadata is cached without persisting the credential', () => {
  assert.match(source, /COMPANY_GATEWAY_METADATA_STORAGE_KEY/)
  assert.match(source, /chrome\.storage\.local\.set\(\{ \[COMPANY_GATEWAY_METADATA_STORAGE_KEY\]: verifiedMetadata \}\)/)
  assert.doesNotMatch(source, /chrome\.storage\.[\s\S]{0,80}\bapiKey\b/)
})

test('loads the catalog before capability validation, and probes only the selected model', () => {
  assert.match(source, /if \(requestedModelId === undefined\) \{[\s\S]{0,400}return metadata/)
  assert.match(source, /const modelId = requestedModelId/)
  assert.doesNotMatch(source, /const modelId = requestedModelId \?\? models\[0\]\.id/)
  assert.match(source, /models\.some\(\(model\) => model\.id === modelId\)/)
  assert.match(source, /probeCompanyGatewayToolCapability\(\{ apiKey, protocol, modelId, signal: controller\.signal \}\)/)
  assert.match(source, /quota\.usagePercent !== null && quota\.usagePercent >= 100/)
})

test('Thinking models retry capability detection without forced tool choice', () => {
  assert.match(source, /thinking mode does not support this tool_choice/)
  assert.match(source, /\.\.\.\(forceTool \? \{ tool_choice: toolChoice \} : \{\}\)/)
  assert.match(source, /response = await request\(false\)/)
})
