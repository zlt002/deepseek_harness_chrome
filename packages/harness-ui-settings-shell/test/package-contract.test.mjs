import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'

const onboardingSource = await readFile(new URL('../src/client/onboarding.ts', import.meta.url), 'utf8')
const onboardingOutput = await build({
  stdin: { contents: onboardingSource, loader: 'ts', resolveDir: new URL('../src/client/', import.meta.url).pathname },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const onboarding = await import(`data:text/javascript;base64,${Buffer.from(onboardingOutput.outputFiles[0].text).toString('base64')}`)

test('company gateway onboarding replaces the official DeepSeek prompt without suppressing other steps', () => {
  const steps = [
    { id: 'welcome-notice', order: -100 },
    { id: 'accrui-company-gateway', order: -10 },
    { id: 'deepseek-official', order: 0 },
    { id: 'future-step', order: 10 },
  ]
  assert.deepEqual(onboarding.productOnboardingSteps(steps).map(step => step.id), [
    'welcome-notice', 'accrui-company-gateway', 'future-step',
  ])
  const stock = [{ id: 'welcome-notice', order: -100 }, { id: 'deepseek-official', order: 0 }]
  assert.equal(onboarding.productOnboardingSteps(stock), stock)
})

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
  assert.match(root, /action\.id !== 'conversation' && !\(blankSession && action\.id === 'trajectory'\)/)
  assert.match(root, /action\.requiresSession !== false && currentSessionId === undefined/)
  assert.match(root, /IconEllipsisOutline16/)
  assert.match(root, /compact\s*\?\s*<IconEllipsisOutline16/)
  assert.doesNotMatch(root, /renderSlot\('settings\.trigger',\s*compact/)
  assert.match(css, /\.compactMoreIcon\s*\{\s*transform:\s*rotate\(90deg\)/)
  assert.match(root, /settings\.onboarding/)
  assert.match(root, /productOnboardingSteps/)
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
  assert.match(css, /\.actions :global\(button\) \{[\s\S]*?max-width: 88px;[\s\S]*?text-overflow: ellipsis;/)
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.panel\[data-surface='sidepanel'\] \.actions :global\(button\),[\s\S]*?max-width: 64px;/)
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*?\.navTitle \{[^}]*display: none;/)
  assert.match(css, /\.panel \{[^}]*min-height: 0;/)
  assert.match(css, /\.options \{[^}]*overflow-y: auto;/)
  // Each settings slot is product content. A wide settings panel must not
  // leave a fixed-width island beside a section, and each section's actions
  // need the same responsive width budget as the rest of its content.
  assert.match(css, /\.options > :global\(\*\) \{[^}]*inline-size: 100% !important;[^}]*max-width: none !important;/)
  assert.match(css, /\.mergedModels \{[^}]*inline-size: 100%;[^}]*max-width: none;/)
  assert.match(css, /annto-company-gateway/)
  assert.match(root, /className=\{css\.actions\}[\s\S]*?className=\{css\.close\}/)
  assert.match(root, /data-testid="settings-overlay"/)
  assert.match(root, /data-testid="settings-nav"/)
  assert.match(root, /data-testid="settings-header"/)
  assert.match(root, /data-testid="settings-options"/)
  assert.doesNotMatch(index + root, /upstream\/deepseek-harness/)
  assert.doesNotMatch(index + root, /harness-ui-account-access/)
})

test('merged model settings give the nested section the complete content width', async () => {
  const css = await readFile(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8')
  assert.match(
    css,
    /\.mergedModels :global\(\[data-slot='settings\.section'\]\) > :global\(\*\) \{[^}]*inline-size: 100% !important;[^}]*max-width: none !important;/,
  )
})

test('settings sections inherit one page-title visual contract', async () => {
  const css = await readFile(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8')
  assert.match(css, /--accrui-settings-page-title-size: 20px;/)
  assert.match(css, /\.options :global\(\[data-slot='settings\.section'\]\) > :global\(\*\) > :global\(h2\) \{[^}]*font-size: var\(--accrui-settings-page-title-size\) !important;[^}]*line-height: var\(--accrui-settings-page-title-line-height\) !important;[^}]*font-weight: var\(--accrui-settings-page-title-weight\) !important;/)
  assert.doesNotMatch(css, /\.options :global\(\[data-slot='settings\.section'\] h2\)/)
})
