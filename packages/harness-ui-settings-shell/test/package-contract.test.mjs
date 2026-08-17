import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Settings shell is product-owned and composes official settings slots', async () => {
  const [manifest, index, root, css] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/SettingsRoot.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-settings-shell/)
  assert.match(index, /settings\.presentation/)
  assert.match(root, /settings\.section/)
  assert.match(index, /select: presentation => presentation/)
  assert.match(root, /quickActions\.filter\(action => action\.id !== 'conversation'\)/)
  assert.match(root, /IconEllipsisOutline16/)
  assert.match(root, /compact\s*\?\s*<IconEllipsisOutline16/)
  assert.doesNotMatch(root, /renderSlot\('settings\.trigger',\s*compact/)
  assert.match(css, /\.compactMoreIcon\s*\{\s*transform:\s*rotate\(90deg\)/)
  assert.match(root, /settings\.onboarding/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.panel \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;/)
  assert.doesNotMatch(index + root, /upstream\/deepseek-harness/)
})
