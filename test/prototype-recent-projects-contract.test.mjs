import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Side Panel exposes recent Prototype Studio projects through the trusted background boundary', async () => {
  const sidepanel = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(sidepanel, /prototype-studio-recent\/v1/)
  assert.match(sidepanel, /prototype-studio-open-recent\/v1/)
  assert.match(sidepanel, /最近原型/)
  assert.match(sidepanel, /恢复后编辑/)
  assert.match(background, /request\.type === 'prototype-studio-recent\/v1'/)
  assert.match(background, /isSidePanelSender\(sender\)/)
  assert.match(background, /request\.type === 'prototype-studio-open-recent\/v1'/)
  assert.match(background, /openRecentPrototypeStudio/)
  assert.doesNotMatch(background.slice(background.indexOf('type RecentPrototypeStudio'), background.indexOf('async function prototypeStudioAuthorization')), /capability|privateKey|knowledgeProxyToken/)
})
