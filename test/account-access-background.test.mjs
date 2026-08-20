import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')

test('account access keeps local logout separate from company browser cookies', () => {
  assert.match(source, /ACCOUNT_LOCAL_SIGN_OUT_STORAGE_KEY/)
  assert.match(source, /setAccountLocallySignedOut\(true\)/)
  assert.doesNotMatch(source, /chrome\.cookies\.(?:remove|set)/)
})

test('logout invalidates protected continuation and active queries', () => {
  assert.match(source, /for \(const controller of activeKnowledgeQueries\.values\(\)\) controller\.abort\(\)/)
  assert.match(source, /remove\(KNOWLEDGE_SESSION_STORAGE_KEY\)/)
})

test('knowledge and code connector paths enforce account access in the background', () => {
  const selected = source.indexOf('async function respondToSelectedSourceScope')
  const query = source.indexOf('async function respondToKnowledge')
  assert.ok(selected >= 0 && source.indexOf('await assertAccountAccessForProtectedSource()', selected) > selected)
  assert.ok(query >= 0 && source.indexOf('await assertAccountAccessForProtectedSource()', query) > query)
})

test('account access exposes the personal-key company gateway flow', () => {
  assert.match(source, /modelMode: 'company-pending'/)
  assert.match(source, /可使用个人 Key 配置公司网关模型/)
  assert.match(source, /company-gateway-probe\/v1/)
})
