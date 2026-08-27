import assert from 'node:assert/strict'
import test from 'node:test'

import { FullscreenHarnessTabUrl, HarnessFrameSource, HarnessSurfaceFromLocation, NormalizeActiveTabForBrowserTarget, PRODUCT_VERSION_QUERY_KEY } from '../apps/chrome-extension/entrypoints/sidepanel/harness-frame.ts'

test('uses the native loopback URL as the Harness iframe source', () => {
  assert.equal(HarnessFrameSource('http://127.0.0.1:62070'), 'http://127.0.0.1:62070')
})

test('adds the Browser Target bridge marker only to loopback Harness URLs', () => {
  assert.equal(
    HarnessFrameSource('http://127.0.0.1:62070/?fixture', {
      nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop', surface: 'sidepanel',
    }),
    'http://127.0.0.1:62070/?fixture=&dshBrowserTargetBridge=1&dshBrowserTargetNonce=frame-nonce&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabcdefghijklmnop&dshBrowserTargetSurface=sidepanel&dshWorkspaceReviewNonce=frame-nonce&dshWorkspaceReviewParentOrigin=chrome-extension%3A%2F%2Fabcdefghijklmnop',
  )
  assert.throws(() => HarnessFrameSource('https://example.com/', {
    nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop', surface: 'sidepanel',
  }), /loopback/)
  assert.throws(() => HarnessFrameSource('http://127.0.0.1:62070/', {
    nonce: 'frame-nonce', parentOrigin: 'https://example.com', surface: 'sidepanel',
  }), /Chrome extension origin/)
})

test('passes the installed extension version to the loopback Harness UI', () => {
  const frameUrl = HarnessFrameSource('http://127.0.0.1:62070/', {
    nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop', surface: 'sidepanel', productVersion: '1.1.86',
  })
  assert.equal(new URL(frameUrl).searchParams.get(PRODUCT_VERSION_QUERY_KEY), '1.1.86')
  const invalidVersionUrl = HarnessFrameSource('http://127.0.0.1:62070/', {
    nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop', surface: 'sidepanel', productVersion: 'not-a-version',
  })
  assert.equal(new URL(invalidVersionUrl).searchParams.has(PRODUCT_VERSION_QUERY_KEY), false)
})

test('marks only the extension Tab as full-screen and projects that surface into the iframe bridge', () => {
  assert.equal(FullscreenHarnessTabUrl('chrome-extension://abcdefghijklmnop/sidepanel.html'), 'chrome-extension://abcdefghijklmnop/sidepanel.html?dshHarnessSurface=fullscreen-tab')
  assert.equal(HarnessSurfaceFromLocation({ search: '' }), 'sidepanel')
  assert.equal(HarnessSurfaceFromLocation({ search: '?dshHarnessSurface=fullscreen-tab' }), 'fullscreen-tab')
  assert.equal(
    HarnessFrameSource('http://127.0.0.1:62070/', {
      nonce: 'frame-nonce', parentOrigin: 'chrome-extension://abcdefghijklmnop', surface: 'fullscreen-tab',
    }),
    'http://127.0.0.1:62070/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=frame-nonce&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabcdefghijklmnop&dshBrowserTargetSurface=fullscreen-tab&dshWorkspaceReviewNonce=frame-nonce&dshWorkspaceReviewParentOrigin=chrome-extension%3A%2F%2Fabcdefghijklmnop',
  )
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
