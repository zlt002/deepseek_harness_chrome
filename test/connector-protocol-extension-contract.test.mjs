import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const protocolUrl = new URL('../apps/native-server/src/connector-protocol.mjs', import.meta.url)
const backgroundUrl = new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url)

test('Connector protocol is browser-safe and the Extension imports it instead of redefining the wire contract', async () => {
  const [protocolSource, backgroundSource] = await Promise.all([
    readFile(protocolUrl, 'utf8'),
    readFile(backgroundUrl, 'utf8'),
  ])

  assert.doesNotMatch(protocolSource, /from\s+['"]node:/)
  assert.match(backgroundSource, /from ['"]\.\.\/\.\.\/native-server\/src\/connector-protocol\.mjs['"]/)

  for (const localDefinition of [
    'CONNECTOR_REQUEST',
    'CONNECTOR_RESPONSE',
    'CONNECTOR_CANCEL',
    'BrowserTarget',
    'ConnectorCorrelation',
    'UnavailableBrowserTarget',
    'isBrowserTarget',
    'sameBrowserTarget',
    'isUnavailableBrowserTarget',
    'sameBrowserTargetList',
    'sameUnavailableBrowserTargetList',
  ]) {
    assert.doesNotMatch(backgroundSource, new RegExp(`(?:const|function|interface)\\s+${localDefinition}\\b`))
  }

  const bundled = await build({
    entryPoints: [protocolUrl.pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  const browserProtocol = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}#${Date.now()}`)
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://docs.example.test/a' }
  const correlation = { requestId: 'request-1', runId: 'run-1', generation: 'generation-1' }

  assert.equal(browserProtocol.validBrowserTarget(target), true)
  assert.equal(browserProtocol.validBrowserTargetBinding(target, [target], []), true)
  assert.equal(browserProtocol.validConnectorResponseEnvelope({ type: browserProtocol.CONNECTOR_RESPONSE, ...correlation, result: {} }), true)
})
