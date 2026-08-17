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
