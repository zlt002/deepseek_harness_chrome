import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('knowledge scope state follows the AccrUI session and remember precedence', async () => {
  const background = await source('entrypoints/background.ts')
  assert.match(background, /interface KnowledgeScopeRecord \{ scope: KnowledgeScope; enabled: boolean \}/)
  assert.match(background, /chrome\.storage\.local\.get\(KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY\)/)
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY\]/)
  assert.match(background, /scopes\[request\.harnessSessionId\] \?\? \(request\.harnessParentSessionId === undefined \? undefined : scopes\[request\.harnessParentSessionId\]\)/)
  assert.match(background, /if \(!record\.enabled\) throw new Error\('knowledge_query_disabled'\)/)
})

test('knowledge login opens the AccrUI login page and automatically rechecks', async () => {
  const [background, sidepanel] = await Promise.all([
    source('entrypoints/background.ts'),
    source('entrypoints/sidepanel/main.tsx'),
  ])
  assert.match(background, /const KNOWLEDGE_LOGIN_URL = 'https:\/\/wb-uat\.annto\.com\/'/)
  assert.match(background, /chrome\.tabs\.create\(\{ url: KNOWLEDGE_LOGIN_URL, active: true \}\)/)
  assert.match(background, /if \(knowledgeProxyConfig === undefined\) await startHarnessForSettings\(\)/)
  assert.match(sidepanel, /knowledgeLoginAttemptsRef\.current < 15/)
  assert.match(sidepanel, /value\.type === 'harness-disconnected'\) \{ void connect\(\) \}/)
  assert.match(sidepanel, /window\.setTimeout\([\s\S]*2_000\)/)
  assert.match(sidepanel, /serviceState !== 'ready'/)
})
