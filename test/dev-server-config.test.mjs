import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJsonUrl = new URL('../package.json', import.meta.url)
const extensionPackageJsonUrl = new URL('../apps/chrome-extension/package.json', import.meta.url)
const wxtConfigUrl = new URL('../apps/chrome-extension/wxt.config.ts', import.meta.url)
const sidepanelHtmlUrl = new URL('../apps/chrome-extension/entrypoints/sidepanel/index.html', import.meta.url)
const sidepanelSourceUrl = new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url)
const prototypeDraftUrls = [
  new URL('../apps/chrome-extension/entrypoints/prototype-studio/design-spec-draft.ts', import.meta.url),
  new URL('../apps/chrome-extension/entrypoints/prototype-studio/product-brief-draft.ts', import.meta.url),
]

test('pnpm dev uses a dedicated port instead of the AccrUI dev server port', async () => {
  const [packageJson, extensionPackageJson] = await Promise.all([
    readFile(packageJsonUrl, 'utf8').then((contents) => JSON.parse(contents)),
    readFile(extensionPackageJsonUrl, 'utf8').then((contents) => JSON.parse(contents)),
  ])

  assert.match(packageJson.scripts.dev, /node\s+scripts\/prepare-dev-port\.mjs/)
  assert.match(packageJson.scripts.dev, /pnpm\s+--dir\s+apps\/chrome-extension\s+run\s+dev/)
  assert.match(extensionPackageJson.scripts.dev, /--port\s+3101/)
})

test('WXT development config rejects a busy port instead of falling back to a CSP-blocked origin', async () => {
  const wxtConfig = await readFile(wxtConfigUrl, 'utf8')

  assert.match(wxtConfig, /host:\s*'127\.0\.0\.1'/)
  assert.match(wxtConfig, /origin:\s*'127\.0\.0\.1'/)
  assert.match(wxtConfig, /strictPort:\s*true/)
})

test('WXT development config prebundles Markdown Review entry dependencies', async () => {
  const wxtConfig = await readFile(wxtConfigUrl, 'utf8')

  for (const dependency of ['react-markdown', 'rehype-sanitize', 'remark-gfm', 'mermaid']) {
    assert.match(wxtConfig, new RegExp(`include:\\s*\\[[\\s\\S]*['"]${dependency}['"][\\s\\S]*\\]`))
  }
})

test('WXT development keeps the local Prototype Studio startup guard in the loaded extension output', async () => {
  const wxtConfig = await readFile(wxtConfigUrl, 'utf8')

  assert.match(wxtConfig, /prototype-startup-guard\.js/)
  assert.match(wxtConfig, /server\.watcher\.add\(startupGuardSource\)/)
  assert.match(wxtConfig, /copyFile\(startupGuardSource, startupGuardTarget\)/)
})

test('Prototype Studio draft helpers do not trigger the reserved WXT storage auto-import', async () => {
  const sources = await Promise.all(prototypeDraftUrls.map(url => readFile(url, 'utf8')))

  for (const source of sources) {
    assert.doesNotMatch(source, /\bstorage\s*:\s*DraftStorage\b/)
  }
})

test('Chrome extension uses ACCRUI consistently for user-visible branding', async () => {
  const [wxtConfig, sidepanelHtml, sidepanelSource] = await Promise.all([
    readFile(wxtConfigUrl, 'utf8'),
    readFile(sidepanelHtmlUrl, 'utf8'),
    readFile(sidepanelSourceUrl, 'utf8'),
  ])

  assert.match(wxtConfig, /name:\s*'ACCRUI'/)
  assert.match(wxtConfig, /description:\s*'Use ACCRUI from a Chrome side panel\.'/)
  assert.match(wxtConfig, /default_title:\s*'Open ACCRUI'/)
  assert.match(sidepanelHtml, /<title>ACCRUI<\/title>/)
  assert.match(sidepanelSource, /title="ACCRUI Web UI"/)
  assert.match(sidepanelSource, /正在启动 ACCRUI…/)
  assert.doesNotMatch(sidepanelSource, /DeepSeek Harness/)
})
