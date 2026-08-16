import assert from 'node:assert/strict'
import test from 'node:test'

import { HarnessFrameSource, NormalizeActiveTabForBrowserTarget } from '../apps/chrome-extension/entrypoints/sidepanel/harness-frame.ts'

test('uses the native loopback URL as the Harness iframe source', () => {
  assert.equal(HarnessFrameSource('http://127.0.0.1:62070'), 'http://127.0.0.1:62070')
})

test('adds the Browser Target bridge marker only to loopback Harness URLs', () => {
  assert.equal(
    HarnessFrameSource('http://127.0.0.1:62070/?fixture', {
      nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop',
    }),
    'http://127.0.0.1:62070/?fixture=&dshBrowserTargetBridge=1&dshBrowserTargetNonce=frame-nonce&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabcdefghijklmnop',
  )
  assert.throws(() => HarnessFrameSource('https://example.com/', {
    nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop',
  }), /loopback/)
  assert.throws(() => HarnessFrameSource('http://127.0.0.1:62070/', {
    nonce: 'frame-nonce', parentOrigin: 'https://example.com',
  }), /Chrome extension origin/)
})

test('normalizes the active Chrome tab before it crosses the trusted iframe bridge', () => {
  assert.deepEqual(
    NormalizeActiveTabForBrowserTarget({
      windowId: 3,
      tabId: 11,
      title: '当前标签',
      url: 'https://example.test/',
      favIconUrl: 'https://example.test/favicon.ico',
    }),
    {
      browser: 'chrome',
      windowId: 3,
      tabId: 11,
      title: '当前标签',
      url: 'https://example.test/',
      favIconUrl: 'https://example.test/favicon.ico',
    },
  )
})
