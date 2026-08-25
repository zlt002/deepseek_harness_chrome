import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Side Panel exposes recent Prototype Studio projects through the trusted background boundary', async () => {
  const [sidepanel, styles] = await Promise.all([
    readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/style.css', import.meta.url), 'utf8'),
  ])
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(sidepanel, /prototype-studio-recent\/v1/)
  assert.match(sidepanel, /prototype-studio-open-recent\/v1/)
  assert.match(sidepanel, /open-recent-prototypes\/v1/)
  assert.match(sidepanel, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(sidepanel, /value\.nonce !== frameNonce/)
  assert.match(sidepanel, /setRecentPrototypesOpen\(true\)[\s\S]*void loadRecentPrototypes\(\)/)
  assert.match(sidepanel, /aria-label="关闭最近原型"/)
  assert.doesNotMatch(sidepanel, /recent-prototypes-trigger/)
  assert.match(styles, /\.recent-prototypes-popover\s*\{[^}]*top:\s*52px[^}]*right:\s*12px/s)
  assert.doesNotMatch(styles, /\.recent-prototypes-trigger/)
  assert.match(sidepanel, /最近原型/)
  assert.match(sidepanel, /在当前对话继续/)
  assert.match(background, /request\.type === 'prototype-studio-recent\/v1'/)
  assert.match(background, /isSidePanelSender\(sender\)/)
  assert.match(background, /request\.type === 'prototype-studio-open-recent\/v1'/)
  assert.match(background, /openRecentPrototypeStudio/)
  assert.doesNotMatch(background.slice(background.indexOf('type RecentPrototypeStudio'), background.indexOf('async function prototypeStudioAuthorization')), /capability|privateKey|knowledgeProxyToken/)
})
