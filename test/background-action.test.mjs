import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

test('extension action click binds its explicit tab before opening the Harness side panel', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = await bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))

  let actionListener
  const panelBehaviors = []
  const openedPanels = []
  const nativeMessages = []
  const nativeMessageListeners = new Set()
  const nativeDisconnectListeners = new Set()
  const port = {
    onDisconnect: {
      addListener: (listener) => nativeDisconnectListeners.add(listener),
      removeListener: (listener) => nativeDisconnectListeners.delete(listener),
    },
    onMessage: {
      addListener: (listener) => nativeMessageListeners.add(listener),
      removeListener: (listener) => nativeMessageListeners.delete(listener),
    },
    postMessage: (message) => {
      nativeMessages.push(message)
      if (message.type === 'start') {
        queueMicrotask(() => {
          for (const listener of nativeMessageListeners) {
            listener({
              type: 'server_started',
              payload: { url: 'http://127.0.0.1:43123', runId: 'run-action-click' },
            })
          }
        })
      }
    },
  }

  globalThis.chrome = {
    action: {
      onClicked: { addListener: (listener) => { actionListener = listener } },
    },
    runtime: {
      connectNative: () => port,
      lastError: undefined,
      onMessage: { addListener: () => {} },
      sendMessage: async () => {},
    },
    sidePanel: {
      open: async (options) => { openedPanels.push(options) },
      setPanelBehavior: async (behavior) => { panelBehaviors.push(behavior) },
    },
  }
  globalThis.defineBackground = (setup) => setup()

  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
    assert.deepEqual(panelBehaviors, [], 'Chrome auto-open consumes the action click before the target binder')
    assert.equal(typeof actionListener, 'function')

    actionListener({ id: 42, windowId: 7, url: 'https://example.com/', title: 'Example Domain' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(nativeMessages, [{
      type: 'start',
      browserTarget: {
        browser: 'chrome',
        windowId: 7,
        tabId: 42,
        url: 'https://example.com/',
      },
    }])
    assert.deepEqual(openedPanels, [{ windowId: 7 }])
  } finally {
    delete globalThis.chrome
    delete globalThis.defineBackground
  }
})
