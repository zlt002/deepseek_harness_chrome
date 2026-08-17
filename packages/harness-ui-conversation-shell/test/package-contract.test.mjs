import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Conversation shell is a product presentation plugin, not a second conversation controller', async () => {
  const [manifest, source] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-conversation-shell/)
  assert.match(source, /conversationViewState/)
  assert.match(source, /settingsQuickActions/)
  assert.match(source, /id: 'trajectory'/)
  assert.match(source, /id: 'conversation'/)
  assert.doesNotMatch(source, /createChatStore|ConversationController|defineStore/)
})
