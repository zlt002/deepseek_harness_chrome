import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('knowledge scope state follows the AccrUI session and remember precedence', async () => {
  const background = await source('apps/chrome-extension/entrypoints/background.ts')
  assert.match(background, /interface KnowledgeScopeRecord \{ scope: KnowledgeScope; enabled: boolean; notice\?: string \}/)
  assert.match(background, /legacyKnowledgeScopeKey/)
  assert.match(background, /migrateLegacyKnowledgeScope/)
  assert.match(background, /notice: record\?\.notice/)
  assert.match(background, /chrome\.storage\.local\.get\(\[KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY, 'knowledge-query:enabled-preference'\]\)/)
  assert.match(background, /function knowledgeSessionStorage/)
  assert.match(background, /knowledgeSessionStorage\(\)\?\.get\(KNOWLEDGE_SESSION_STORAGE_KEY\)/)
  assert.match(background, /knowledgeSessionStorage\(\)\?\.set\(\{ \[KNOWLEDGE_SESSION_STORAGE_KEY\]: sessions \}\)/)
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY\]/)
  assert.match(background, /function mutateKnowledgeScopes/)
  assert.match(background, /const current = scopes\[request\.harnessSessionId\]/)
  assert.match(background, /const inherited = request\.harnessParentSessionId === undefined \? undefined : scopes\[request\.harnessParentSessionId\]/)
  assert.match(background, /await clearKnowledgeScopeStorage\(\)/)
  assert.match(background, /if \(!record\.enabled\) throw new Error\('知识查询开关已关闭/)
  assert.match(background, /function selectedSourceScopeEcho/)
  assert.match(background, /tool: 'selected_source_scope'/)
  assert.match(background, /function pruneScope/)
  assert.match(background, /createKnowledgeTransport/)
  assert.match(background, /setInterval\(\(\) => \{ void chrome\.runtime\.getPlatformInfo/)
})

test('knowledge login opens the AccrUI login page and automatically rechecks', async () => {
  const [background, sidepanel] = await Promise.all([
    source('apps/chrome-extension/entrypoints/background.ts'),
    source('apps/chrome-extension/entrypoints/sidepanel/main.tsx'),
  ])
  assert.match(background, /const KNOWLEDGE_LOGIN_URL = 'https:\/\/wb-uat\.annto\.com\/'/)
  assert.match(background, /chrome\.tabs\.create\(\{ url: KNOWLEDGE_LOGIN_URL, active: true \}\)/)
  assert.match(background, /if \(!knowledgeTransport\.hasProxy\(\)\) await startHarnessForSettings\(\)/)
  assert.match(sidepanel, /knowledgeLoginAttemptsRef\.current < 15/)
  assert.match(sidepanel, /value\.type === 'harness-disconnected'\) \{ void connect\(\) \}/)
  assert.match(sidepanel, /window\.setTimeout\([\s\S]*2_000\)/)
  assert.match(sidepanel, /serviceState !== 'ready'/)
})

test('selected-source SSE content flows into dedicated Tool call rows', async () => {
  const [background, transport, sidepanel, protocol, plugin, toolRow, strip] = await Promise.all([
    source('apps/chrome-extension/entrypoints/background.ts'),
    source('apps/chrome-extension/entrypoints/background/knowledge-transport.ts'),
    source('apps/chrome-extension/entrypoints/sidepanel/main.tsx'),
    source('packages/harness-ui-knowledge-scope/src/client/protocol.js'),
    source('packages/harness-ui-knowledge-scope/src/client/index.ts'),
    source('packages/harness-ui-knowledge-scope/src/client/RemoteSearchToolRow.tsx'),
    source('packages/harness-ui-knowledge-scope/src/client/KnowledgeScope.tsx'),
  ])
  assert.match(transport, /onProgress\?\.\(\{ chars: content\.length, content,/)
  assert.match(background, /harnessParentSessionId: request\.harnessParentSessionId/)
  assert.match(background, /phase === 'streaming' && content !== '' && process === undefined && now - lastProgressAt < 120/)
  assert.match(background, /broadcast\('done', executed\.result\.answer\.length, executed\.result\.answer, 'done', lastProcess\)/)
  assert.match(sidepanel, /search-progress\/v1/)
  assert.match(sidepanel, /harnessParentSessionId: value\.harnessParentSessionId/)
  assert.match(sidepanel, /search-progress-snapshot\/v1/)
  assert.match(sidepanel, /replaySearchProgress/)
  assert.match(protocol, /value\.content\.length <= 16_000/)
  assert.match(plugin, /'search_selected_remote_code', 'mcp__chrome__code_search', 'search_selected_knowledge', 'mcp__chrome__knowledge_search'/)
  assert.match(toolRow, /<MarkdownText text=\{text\} streaming=\{active\}/)
  assert.match(toolRow, /item\.harnessSessionId === sessionId \|\| item\.harnessParentSessionId === sessionId/)
  assert.match(toolRow, /item\.requestId === binding\.requestId/)
  assert.match(toolRow, /远程仓库正在检索，首个结果还没返回/)
  assert.match(toolRow, /已等待 \$\{seconds\} 秒/)
  assert.match(toolRow, /远程检索过程/)
  assert.match(toolRow, /processLog/)
  assert.match(toolRow, /friendlySearchError/)
  assert.match(transport, /emit\('connected'\)/)
  assert.match(transport, /function processEvent/)
  assert.match(transport, /payload\.type === 'log'/)
  assert.match(transport, /function appendProcess/)
  assert.match(background, /progress\.process/)
  assert.match(transport, /function describeTransportError/)
  assert.match(transport, /function isStream/)
  assert.match(toolRow, /friendlySearchError/)
  assert.match(sidepanel, /typeof value\.process === 'string'/)
  assert.doesNotMatch(strip, /已返回/)
})

test('the extension waits for the nonce-bound Harness frame readiness signal before replaying state', async () => {
  const sidepanel = await source('apps/chrome-extension/entrypoints/sidepanel/main.tsx')
  assert.match(sidepanel, /frameReadyRef\.current/)
  assert.match(sidepanel, /value\.type === 'browser-target-ready\/v1'[\s\S]*frameReadyRef\.current = true[\s\S]*sendBrowserTargetSnapshot\(\)[\s\S]*replaySearchProgress\(\)/)
  assert.match(sidepanel, /if \(frameOrigin === undefined \|\| !frameReadyRef\.current\) return/)
  assert.doesNotMatch(sidepanel, /onLoad=\{\(\) => \{ sendBrowserTargetSnapshot\(\); replaySearchProgress\(\) \}\}/)
})

test('reconnecting Harness accepts the remounted knowledge scope command sequence again', async () => {
  const sidepanel = await source('apps/chrome-extension/entrypoints/sidepanel/main.tsx')

  assert.match(sidepanel, /const connect = useCallback\(async \(\) => \{[\s\S]*knowledgeCommandSequenceRef\.current = 0[\s\S]*knowledgeRequestSequenceBySessionRef\.current\.clear\(\)[\s\S]*setStatus\('starting'\)[\s\S]*requestHarness\(\)/)
  assert.match(sidepanel, /value\.type === 'knowledge-scope-command\/v1'[\s\S]*value\.sequence <= knowledgeCommandSequenceRef\.current[\s\S]*knowledgeCommandSequenceRef\.current = value\.sequence/)
})
