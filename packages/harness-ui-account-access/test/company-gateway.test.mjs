import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'

const source = await readFile(new URL('../src/client/company-gateway.ts', import.meta.url), 'utf8')
const output = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: new URL('../src/client/', import.meta.url).pathname },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const gatewayModule = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

const onboardingSource = await readFile(new URL('../src/client/onboarding.ts', import.meta.url), 'utf8')
const onboardingOutput = await build({
  stdin: { contents: onboardingSource, loader: 'ts', resolveDir: new URL('../src/client/', import.meta.url).pathname },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const onboardingModule = await import(`data:text/javascript;base64,${Buffer.from(onboardingOutput.outputFiles[0].text).toString('base64')}`)

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

test('company gateway restores the saved protocol from the settings namespace', () => {
  assert.equal(gatewayModule.companyGatewayProtocolFromNamespaces([
    { ns: 'llm-pi-ai', value: { providers: { 'annto-company-gateway': { api: 'openai-completions' } } } },
  ]), 'openai-completions')
  assert.equal(gatewayModule.companyGatewayProtocolFromNamespaces([
    { ns: 'llm-pi-ai', value: { providers: { 'annto-company-gateway': { api: 'unsupported' } } } },
  ]), undefined)
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
