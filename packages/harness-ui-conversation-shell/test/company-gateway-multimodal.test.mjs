import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
const source = await readFile(new URL('../src/client/company-gateway-multimodal.ts', import.meta.url), 'utf8')
const output = await build({ stdin: { contents: source, loader: 'ts', resolveDir: clientDir }, bundle: true, format: 'esm', platform: 'node', write: false })
const multimodal = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

function apiWith(models) {
  const calls = []
  return {
    calls,
    api: {
      settings: {
        describe: async () => ({ result: { ok: true, value: { namespaces: [{
          ns: 'llm-pi-ai',
          value: { providers: { other: { models: [{ id: 'untouched' }] }, 'annto-company-gateway': { models } } },
        }] } } }),
        mutate: async payload => {
          calls.push(payload)
          const [op] = payload.ops
          // Settings paths only traverse plain objects.  Replacing an array
          // element through `models/<index>/…` turns `models` into an object,
          // which the llm-pi-ai schema rejects.  This fixture accepts only the
          // model-array write that the real settings service can persist.
          if (op?.op !== 'set' || op.path.join('/') !== 'providers/annto-company-gateway/models' || !Array.isArray(op.value)) {
            return { result: { ok: false, error: { message: '模型目录必须整体更新。' } } }
          }
          return { result: { ok: true, value: {} } }
        },
      },
    },
  }
}

test('enabling multimodal updates only the selected company model input', async () => {
  const { api, calls } = apiWith([
    { id: 'vision', name: 'Vision', contextWindow: 200_000 },
    { id: 'text', maxTokens: 64_000, input: ['text'] },
  ])

  assert.deepEqual(await multimodal.setCompanyGatewayModelImageInput(api, 'vision', true), { input: ['text', 'image'] })
  assert.deepEqual(calls, [{
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', 'annto-company-gateway', 'models'], value: [
      { id: 'vision', name: 'Vision', contextWindow: 200_000, input: ['text', 'image'] },
      { id: 'text', maxTokens: 64_000, input: ['text'] },
    ] }],
  }])
})

test('disabling multimodal removes image while retaining other valid input values', async () => {
  const { api, calls } = apiWith([{ id: 'mixed', input: ['text', 'image', 'audio', 7] }])

  assert.deepEqual(await multimodal.setCompanyGatewayModelImageInput(api, 'mixed', false), { input: ['text', 'audio'] })
  assert.deepEqual(calls[0].ops, [{
    op: 'set', path: ['providers', 'annto-company-gateway', 'models'], value: [{ id: 'mixed', input: ['text', 'audio'] }],
  }])
})

test('preserves non-image input values and every unrelated model field', async () => {
  const { api, calls } = apiWith([{ id: 'mixed', input: ['text', 'audio'], custom: { keep: true } }])

  assert.deepEqual(await multimodal.setCompanyGatewayModelImageInput(api, 'mixed', true), { input: ['text', 'audio', 'image'] })
  assert.deepEqual(calls[0].ops[0].value, [{
    id: 'mixed', input: ['text', 'audio', 'image'], custom: { keep: true },
  }])
})

test('does not mutate another provider or a missing company model', async () => {
  const { api, calls } = apiWith([{ id: 'known' }])

  assert.deepEqual(await multimodal.setCompanyGatewayModelImageInput(api, 'missing', true), { error: '未找到公司网关模型配置。' })
  assert.equal(calls.length, 0)
})

test('returns the settings rejection so the picker can restore and show it', async () => {
  const api = {
    settings: {
      describe: async () => ({ result: { ok: true, value: { namespaces: [{
        ns: 'llm-pi-ai', value: { providers: { 'annto-company-gateway': { models: [{ id: 'vision' }] } } },
      }] } } }),
      mutate: async () => ({ result: { ok: false, error: { message: '配置已被其他窗口修改。' } } }),
    },
  }

  assert.deepEqual(await multimodal.setCompanyGatewayModelImageInput(api, 'vision', true), {
    error: '配置已被其他窗口修改。',
  })
})
