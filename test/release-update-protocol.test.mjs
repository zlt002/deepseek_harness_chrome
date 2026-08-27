import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { NativeHost } from '../apps/native-server/src/native-host.mjs'

async function loadBridge() {
  const source = await readFile(new URL('../packages/harness-ui-settings-shell/src/client/release-update-bridge.ts', import.meta.url), 'utf8')
  const output = await build({ stdin: { contents: source, loader: 'ts', resolveDir: new URL('../packages/harness-ui-settings-shell/src/client/', import.meta.url).pathname }, bundle: true, format: 'esm', platform: 'node', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}

test('Side Panel update command reaches Native Host and returns the verified release identity to the iframe bridge', async () => {
  const { createReleaseUpdateBridge } = await loadBridge()
  const host = new NativeHost({
    updateCheck: async () => ({ available: true, version: '1.1.76', sha256: 'a'.repeat(64), extensionId: 'cmgjacoohdgjedoekbdbhbelpmboankg' }),
    platform: 'win32',
    exit: () => {},
  })
  const nativeMessages = []
  host.send = message => nativeMessages.push(message)
  let hostHandling
  const parent = { postMessage: message => {
    if (message.type !== 'release-update-command/v1') return
    hostHandling = host.handle({ type: 'release-update-check', requestId: message.requestId })
  } }
  const bridge = createReleaseUpdateBridge('nonce', 'chrome-extension://test')
  const promise = bridge.request('check', parent)
  await hostHandling
  const response = nativeMessages.find(message => message.type === 'release_update_checked')
  assert.ok(response, 'Native Host should return a correlated release update response')
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-result/v1', nonce: 'nonce', requestId: response.requestId, update: response.update } }, parent), true)
  assert.deepEqual(await promise, { available: true, version: '1.1.76', sha256: 'a'.repeat(64), extensionId: 'cmgjacoohdgjedoekbdbhbelpmboankg' })
})

test('Native Host starts the detached updater before confirming a prepared update', async () => {
  let launched = false
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updatePrepare: async () => ({ version: '1.1.76', sha256: 'b'.repeat(64), extractRoot: 'C:\\temp\\package' }),
    updateLaunch: async () => { launched = true; return true },
  })
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-123')
  assert.equal(launched, true)
  assert.equal(messages.at(-1).type, 'release_update_prepared')
})

test('Native Host does not confirm or close when the detached updater cannot start', async () => {
  const exited = []
  const host = new NativeHost({
    platform: 'win32', exit: code => exited.push(code),
    updatePrepare: async () => ({ version: '1.1.76', sha256: 'b'.repeat(64), extractRoot: 'C:\\temp\\package' }),
    updateLaunch: async () => { throw new Error('powershell.exe is unavailable') },
  })
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-failed')
  assert.deepEqual(messages, [{ type: 'release_update_failed', requestId: 'request-prepare-failed', error: 'powershell.exe is unavailable' }])
  await new Promise(resolvePromise => setTimeout(resolvePromise, 30))
  assert.deepEqual(exited, [])
})

test('Native Host returns the persisted updater outcome when checking again', async () => {
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updateCheck: async () => ({ available: false, version: '1.1.80', sha256: 'c'.repeat(64) }),
    updateStatusRead: async () => ({ state: 'failed', version: '1.1.81', updatedAt: '2026-08-27T00:00:00.000Z', error: '安装内容不完整', logPath: '%TEMP%\\accr-ui-harness-install.log' }),
  })
  const messages = []; host.send = message => messages.push(message)
  await host.checkReleaseUpdate('request-status-123')
  assert.deepEqual(messages.at(-1), {
    type: 'release_update_checked', requestId: 'request-status-123',
    update: {
      available: false, version: '1.1.80', sha256: 'c'.repeat(64),
      lastUpdate: { state: 'failed', version: '1.1.81', updatedAt: '2026-08-27T00:00:00.000Z', error: '安装内容不完整', logPath: '%TEMP%\\accr-ui-harness-install.log' },
    },
  })
})
