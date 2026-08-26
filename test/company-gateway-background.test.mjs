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

test('the catalog load is sidepanel-only, bounded, and never returns the key', () => {
  assert.match(source, /request\.type === 'company-gateway-probe\/v1'/)
  assert.match(source, /!isSidePanelSender\(sender\)/)
  assert.match(source, /value\.length <= 512/)
  assert.match(source, /sendResponse\(\{ ok: true, requestId, gateway \}\)/)
  assert.doesNotMatch(source, /sendResponse\(\{[^\n]*apiKey/)
  assert.match(source, /request\.protocol !== 'anthropic-messages' && request\.protocol !== 'openai-completions'/)
  assert.doesNotMatch(source, /requestedModelId|accrui_capability_probe|Agent 工具调用/)
})

test('safe model and quota metadata is cached without persisting the credential', () => {
  assert.match(source, /COMPANY_GATEWAY_METADATA_STORAGE_KEY/)
  assert.match(source, /chrome\.storage\.local\.set\(\{ \[COMPANY_GATEWAY_METADATA_STORAGE_KEY\]: metadata \}\)/)
  assert.doesNotMatch(source, /chrome\.storage\.[\s\S]{0,80}\bapiKey\b/)
})

test('loads the catalog and quota in one request without contacting a selected model', () => {
  assert.match(source, /const \[rawModels, rawQuota\] = await Promise\.all/)
  assert.match(source, /const metadata = \{ models, quota, checkedAt: new Date\(\)\.toISOString\(\) \}/)
  assert.match(source, /quota\.usagePercent !== null && quota\.usagePercent >= 100/)
})
