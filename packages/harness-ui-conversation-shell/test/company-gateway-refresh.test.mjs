import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
const source = await readFile(new URL('../src/client/company-gateway-refresh.ts', import.meta.url), 'utf8')
const output = await build({ stdin: { contents: source, loader: 'ts', resolveDir: clientDir }, bundle: true, format: 'esm', platform: 'node', write: false })
const refreshModule = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

const profile = {
  api: 'openai-completions',
  baseURL: 'https://gateway.example/v1',
  models: [{ id: 'vision', name: 'Local name', contextWindow: 128_000, input: ['text', 'image'] }, { id: 'retired' }],
}

test('picker refresh updates only the company model path and keeps same-id local capabilities', async () => {
  const calls = []
  const api = {
    settings: {
      describe: async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { other: { models: [{ id: 'untouched' }] }, 'annto-company-gateway': profile } } }] } } }),
      mutate: async payload => { calls.push(['mutate', payload]); return { result: { ok: true, value: {} } } },
    },
    llm: {
      discoverModels: async payload => { calls.push(['discover', payload]); return { result: { ok: true, value: { models: [{ id: 'vision', name: 'Remote name' }, { id: 'new' }] } } } },
    },
  }

  assert.equal(await refreshModule.refreshCompanyGatewayCatalog(api), undefined)
  assert.equal('apiKey' in calls[0][1], false)
  assert.deepEqual(calls[1][1].ops, [{
    op: 'set',
    path: ['providers', 'annto-company-gateway', 'models'],
    value: [{ id: 'vision', name: 'Local name', contextWindow: 128_000, input: ['text', 'image'] }, { id: 'new' }],
  }])
})

test('picker still loads cached groups and shows a provider-local warning when remote sync fails', async () => {
  const events = []
  const state = { failures: [{ id: 'other', name: 'Other', message: 'down' }] }
  const directory = {
    load: async () => { events.push('load'); return 'cached' },
    store: { update: updater => updater(state) },
  }
  const restore = refreshModule.installCompanyGatewayRefresh(directory, async () => { events.push('refresh'); return '401; check the API key' })

  assert.equal(await directory.load(), 'cached')
  assert.deepEqual(events, ['refresh', 'load'])
  assert.deepEqual(state.failures, [
    { id: 'other', name: 'Other', message: 'down' },
    { id: 'annto-company-gateway', name: '公司网关', message: '远程模型同步失败：401; check the API key' },
  ])
  restore()
  await directory.load()
  assert.deepEqual(events, ['refresh', 'load', 'load'])
})
