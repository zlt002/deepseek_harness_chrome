import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadModule() {
  const source = await readFile(new URL('./workspace-desktop-notification-bridge.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("import { validWorkspaceDesktopNotification } from '../background/workspace-desktop-notifications';", "const validWorkspaceDesktopNotification = (value) => value && typeof value === 'object' && typeof value.sessionId === 'string' && typeof value.eventId === 'string' && ['completed', 'approval', 'question', 'plan-review'].includes(value.kind) && typeof value.foreground === 'boolean' && ['sidepanel', 'fullscreen-tab'].includes(value.surface) && Number.isInteger(value.windowId)")
  return import(`data:text/javascript,${encodeURIComponent(javascript)}#${Date.now()}-${Math.random()}`)
}

test('rejects cross-window, cross-origin, and nonce-mismatched lifecycle messages', async () => {
  const { acceptWorkspaceDesktopNotificationSnapshot, workspaceIsForeground } = await loadModule()
  const parent = {}
  const question = { sessionId: 'session-1', eventId: 'q:1', kind: 'question' }
  const message = { type: 'workspace-desktop-notification-snapshot/v1', nonce: 'n', events: [question] }
  assert.equal(acceptWorkspaceDesktopNotificationSnapshot({ source: {}, origin: 'chrome-extension://id', data: message }, parent, 'chrome-extension://id', 'n'), undefined)
  assert.equal(acceptWorkspaceDesktopNotificationSnapshot({ source: parent, origin: 'https://bad.test', data: message }, parent, 'chrome-extension://id', 'n'), undefined)
  assert.equal(acceptWorkspaceDesktopNotificationSnapshot({ source: parent, origin: 'chrome-extension://id', data: { ...message, nonce: 'bad' } }, parent, 'chrome-extension://id', 'n'), undefined)
  assert.deepEqual(acceptWorkspaceDesktopNotificationSnapshot({ source: parent, origin: 'chrome-extension://id', data: message }, parent, 'chrome-extension://id', 'n'), [question])
  assert.equal(workspaceIsForeground({ visibilityState: 'visible', hasFocus: () => true }), true)
  assert.equal(workspaceIsForeground({ visibilityState: 'hidden', hasFocus: () => true }), false)
})

test('holds a live foreground request until blur without requiring another Harness event', async () => {
  const { listenForWorkspaceNotificationVisibility, WorkspaceDesktopNotificationDelivery } = await loadModule()
  const delivered = []
  const delivery = new WorkspaceDesktopNotificationDelivery(item => delivered.push(item))
  const question = { sessionId: 'session-1', eventId: 'q:1', kind: 'question' }

  const listeners = new Map()
  const windowLike = { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type) }
  const documentLike = { ...windowLike, visibilityState: 'visible', hasFocus: () => true }
  const stop = listenForWorkspaceNotificationVisibility(delivery, windowLike, documentLike)

  await delivery.reconcile([question], true)
  assert.deepEqual(delivered, [], 'the foreground Workspace stays quiet')

  listeners.get('blur')()
  await new Promise(resolve => setTimeout(resolve, 0))
  listeners.get('blur')()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(delivered, [question], 'blur retries once even though the Harness session list did not change')
  stop()
  assert.equal(listeners.size, 0)
})

test('drops resolved foreground requests and retains a live foreground completion until blur', async () => {
  const { WorkspaceDesktopNotificationDelivery } = await loadModule()
  const delivered = []
  const delivery = new WorkspaceDesktopNotificationDelivery(item => delivered.push(item))
  const question = { sessionId: 'session-1', eventId: 'q:1', kind: 'question' }

  await delivery.reconcile([question], true)
  await delivery.reconcile([], true)
  await delivery.flush(false)
  assert.deepEqual(delivered, [], 'a request resolved before blur is not notified')

  const liveCompletion = { sessionId: 'session-1', eventId: 'turn:2', kind: 'completed' }
  await delivery.reconcile([liveCompletion], true)
  await delivery.flush(false)
  assert.deepEqual(delivered, [liveCompletion])
})

test('retries only failed delivery and rejects malformed active snapshots', async () => {
  const { acceptWorkspaceDesktopNotificationSnapshot, WorkspaceDesktopNotificationDelivery } = await loadModule()
  const parent = {}
  const question = { sessionId: 'session-1', eventId: 'q:1', kind: 'question' }
  const message = { type: 'workspace-desktop-notification-snapshot/v1', nonce: 'n', events: [question] }
  assert.deepEqual(acceptWorkspaceDesktopNotificationSnapshot({ source: parent, origin: 'chrome-extension://id', data: message }, parent, 'chrome-extension://id', 'n'), [question])
  assert.equal(acceptWorkspaceDesktopNotificationSnapshot({ source: parent, origin: 'chrome-extension://id', data: { ...message, events: [{ ...question, kind: 'unknown' }] } }, parent, 'chrome-extension://id', 'n'), undefined)

  let attempts = 0
  const delivery = new WorkspaceDesktopNotificationDelivery(() => ++attempts > 1)
  await delivery.reconcile([question], false)
  await delivery.flush(false)
  await delivery.flush(false)
  assert.equal(attempts, 2, 'a failed send retries, but a confirmed send is permanently consumed')
})
