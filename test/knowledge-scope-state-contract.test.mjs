import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('knowledge scope state follows the AccrUI session and remember precedence', async () => {
  const background = await source('apps/chrome-extension/entrypoints/background.ts')
  assert.match(background, /interface KnowledgeScopeRecord \{ scope: KnowledgeScope; enabled: boolean \}/)
  assert.match(background, /chrome\.storage\.local\.get\(KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY\)/)
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY\]/)
  assert.match(background, /scopes\[request\.harnessSessionId\] \?\? \(request\.harnessParentSessionId === undefined \? undefined : scopes\[request\.harnessParentSessionId\]\)/)
  assert.match(background, /if \(!record\.enabled\) throw new Error\('knowledge_query_disabled'\)/)
  assert.match(background, /function selectedSourceScopeEcho/)
  assert.match(background, /tool: 'selected_source_scope'/)
})

test('knowledge login opens the AccrUI login page and automatically rechecks', async () => {
  const [background, sidepanel] = await Promise.all([
    source('apps/chrome-extension/entrypoints/background.ts'),
    source('apps/chrome-extension/entrypoints/sidepanel/main.tsx'),
  ])
  assert.match(background, /const KNOWLEDGE_LOGIN_URL = 'https:\/\/wb-uat\.annto\.com\/'/)
  assert.match(background, /chrome\.tabs\.create\(\{ url: KNOWLEDGE_LOGIN_URL, active: true \}\)/)
  assert.match(background, /if \(knowledgeProxyConfig === undefined\) await startHarnessForSettings\(\)/)
  assert.match(sidepanel, /knowledgeLoginAttemptsRef\.current < 15/)
  assert.match(sidepanel, /value\.type === 'harness-disconnected'\) \{ void connect\(\) \}/)
  assert.match(sidepanel, /window\.setTimeout\([\s\S]*2_000\)/)
  assert.match(sidepanel, /serviceState !== 'ready'/)
})

test('selected-source SSE content flows into dedicated Tool call rows', async () => {
  const [background, sidepanel, protocol, plugin, toolRow, strip] = await Promise.all([
    source('apps/chrome-extension/entrypoints/background.ts'),
    source('apps/chrome-extension/entrypoints/sidepanel/main.tsx'),
    source('packages/harness-ui-knowledge-scope/src/client/protocol.js'),
    source('packages/harness-ui-knowledge-scope/src/client/index.ts'),
    source('packages/harness-ui-knowledge-scope/src/client/RemoteSearchToolRow.tsx'),
    source('packages/harness-ui-knowledge-scope/src/client/KnowledgeScope.tsx'),
  ])
  assert.match(background, /onProgress\?\.\(\{ chars: visualContent\.length, content: visualContent, eventType:/)
  assert.match(background, /harnessParentSessionId: request\.harnessParentSessionId/)
  assert.match(background, /phase === 'streaming' && now - lastProgressAt < 120/)
  assert.match(background, /broadcast\('done', executed\.result\.answer\.length, executed\.result\.answer\)/)
  assert.match(sidepanel, /search-progress\/v1/)
  assert.match(sidepanel, /harnessParentSessionId: value\.harnessParentSessionId/)
  assert.match(sidepanel, /search-progress-snapshot\/v1/)
  assert.match(sidepanel, /replaySearchProgress/)
  assert.match(protocol, /value\.content\.length <= 16_000/)
  assert.match(plugin, /'search_selected_remote_code', 'mcp__chrome__code_search', 'search_selected_knowledge', 'mcp__chrome__knowledge_search'/)
  assert.match(toolRow, /<MarkdownText text=\{text\} streaming=\{active\}/)
  assert.match(toolRow, /item\.harnessSessionId === sessionId \|\| item\.harnessParentSessionId === sessionId/)
  assert.match(toolRow, /item\.requestId === binding\.requestId/)
  assert.doesNotMatch(strip, /已返回/)
})
