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
  assert.match(root, /IconSkillOutline16/)
  assert.match(root, /id === 'accrui-skills'/)
  assert.match(root, /sidePanel=\{compact \|\| !wide\}/)
  assert.match(root, /data-surface=\{sidePanel \? 'sidepanel' : 'desktop'\}/)
  assert.match(css, /\.panel\[data-surface='sidepanel'\] \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?border-radius: 0;/)
  assert.match(css, /\.panel\[data-surface='sidepanel'\][\s\S]*?\.navList \{[\s\S]*?flex-direction: row;/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.panel \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?border-radius: 0;/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.navList \{[\s\S]*?flex-direction: row;/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.navLabel \{[\s\S]*?display: none;/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.navCell\.active \.navLabel \{[\s\S]*?display: inline;/)
  assert.match(css, /\.actions \{[\s\S]*?white-space: nowrap;/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.navTitle \{[^}]*display: none;/)
  assert.match(css, /\.panel \{[^}]*min-height: 0;/)
  assert.match(css, /\.options \{[^}]*overflow-y: auto;/)
  assert.match(root, /className=\{css\.actions\}[\s\S]*?className=\{css\.close\}/)
  assert.match(root, /data-testid="settings-overlay"/)
  assert.match(root, /data-testid="settings-nav"/)
  assert.match(root, /data-testid="settings-header"/)
  assert.match(root, /data-testid="settings-options"/)
  assert.doesNotMatch(index + root, /upstream\/deepseek-harness/)
})
