import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { productUiPatch } from '../apps/native-server/src/harness-process.mjs'

const publicFile = (path) => readFile(new URL(`../apps/chrome-extension/public/${path}`, import.meta.url), 'utf8')

test('product runtime always mounts knowledge scope through the generic seam', async () => {
  const cleanConversation = await readFile(new URL(
    '../upstream/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx',
    import.meta.url,
  ), 'utf8')

  assert.doesNotMatch(cleanConversation, /conversation\.composer\.above/)
  assert.match(productUiPatch({}), /@accrui\/harness-ui-browser-target/)
  assert.match(productUiPatch({}), /@accrui\/harness-ui-knowledge-scope/)
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
  assert.match(productUiPatch({}), /@accrui\/harness-ui-knowledge-scope/)
  await access(new URL('../packages/harness-ui-knowledge-scope/lib/client.js', import.meta.url))
})
