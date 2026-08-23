import assert from 'node:assert/strict'
import test from 'node:test'
import { settingsFromUnknown } from '../apps/chrome-extension/entrypoints/background/browser-target-state.ts'

const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://example.test' }

test('normalizes persisted Browser Target settings at the module interface', () => {
  assert.deepEqual(settingsFromUnknown({ mode: 'pinned-tabs', pinnedTabs: [target, { ...target }], primaryTabId: 2 }), {
    mode: 'pinned-tabs', pinnedTabs: [target], primaryTabId: 2,
  })
  assert.deepEqual(settingsFromUnknown({ mode: 'invalid', pinnedTabs: [{ ...target, title: 'extra' }] }), {
    mode: 'follow-active-tab', pinnedTabs: [],
  })
})
