import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'

const source = await readFile(new URL('../src/client/model-order.ts', import.meta.url), 'utf8')
const output = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: new URL('../src/client/', import.meta.url).pathname },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const { companyGatewayFirst } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('puts the company gateway first without reordering any other model provider', () => {
  const groups = [
    { id: 'kimi-coding', models: [] },
    { id: 'zai-coding-cn', models: [] },
    { id: 'annto-company-gateway', models: [] },
    { id: 'bd', models: [] },
  ]

  assert.deepEqual(companyGatewayFirst(groups).map(group => group.id), [
    'annto-company-gateway', 'kimi-coding', 'zai-coding-cn', 'bd',
  ])
})

test('preserves the original array when the company gateway is absent or already first', () => {
  const absent = [{ id: 'kimi-coding', models: [] }]
  const first = [{ id: 'annto-company-gateway', models: [] }, { id: 'bd', models: [] }]
  assert.equal(companyGatewayFirst(absent), absent)
  assert.equal(companyGatewayFirst(first), first)
})
