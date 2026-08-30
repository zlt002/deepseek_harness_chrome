import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('knowledge scope routing depends on the deep transport module rather than local transport helpers', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(source, /createKnowledgeTransport/)
  assert.match(source, /knowledgeTransport\.loadCatalog\(\)/)
  assert.match(source, /knowledgeTransport\.query\(\{/)
  assert.match(source, /knowledgeTransport\.serviceState\(error\)/)
  assert.doesNotMatch(source, /function executeKnowledgeQuery/)
  assert.doesNotMatch(source, /function knowledgeFetch/)
})
