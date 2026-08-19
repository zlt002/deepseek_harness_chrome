import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const productRoot = path.resolve(process.env.DSH_ROOT?.trim() || '.generated/harness-product')
const subagentPluginRoot = path.resolve('packages/harness-ui-subagent-compact')
const sessionLogCopyPluginRoot = path.resolve('packages/harness-ui-session-log-copy')
const knowledgeScopePluginRoot = path.resolve('packages/harness-ui-knowledge-scope')
const settingsShellPluginRoot = path.resolve('packages/harness-ui-settings-shell')

async function source(relativePath) {
  return readFile(path.join(productRoot, relativePath), 'utf8')
}

async function subagentPluginSource(relativePath) {
  return readFile(path.join(subagentPluginRoot, relativePath), 'utf8')
}

async function sessionLogCopyPluginSource(relativePath) {
  return readFile(path.join(sessionLogCopyPluginRoot, relativePath), 'utf8')
}

async function knowledgeScopePluginSource(relativePath) {
  return readFile(path.join(knowledgeScopePluginRoot, relativePath), 'utf8')
}

async function settingsShellPluginSource(relativePath) {
  return readFile(path.join(settingsShellPluginRoot, relativePath), 'utf8')
}

test('materialized Harness preserves the latest compact product UI contracts', async () => {
  const [conversation, knowledgeScope, selectedSourceToolview, selectedSourceToolviewIndex, settings, settingsCss, officialSettings, subagent, sessionLogCopy] = await Promise.all([
    source('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx'),
    knowledgeScopePluginSource('src/client/KnowledgeScope.tsx'),
    knowledgeScopePluginSource('src/client/SelectedSourceScopeToolRow.tsx'),
    knowledgeScopePluginSource('src/client/index.ts'),
    settingsShellPluginSource('src/client/SettingsRoot.tsx'),
    settingsShellPluginSource('src/client/SettingsRoot.module.css'),
    source('packages/client/ui-settings-general/src/client/SettingsRoot.tsx'),
    subagentPluginSource('src/client/CompactSubagentAction.tsx'),
    sessionLogCopyPluginSource('src/client/controller.ts'),
  ])

  const scopeSeat = conversation.indexOf("renderSlot('conversation.composer.above', zone)")
  const composerSeat = conversation.indexOf('{composer}', scopeSeat)
  assert.match(conversation, /\{ fallback: inputBar, overlay: true \}/)
  assert.ok(scopeSeat >= 0 && composerSeat > scopeSeat, 'knowledge/code scope must stay above the input card')
  assert.match(knowledgeScope, /PropsRuntime<'conversation\.composer\.above'>/)
  assert.match(selectedSourceToolviewIndex, /mcp__chrome__selected_source_scope/)
  assert.match(selectedSourceToolview, /已选远程范围/)
  assert.match(selectedSourceToolview, /if \(failed\) setExpanded\(true\)/)
  assert.match(selectedSourceToolview, /<MarkdownText text=\{text\} streaming=\{running\} \/>/)
  await assert.rejects(
    source('packages/client/ui-knowledge-scope/package.json'),
    error => error?.code === 'ENOENT',
    'knowledge scope must stay outside the official Harness package tree',
  )

  assert.match(settings, /quickActions\.filter\(action =>\s*action\.id !== 'conversation' && !\(blankSession && action\.id === 'trajectory'\)\)/)
  assert.match(settings, /IconSkillOutline16/)
  assert.match(settingsCss, /\.panel \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?border-radius: 0;/)
  assert.match(settingsCss, /\.navList \{[\s\S]*?flex-direction: row;/)
  assert.doesNotMatch(
    officialSettings,
    /quickActions\.filter\(action => action\.id !== 'conversation'\)/,
    'product Settings presentation must stay outside the official Harness package tree',
  )

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
