import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the Chrome sidepanel iframe is bounded by the visible viewport', async () => {
  const css = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/style.css', import.meta.url), 'utf8')

  assert.match(css, /html, body, #root\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s)
  assert.match(css, /\.shell\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s)
  assert.match(css, /\.harness-frame-shell\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s)
  assert.match(css, /\.harness-frame\s*\{[^}]*display:\s*block[^}]*height:\s*100%[^}]*min-height:\s*0/s)
})

test('fullscreen return control belongs to the Harness header instead of tracking the directory drawer', async () => {
  const [css, source] = await Promise.all([
    readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(source, /workspaceDirectoryOpen|workspace-directory-open|workspace-review-directory-state\/v1/)
  assert.doesNotMatch(css, /\.harness-frame-shell-fullscreen\s*\{[^}]*\b(?:padding|margin|transform)(?:-[a-z]+)?\s*:/s)
  assert.doesNotMatch(css, /\.harness-frame-shell-fullscreen \.harness-frame\s*\{[^}]*\b(?:padding|margin|transform)(?:-[a-z]+)?\s*:/s)
  assert.doesNotMatch(css, /\.fullscreen-collapse|workspace-directory-open/)
})
