import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('production extension disables cross-world modulepreload without disabling module entry scripts', async () => {
  const config = await readFile(new URL('../apps/chrome-extension/wxt.config.ts', import.meta.url), 'utf8')
  assert.match(config, /'vite:build:extendConfig'/)
  assert.match(config, /config\.build\.modulePreload = false/)
  assert.doesNotMatch(config, /config\.build\.rollupOptions\s*=\s*\{\}/)
})
