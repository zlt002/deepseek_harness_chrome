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

function rememberCandidate(host, candidate) {
  const key = candidate.packageId === undefined
    ? `release\u0000${candidate.version}\u0000${candidate.sha256}\u0000${candidate.packageUrl}`
    : `package\u0000${candidate.packageId}\u0000${candidate.packageUrl}`
  host.releaseUpdateCandidates = new Map([[key, candidate]])
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
  const promise = bridge.request('check', undefined, parent)
  await hostHandling
  const response = nativeMessages.find(message => message.type === 'release_update_checked')
  assert.ok(response, 'Native Host should return a correlated release update response')
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-result/v1', nonce: 'nonce', requestId: response.requestId, update: response.update } }, parent), true)
  assert.deepEqual(await promise, { available: true, version: '1.1.76', sha256: 'a'.repeat(64), extensionId: 'cmgjacoohdgjedoekbdbhbelpmboankg' })
})

test('iframe bridge forwards an aborted update request as a correlated cancel command', async () => {
  const { createReleaseUpdateBridge } = await loadBridge()
  const sent = []
  const parent = { postMessage: message => sent.push(message) }
  const bridge = createReleaseUpdateBridge('nonce', 'chrome-extension://test')
  const controller = new AbortController()
  const request = bridge.request('prepare', { version: '1.1.81', sha256: 'a'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }, parent, controller.signal)
  controller.abort(new Error('caller cancelled'))
  assert.deepEqual(sent.map(message => message.action), ['prepare', 'cancel'])
  assert.equal(sent[0].requestId, sent[1].requestId)
  assert.deepEqual(sent[0].candidate, { version: '1.1.81', sha256: 'a'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' })
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://test', data: { type: 'release-update-failed/v1', nonce: 'nonce', requestId: sent[0].requestId, error: '在线更新已取消' } }, parent), true)
  await assert.rejects(request, /已取消/)
})

test('Side Panel preserves the iframe request identity through prepare and cancel', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(source, /requestReleaseUpdate\(action: 'check' \| 'prepare' \| 'cancel', requestId: string, candidate\?: unknown\)/)
  assert.match(source, /sendMessage\(\{ type: 'release-update\/v1', action, requestId, .*candidate/)
  assert.match(source, /requestReleaseUpdate\(value\.action, value\.requestId, value\.candidate\)/)
  assert.match(backgroundSource, /result\.ok \? \{ status: 'too_late' \}/)
  assert.doesNotMatch(backgroundSource, /result\.ok \? \{ status: 'cancelled' \}/)
})

test('Native Host starts the detached updater before confirming a prepared update', async () => {
  let launched = false
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updatePrepare: async () => ({ version: '1.1.76', sha256: 'b'.repeat(64), extractRoot: 'C:\\temp\\package' }),
    updateLaunch: async () => { launched = true; return true },
  })
  const candidate = { version: '1.1.76', sha256: 'b'.repeat(64), packageUrl: 'https://example.test/1.1.76.zip' }; rememberCandidate(host, candidate)
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-123', candidate)
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
  const candidate = { version: '1.1.76', sha256: 'b'.repeat(64), packageUrl: 'https://example.test/1.1.76.zip' }; rememberCandidate(host, candidate)
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-failed', candidate)
  assert.deepEqual(messages, [{ type: 'release_update_failed', requestId: 'request-prepare-failed', error: 'powershell.exe is unavailable' }])
  await new Promise(resolvePromise => setTimeout(resolvePromise, 30))
  assert.deepEqual(exited, [])
})

test('Native Host returns the persisted updater outcome when checking again', async () => {
  let checkOptions
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updateCheck: async options => { checkOptions = options; return { available: false, packageId: 'W/"installed-package"', packageUrl: 'https://git.midea.com/example/release.zip' } },
    updateStatusRead: async () => ({ state: 'succeeded', version: '1.1.81', packageId: 'W/"installed-package"', updatedAt: '2026-08-27T00:00:00.000Z' }),
  })
  const messages = []; host.send = message => messages.push(message)
  await host.checkReleaseUpdate('request-status-123')
  assert.equal(checkOptions.currentPackageId, 'W/"installed-package"')
  assert.deepEqual(messages.at(-1), {
    type: 'release_update_checked', requestId: 'request-status-123',
    update: {
      available: false, packageId: 'W/"installed-package"', packageUrl: 'https://git.midea.com/example/release.zip',
      lastUpdate: { state: 'succeeded', version: '1.1.81', packageId: 'W/"installed-package"', updatedAt: '2026-08-27T00:00:00.000Z' },
    },
  })
})

test('Native Host prepares only the exact candidate returned by its previous update check', async () => {
  let prepareOptions
  const candidate = { packageId: 'W/"gitlab-package-1"', packageUrl: 'https://git.midea.com/example/accr-ui-windows-lite-x64.zip' }
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updateCheck: async () => ({ available: true, ...candidate }),
    updatePrepare: async options => {
      prepareOptions = options
      return { version: '1.1.81', sha256: 'd'.repeat(64), ...candidate, extractRoot: 'C:\\temp\\package' }
    },
    updateLaunch: async () => true,
  })
  const messages = []; host.send = message => messages.push(message)
  await host.checkReleaseUpdate('request-check-candidate')
  await host.prepareReleaseUpdate('request-prepare-candidate', candidate)
  assert.deepEqual(prepareOptions.candidate, candidate)

  const withoutCheck = new NativeHost({ platform: 'win32', exit: () => {}, updatePrepare: async () => { throw new Error('must not prepare') } })
  const rejected = []; withoutCheck.send = message => rejected.push(message)
  await withoutCheck.prepareReleaseUpdate('request-prepare-without-check')
  assert.match(rejected.at(-1).error, /先检查更新/)
})

