import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('conversation shell seam keeps product quick actions outside the official patch', async () => {
  const [generic, product] = await Promise.all([
    text('../upstream-contributions/0012-conversation-shell-responsive-seam.patch'),
    text('../packages/harness-ui-conversation-shell/src/client/index.ts'),
  ])

  assert.match(generic, /ConversationViewState/)
  assert.match(generic, /ComposerOverlayProvider/)
  assert.match(generic, /conversation\.presentation/)
  assert.match(generic, /ConversationPresentationOwnerProps/)
  assert.match(generic, /DefaultConversationPresentation/)
  // The owner seam may adapt official conversation/model components and their
  // CSS to keep the complete composer chain at the root footer. Product quick
  // actions must still be registered only by the out-of-tree presentation
  // plugin, never by the generic patch.
  assert.doesNotMatch(generic, /settingsQuickActions/)
  assert.doesNotMatch(generic, /id:\s*'(?:trajectory|conversation)'/)
  assert.doesNotMatch(generic, /compact trajectory action|compact conversation action/)
  assert.match(product, /id: 'trajectory'/)
  assert.match(product, /id: 'conversation'/)
})

test('Composer and transcript retain separate layout responsibilities', async () => {
  const generic = await text('../upstream-contributions/0012-conversation-shell-responsive-seam.patch')
  assert.match(generic, /root-level footer/)
  assert.match(generic, /data-composer-overlay-surface/)
  assert.match(generic, /conversationViewState/)
})

test('composer takeover hides only the input card and can collapse the question', async () => {
  const seam = await text('../upstream-contributions/0016-composer-takeover-keeps-above-strip.patch')
  assert.match(seam, /fallback: inputBar/)
  assert.match(seam, /data-composer-stack/)
  assert.match(seam, /data-question-collapsed/)
  assert.doesNotMatch(seam, /AccrUI|accrui|选择代码库|选择知识范围/)
})
