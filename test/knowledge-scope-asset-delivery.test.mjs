import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { productUiPatch } from '../apps/native-server/src/harness-process.mjs'

const publicFile = (path) => readFile(new URL(`../apps/chrome-extension/public/${path}`, import.meta.url), 'utf8')

test('clean upstream defaults to the browser plugin until the generic knowledge seam is enabled', async () => {
  const cleanConversation = await readFile(new URL(
    '../upstream/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx',
    import.meta.url,
  ), 'utf8')

  assert.doesNotMatch(cleanConversation, /conversation\.composer\.above/)
  assert.match(productUiPatch({}), /@accrui\/harness-ui-browser-target/)
  assert.doesNotMatch(productUiPatch({}), /@accrui\/harness-ui-knowledge-scope/)
})

test('product Harness assets deliver both UI plugins through the generic composer seam', async () => {
  const [boot, browserTarget, knowledgeScope, productConversation] = await Promise.all([
    publicFile('harness/boot.js'),
    publicFile('plugins/@accrui/harness-ui-browser-target/client.js'),
    publicFile('plugins/@accrui/harness-ui-knowledge-scope/client.js'),
    readFile(new URL(
      '../.generated/harness-product/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx',
      import.meta.url,
    ), 'utf8'),
  ])

  assert.match(boot, /@accrui\/harness-ui-browser-target/)
  assert.match(boot, /@accrui\/harness-ui-knowledge-scope/)
  assert.match(browserTarget, /conversation\.input\.left/)
  assert.match(browserTarget, /conversation\.input\.overlay/)
  assert.match(productConversation, /conversation\.composer\.above/)
  assert.match(knowledgeScope, /conversation\.composer\.above/)
  assert.match(productUiPatch({ DSH_ENABLE_KNOWLEDGE_SCOPE_UI: '1' }), /@accrui\/harness-ui-knowledge-scope/)
  await access(new URL('../packages/harness-ui-knowledge-scope/lib/client.js', import.meta.url))
})
