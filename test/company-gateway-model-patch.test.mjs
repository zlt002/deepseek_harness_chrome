import assert from 'node:assert/strict'
import test from 'node:test'
import { companyGatewayModelPatch } from '../apps/native-server/src/harness-process.mjs'

test('the product retires the official DeepSeek route without hardcoding a company model catalog', () => {
  const patch = companyGatewayModelPatch()
  assert.match(patch, /id: llm-deepseek\n  disabled: true/)
  assert.doesNotMatch(patch, /annto-company-gateway|deepseek-v4-flash|providers:/)
})
