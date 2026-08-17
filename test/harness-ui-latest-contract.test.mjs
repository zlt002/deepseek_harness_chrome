import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const productRoot = path.resolve('.generated/harness-product')
const subagentPluginRoot = path.resolve('packages/harness-ui-subagent-compact')
const sessionLogCopyPluginRoot = path.resolve('packages/harness-ui-session-log-copy')

async function source(relativePath) {
  return readFile(path.join(productRoot, relativePath), 'utf8')
}

async function subagentPluginSource(relativePath) {
  return readFile(path.join(subagentPluginRoot, relativePath), 'utf8')
}

async function sessionLogCopyPluginSource(relativePath) {
  return readFile(path.join(sessionLogCopyPluginRoot, relativePath), 'utf8')
}

test('materialized Harness preserves the latest compact product UI contracts', async () => {
  const [conversation, knowledgeScope, settings, settingsCss, subagent, sessionLogCopy] = await Promise.all([
    source('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx'),
    source('packages/client/ui-knowledge-scope/src/client/KnowledgeScopeControl.tsx'),
    source('packages/client/ui-settings-general/src/client/SettingsRoot.tsx'),
    source('packages/client/ui-settings-general/src/client/SettingsRoot.module.css'),
    subagentPluginSource('src/client/CompactSubagentAction.tsx'),
    sessionLogCopyPluginSource('src/client/controller.ts'),
  ])

  const scopeSeat = conversation.indexOf("renderSlot('conversation.composer.above', zone)")
  const inputSeat = conversation.indexOf('{inputBar}')
  assert.ok(scopeSeat >= 0 && inputSeat > scopeSeat, 'knowledge/code scope must stay above the input card')
  assert.match(knowledgeScope, /PropsRuntime<'conversation\.composer\.above'>/)

  assert.match(settings, /quickActions\.filter\(action => action\.id !== 'conversation'\)/)
  assert.match(settingsCss, /@media \(max-width: 999px\)[\s\S]*?\.panel \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;/)
  assert.match(settingsCss, /@media \(max-width: 999px\)[\s\S]*?\.navList \{[\s\S]*?flex-direction: row;/)

  assert.match(subagent, /PropsRuntime<'sidebar\.compact\.action'>/)
  assert.match(subagent, /openChild/)
  assert.match(sessionLogCopy, /includeDescendants', 'false'/)
  assert.match(sessionLogCopy, /unzipSync/)
  await assert.rejects(
    source('packages/client/ui-subagent/src/client/CompactSubagentAction.tsx'),
    error => error?.code === 'ENOENT',
    'compact subagent controls must stay outside the official ui-subagent package',
  )
})
