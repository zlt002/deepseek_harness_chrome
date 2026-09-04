import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadModule() {
  const source = await readFile(new URL('./workspace-desktop-notifications.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(javascript)}#${Date.now()}-${Math.random()}`)
}

function event(overrides = {}) {
  return { sessionId: 'session-1', eventId: 'turn:17', kind: 'completed', foreground: false, surface: 'fullscreen-tab', windowId: 7, tabId: 42, ...overrides }
}

test('suppresses foreground events and persists stable identities across service-worker instances', async () => {
  const { WorkspaceDesktopNotifications } = await loadModule()
  const created = []
  const state = {}
  const api = { notifications: { create: async (id, options) => { created.push({ id, options }); return id } } }
  const storage = { get: async (key) => ({ [key]: state[key] }), set: async (value) => Object.assign(state, value) }
  const first = new WorkspaceDesktopNotifications(api, storage)
  assert.equal(await first.notify(event({ foreground: true })), false)
  assert.equal(await first.notify(event()), true)
  assert.equal(await new WorkspaceDesktopNotifications(api, storage).notify(event()), false)
  assert.equal(created.length, 1)
  assert.equal(created[0].options.iconUrl, 'favicon.svg')
  assert.equal(created[0].options.message, '任务已完成')
})

test('click returns to the surviving fullscreen Harness Tab, then safely falls back to a session side panel', async () => {
  const { WorkspaceDesktopNotifications, workspaceNotificationId } = await loadModule()
  const calls = []
  const api = {
    notifications: { create: async id => id },
    tabs: { get: async () => ({ id: 42, windowId: 7, url: 'chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessSessionId=session-1' }), update: async (...args) => calls.push(['tab', ...args]) },
    windows: { update: async (...args) => calls.push(['window', ...args]) },
    sidePanel: { setOptions: async (...args) => calls.push(['path', ...args]), open: async (...args) => calls.push(['open', ...args]) },
  }
  const notifications = new WorkspaceDesktopNotifications(api)
  const item = event()
  await notifications.notify(item)
  assert.equal(await notifications.click(workspaceNotificationId(item)), true)
  assert.deepEqual(calls, [['window', 7, { focused: true }], ['tab', 42, { active: true }]])

  api.tabs.get = async () => { throw new Error('closed') }
  assert.equal(await notifications.click(workspaceNotificationId(item)), true)
  assert.deepEqual(calls.at(-2), ['path', { path: 'sidepanel.html?dshHarnessSessionId=session-1&dshHarnessNotificationRestore=1' }])
  assert.deepEqual(calls.at(-1), ['open', { windowId: 7 }])
})