test('Native Host refuses an update while the Browser Connector has unfinished work', async () => {
  const host = new NativeHost({ platform: 'win32', exit: () => {} })
  host.connector = { isBusy: () => true }
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-busy')
  assert.match(messages.at(-1).error, /当前任务尚未完成/)
})

test('Native Host cancellation aborts the in-flight update before an updater can be launched', async () => {
  let launchCount = 0
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updatePrepare: async ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    updateLaunch: async () => { launchCount += 1 },
  })
  const candidate = { version: '1.1.81', sha256: 'e'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }; rememberCandidate(host, candidate)
  const messages = []; host.send = message => messages.push(message)
  const preparing = host.handle({ type: 'release-update-prepare', requestId: 'request-prepare-cancelled', candidate })
  await new Promise(resolve => setTimeout(resolve, 0))
  await host.handle({ type: 'release-update-cancel', requestId: 'request-prepare-cancelled' })
  await preparing
  assert.equal(launchCount, 0)
  assert.deepEqual(messages.at(-1), { type: 'release_update_cancelled', requestId: 'request-prepare-cancelled' })
})

test('Native Host says cancellation is too late after the updater publishes go, then prepares once', async () => {
  const candidate = { version: '1.1.81', sha256: 'e'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }
  let host
  host = new NativeHost({
    platform: 'win32', exit: () => {},
    updatePrepare: async () => ({ ...candidate, extractRoot: 'C:\\\\temp\\\\package' }),
    updateLaunch: async (_prepared, { onCommitted }) => {
      onCommitted()
      await host.handle({ type: 'release-update-cancel', requestId: 'request-prepare-too-late' })
    },
  })
  rememberCandidate(host, candidate)
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-too-late', candidate)
  assert.deepEqual(messages.map(message => message.type), ['release_update_cancel_too_late', 'release_update_prepared'])
  assert.equal(host.releaseUpdateCommitted, true)
})

test('Native Host gives an explicit result for a repeated or unknown update cancellation', () => {
  const host = new NativeHost({ platform: 'win32', exit: () => {} })
  const messages = []; host.send = message => messages.push(message)
  assert.equal(host.cancelReleaseUpdate('request-cancel-unknown'), false)
  assert.deepEqual(messages, [{ type: 'release_update_cancel_unknown', requestId: 'request-cancel-unknown' }])
})

test('Native Host commits and closes when cancellation arrives after the updater publishes go', async () => {
  const candidate = { version: '1.1.81', sha256: 'e'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }
  let host
  const hostClosed = []
  host = new NativeHost({
    platform: 'win32', exit: () => {},
    updatePrepare: async () => ({ ...candidate, extractRoot: 'C:\\\\temp\\\\package' }),
    updateLaunch: async () => {
      assert.equal(host.cancelReleaseUpdate('request-prepare-go-committed'), true)
      return true
    },
  })
  rememberCandidate(host, candidate)
  host.close = async reason => { hostClosed.push(reason) }
  const messages = []; host.send = message => messages.push(message)
  await host.prepareReleaseUpdate('request-prepare-go-committed', candidate)
  assert.equal(host.releaseUpdateCommitted, true)
  assert.equal(messages.some(message => message.type === 'release_update_prepared'), true)
  assert.equal(messages.some(message => message.type === 'release_update_failed'), false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(hostClosed, ['release update requested'])
})

test('two panels can prepare their own checked candidates without sharing the last checked release', async () => {
  let preparedCandidate
  const first = { version: '1.1.81', sha256: '1'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }
  const second = { version: '1.1.82', sha256: '2'.repeat(64), packageUrl: 'https://example.test/1.1.82.zip' }
  const checked = [first, second]
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updateCheck: async () => ({ available: true, ...checked.shift() }),
    updatePrepare: async ({ candidate }) => { preparedCandidate = candidate; return { ...candidate, extractRoot: 'C:\\temp\\package' } },
    updateLaunch: async () => true,
  })
  host.send = () => {}
  await host.checkReleaseUpdate('request-check-panel-one')
  await host.checkReleaseUpdate('request-check-panel-two')
  await host.handle({ type: 'release-update-prepare', requestId: 'request-prepare-panel-one', candidate: first })
  assert.deepEqual(preparedCandidate, first)
})

test('Native Host keeps the Connector quiescent across download and releases it after a late busy check fails', async () => {
  let busy = false
  let released = 0
  const candidate = { version: '1.1.81', sha256: 'f'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }
  const host = new NativeHost({
    platform: 'win32', exit: () => {},
    updatePrepare: async () => { busy = true; return { ...candidate, extractRoot: 'C:\\temp\\package' } },
    updateLaunch: async () => { throw new Error('must not launch while Connector is busy') },
  })
  rememberCandidate(host, candidate)
  host.connector = {
    beginUpdateQuiescence: () => !busy,
    isBusy: () => busy,
    endUpdateQuiescence: () => { released += 1 },
  }
  const messages = []; host.send = message => messages.push(message)
  await host.handle({ type: 'release-update-prepare', requestId: 'request-prepare-late-busy', candidate })
  assert.match(messages.at(-1).error, /当前任务尚未完成/)
  assert.equal(released, 1)
})

test('Native Host reports the installed Native package version separately from the Extension version', async () => {
  const host = new NativeHost({ platform: 'win32', nativeVersion: '1.1.82', exit: () => {}, processFactory: () => ({ start: async () => 'http://127.0.0.1:48127', stop: async () => {} }) })
  const messages = []; host.send = message => messages.push(message)
  try {
    await host.startHarness(undefined, undefined, undefined, '1.1.81')
    assert.equal(messages.at(-1).payload.nativeVersion, '1.1.82')
  } finally {
    await host.close('stop requested')
  }
})
