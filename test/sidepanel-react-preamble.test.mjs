import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('sidepanel bootstraps React Refresh when WXT serves its generated HTML', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /^import '@vitejs\/plugin-react\/preamble'\n/m)
  assert.match(source, /ReactDOM\.createRoot\(document\.getElementById\('root'\)!\)/)
})
