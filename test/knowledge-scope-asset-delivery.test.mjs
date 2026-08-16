import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const publicFile = (path) => readFile(new URL(`../public/${path}`, import.meta.url), 'utf8')
const harnessRuntimeFile = (path) => readFile(new URL(`../../deepseek-harness/${path}`, import.meta.url), 'utf8')

test('synced Harness assets deliver the knowledge-scope plugin into its composer slot', async () => {
  const [boot, conversation, knowledgeScope, runtimeConversation] = await Promise.all([
    publicFile('harness/boot.js'),
    publicFile('plugins/@deepseek-ai/dsh-client-ui-conversation/client.js'),
    publicFile('plugins/@deepseek-ai/dsh-client-ui-knowledge-scope/client.js'),
    harnessRuntimeFile('packages/client/ui-conversation/lib/client.js'),
  ])

  assert.match(boot, /@deepseek-ai\/dsh-client-ui-knowledge-scope/)
  assert.match(conversation, /conversation\.composer\.above/)
  assert.match(runtimeConversation, /conversation\.composer\.above/)
  assert.match(knowledgeScope, /conversation\.composer\.above/)
  assert.match(knowledgeScope, /knowledge-scope-control/)
})
