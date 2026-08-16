import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJsonUrl = new URL('../package.json', import.meta.url)
const wxtConfigUrl = new URL('../apps/chrome-extension/wxt.config.ts', import.meta.url)

test('pnpm dev uses a dedicated port instead of the AccrUI dev server port', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'))

  assert.match(packageJson.scripts.dev, /node\s+scripts\/prepare-dev-port\.mjs/)
  assert.match(packageJson.scripts.dev, /pnpm\s+--dir\s+apps\/chrome-extension\s+run\s+dev/)
})

test('WXT development config rejects a busy port instead of falling back to a CSP-blocked origin', async () => {
  const wxtConfig = await readFile(wxtConfigUrl, 'utf8')

  assert.match(wxtConfig, /dev:\s*{\s*server:\s*{\s*strictPort:\s*true\s*,?\s*}\s*,?\s*}/s)
})
