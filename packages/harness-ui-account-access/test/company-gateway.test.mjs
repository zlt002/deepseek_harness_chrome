import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
const source = await readFile(new URL('../src/client/company-gateway.ts', import.meta.url), 'utf8')
const output = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: clientDir },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const gatewayModule = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

const onboardingSource = await readFile(new URL('../src/client/onboarding.ts', import.meta.url), 'utf8')
const onboardingOutput = await build({
  stdin: { contents: onboardingSource, loader: 'ts', resolveDir: clientDir },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const onboardingModule = await import(`data:text/javascript;base64,${Buffer.from(onboardingOutput.outputFiles[0].text).toString('base64')}`)

const onboardingViewSource = await readFile(new URL('../src/client/CompanyGatewayOnboarding.tsx', import.meta.url), 'utf8')
const accountAccessViewSource = await readFile(new URL('../src/client/AccountAccessSection.tsx', import.meta.url), 'utf8')
const modelCatalogSource = await readFile(new URL('../src/client/CompanyGatewayModelCatalog.tsx', import.meta.url), 'utf8')

const gateway = {
  models: [{ id: 'model-a', name: 'Model A' }],
  quota: { usagePercent: 20, nextResetTime: null, resetCycle: 'monthly' },
  checkedAt: '2026-08-20T00:00:00.000Z',
}

const ok = { result: { ok: true } }

test('saveCompanyGateway never writes the unexposed default-model settings namespace', async () => {
  const calls = []
  const api = {
    settings: { mutate: async payload => { calls.push(['settings', payload]); return ok } },
    credentials: { set: async payload => { calls.push(['credential', payload]); return ok } },
  }

  assert.equal(await gatewayModule.saveCompanyGateway(api, gateway.models, 'sk-secret', 'openai-completions'), undefined)
  assert.deepEqual(calls.map(([kind]) => kind), ['settings', 'credential'])
  assert.equal(calls[0][1].ns, 'llm-pi-ai')
  assert.equal(calls[1][1].value, 'sk-secret')
  const profile = calls[0][1].ops[0].value
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, 'https://anapi-uat.annto.com/api-sse-anthropic/v1')
  assert.equal('displayName' in profile, false)
  assert.doesNotMatch(JSON.stringify([calls[0][1]]), /sk-secret/)
})

test('company gateway protocol maps to its corresponding fixed URL', () => {
  assert.equal(gatewayModule.companyGatewayBaseUrl('anthropic-messages'), 'https://anapi-uat.annto.com/api-sse-anthropic')
  assert.equal(gatewayModule.companyGatewayBaseUrl('openai-completions'), 'https://anapi-uat.annto.com/api-sse-anthropic/v1')
})

test('a refreshed company catalog replaces retired models and only promotes the selected current model', () => {
  const latest = [{ id: 'claude-haiku-4-5-20251001' }, { id: 'minimax-m2.7' }, { id: 'minimax-m3' }]

  assert.deepEqual(
    gatewayModule.companyGatewayModelsForSelection(latest, 'minimax-m2.5').map(model => model.id),
    ['claude-haiku-4-5-20251001', 'minimax-m2.7', 'minimax-m3'],
  )
  assert.deepEqual(
    gatewayModule.companyGatewayModelsForSelection(latest, 'minimax-m3').map(model => model.id),
    ['minimax-m3', 'claude-haiku-4-5-20251001', 'minimax-m2.7'],
  )
})

test('both company gateway entry points expose the fixed address, model selection, and key portal without a tool-capability gate', () => {
  for (const view of [onboardingViewSource, accountAccessViewSource]) {
    assert.match(view, /API 地址/)
    assert.match(view, /打开密钥门户/)
    assert.match(view, /companyGatewayModelsForSelection/)
    assert.doesNotMatch(view, /验证所选模型的 Agent 工具能力|Agent 工具调用|verifySelectedModel/)
  }
})

test('both company gateway entry points use an editable multi-model catalog with per-row capacities and image input', () => {
  for (const view of [onboardingViewSource, accountAccessViewSource]) {
    assert.match(view, /CompanyGatewayModelCatalog/)
    assert.doesNotMatch(view, /<select value=\{selectedModel\}/)
  }
  assert.match(modelCatalogSource, /contextWindow/)
  assert.match(modelCatalogSource, /maxTokens/)
  assert.match(modelCatalogSource, /支持多模态图片/)
  assert.match(modelCatalogSource, /onSelectedModelChange/)
})

test('company gateway restores the saved protocol from the settings namespace', () => {
  assert.equal(gatewayModule.companyGatewayProtocolFromNamespaces([
    { ns: 'llm-pi-ai', value: { providers: { 'annto-company-gateway': { api: 'openai-completions' } } } },
  ]), 'openai-completions')
  assert.equal(gatewayModule.companyGatewayProtocolFromNamespaces([
    { ns: 'llm-pi-ai', value: { providers: { 'annto-company-gateway': { api: 'unsupported' } } } },
  ]), undefined)
})

test('company gateway restores editable model fields and merges them onto the refreshed catalog', () => {
  const saved = gatewayModule.companyGatewayModelsFromNamespaces([
    { ns: 'llm-pi-ai', value: { providers: { 'annto-company-gateway': { models: [
      { id: 'vision-model', name: '视觉模型', contextWindow: 131072, maxTokens: 98304, input: ['text', 'image'], customFlag: true },
    ] } } } },
  ])
  assert.deepEqual(saved, [{ id: 'vision-model', name: '视觉模型', contextWindow: 131072, maxTokens: 98304, input: ['text', 'image'], customFlag: true }])
  assert.deepEqual(gatewayModule.mergeCompanyGatewayModels(saved, [
    { id: 'vision-model', name: 'Gateway name' },
    { id: 'new-model', name: 'New model' },
  ]), [
    { id: 'vision-model', name: '视觉模型', contextWindow: 131072, maxTokens: 98304, input: ['text', 'image'], customFlag: true },
    { id: 'new-model', name: 'New model' },
  ])
})

test('saved company gateway models can reopen for editing without requiring a new key', async () => {
  const savedModels = [{ id: 'renamed-vision', name: '视觉模型', contextWindow: 131072, maxTokens: 98304, input: ['text', 'image'] }]
  const restored = gatewayModule.companyGatewayMetadataForEditing(savedModels, {
    models: [{ id: 'old-id', name: 'Old name' }],
    quota: { usagePercent: 12, nextResetTime: null, resetCycle: 'monthly' },
    checkedAt: '2026-08-20T00:00:00.000Z',
  })
  assert.deepEqual(restored?.models, savedModels)

  const calls = []
  const api = {
    settings: { mutate: async payload => { calls.push(['settings', payload]); return ok } },
    credentials: { set: async payload => { calls.push(['credential', payload]); return ok } },
  }
  assert.equal(await gatewayModule.saveCompanyGateway(api, savedModels, undefined, 'openai-completions'), undefined)
  assert.deepEqual(calls.map(([kind]) => kind), ['settings'])
})

test('the restored catalog change path updates the draft that save consumes', () => {
  const onChangeStart = accountAccessViewSource.indexOf('onChange={models => {')
  assert.notEqual(onChangeStart, -1)
  const onChangeSource = accountAccessViewSource.slice(onChangeStart, onChangeStart + 700)
  assert.match(onChangeSource, /probedGateway !== undefined/)
  assert.match(onChangeSource, /setRestoredGateway\(current => current === undefined \? current : \{ \.\.\.current, models \}\)/)
  assert.match(accountAccessViewSource, /const models = companyGatewayModelsForSelection\(gateway\.models, selectedModel\)/)
  assert.match(accountAccessViewSource, /saveCompanyGateway\(api, models, key\.length === 0 \? undefined : key, protocol\)/)
})

test('saveCompanyGateway does not select a default model when credential persistence fails', async () => {
  const calls = []
  const api = {
    settings: { mutate: async payload => { calls.push(['settings', payload]); return ok } },
    credentials: { set: async payload => { calls.push(['credential', payload]); return { result: { ok: false, error: { message: 'credential rejected' } } } } },
  }

  assert.equal(await gatewayModule.saveCompanyGateway(api, gateway.models, 'sk-secret'), 'credential rejected')
  assert.deepEqual(calls.map(([kind]) => kind), ['settings', 'credential'])
})

test('saveCompanyGateway persists editable model drafts without dropping unknown fields', async () => {
  const calls = []
  const api = {
    settings: { mutate: async payload => { calls.push(['settings', payload]); return ok } },
    credentials: { set: async () => ok },
  }
  const models = [
    { id: 'vision-model', name: 'Vision model', input: ['text', 'image'], contextWindow: 128_000, customFlag: true },
    { id: 'text-model', name: '   ', description: 'kept' },
  ]

  assert.equal(await gatewayModule.saveCompanyGateway(api, models), undefined)
  const saved = calls[0][1].ops[0].value.models
  assert.deepEqual(saved[0], {
    id: 'vision-model',
    name: 'Vision model',
    input: ['text', 'image'],
    contextWindow: 128_000,
    customFlag: true,
    maxTokens: 64_000,
  })
  assert.equal('name' in saved[1], false)
  assert.equal(saved[1].description, 'kept')
})

test('company gateway draft validation rejects empty catalogs, empty ids, and duplicate ids', () => {
  assert.equal(gatewayModule.companyGatewayModelDraftFailure([]), '模型目录不能为空。')
  assert.equal(gatewayModule.companyGatewayModelDraftFailure([{ id: 'model-a' }, { id: ' ' }]), '模型 ID 不能为空。')
  assert.equal(gatewayModule.companyGatewayModelDraftFailure([{ id: 'model-a' }, { id: 'model-a' }]), '模型 ID 不能重复。')
  assert.equal(gatewayModule.companyGatewayModelDraftFailure([{ id: 'model-a' }]), undefined)
})

test('saveCompanyGateway refuses invalid drafts before any settings or credential write', async () => {
  const calls = []
  const api = {
    settings: { mutate: async payload => { calls.push(payload); return ok } },
    credentials: { set: async payload => { calls.push(payload); return ok } },
  }

  assert.equal(await gatewayModule.saveCompanyGateway(api, [{ id: 'model-a' }, { id: 'model-a' }]), '模型 ID 不能重复。')
  assert.deepEqual(calls, [])
})

test('saveCompanyGateway persists the edited first model id and does not write an invalid empty catalog', async () => {
  const calls = []
  const api = {
    settings: { mutate: async payload => { calls.push(['settings', payload]); return ok } },
    credentials: { set: async payload => { calls.push(['credential', payload]); return ok } },
  }

  assert.equal(await gatewayModule.saveCompanyGateway(api, [{ id: '  edited-first  ' }, { id: 'second' }]), undefined)
  assert.equal(calls[0][1].ops[0].value.models[0].id, 'edited-first')

  calls.length = 0
  assert.equal(await gatewayModule.saveCompanyGateway(api, []), '模型目录不能为空。')
  assert.deepEqual(calls, [])
})

test('initial model selection uses the public session directory after the profile is saved', async () => {
  const calls = []
  const directory = {
    load: async () => { calls.push('load') },
    select: async selection => { calls.push(selection) },
  }

  assert.equal(await gatewayModule.selectCompanyGatewayInitialModel(directory, gateway.models), undefined)
  assert.deepEqual(calls, ['load', { provider: 'annto-company-gateway', model: 'model-a' }])
  assert.equal(await gatewayModule.selectCompanyGatewayInitialModel(undefined, gateway.models), undefined)
})

test('first-run onboarding appears only when no configured active provider has usable credentials', () => {
  const provider = { active: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'] }
  const namespaces = [{ ns: 'llm-pi-ai', value: { providers: { gateway: { apiKeyEnv: 'GATEWAY_KEY' } } } }]
  assert.equal(onboardingModule.hasUsableModelProvider([provider], namespaces, {}), false)
  assert.equal(onboardingModule.hasUsableModelProvider([provider], namespaces, { GATEWAY_KEY: { configured: true } }), true)
  assert.equal(onboardingModule.hasUsableModelProvider([{ ...provider, active: false }], namespaces, { GATEWAY_KEY: { configured: true } }), false)
  assert.equal(onboardingModule.hasUsableModelProvider([{ ...provider, settingsPath: ['providers', 'native'] }], [{ ns: 'llm-pi-ai', value: { providers: { native: {} } } }], {}), true)
})
