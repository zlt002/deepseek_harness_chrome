import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

async function loadBridge() {
  const source = await readFile(new URL('../packages/harness-ui-settings-shell/src/client/release-update-bridge.ts', import.meta.url), 'utf8')
  const output = await build({ stdin: { contents: source, loader: 'ts', resolveDir: new URL('../packages/harness-ui-settings-shell/src/client/', import.meta.url).pathname }, bundle: true, format: 'esm', platform: 'node', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}

test('bridge waits for Native cancellation confirmation and settles a download cancellation once', async () => {
  const { createReleaseUpdateBridge } = await loadBridge()
  const sent = []
  const parent = { postMessage: message => sent.push(message) }
  const bridge = createReleaseUpdateBridge('nonce', 'chrome-extension://test')
  const controller = new AbortController()
  const promise = bridge.request('prepare', { version: '1.1.81', sha256: 'a'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }, parent, controller.signal)
  const requestId = sent[0].requestId
  controller.abort()
  assert.deepEqual(sent.map(message => message.action), ['prepare', 'cancel'])
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-failed/v1', nonce: 'nonce', requestId, error: '在线更新已取消' } }, parent), true)
  await assert.rejects(promise, /已取消/)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-failed/v1', nonce: 'nonce', requestId, error: 'online update cancelled twice' } }, parent), false)
})

test('bridge keeps the original prepare pending after go is too late to cancel', async () => {
  const { createReleaseUpdateBridge } = await loadBridge()
  const sent = []
  const parent = { postMessage: message => sent.push(message) }
  const bridge = createReleaseUpdateBridge('nonce', 'chrome-extension://test')
  const controller = new AbortController()
  const promise = bridge.request('prepare', { version: '1.1.81', sha256: 'a'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }, parent, controller.signal)
  const requestId = sent[0].requestId
  controller.abort()
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-cancel-too-late/v1', nonce: 'nonce', requestId } }, parent), true)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-result/v1', nonce: 'nonce', requestId, update: { available: true, version: '1.1.81', sha256: 'a'.repeat(64) } } }, parent), true)
  assert.equal((await promise).version, '1.1.81')
})
