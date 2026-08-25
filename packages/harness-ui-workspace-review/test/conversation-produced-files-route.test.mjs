import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const extensionRequire = createRequire(new URL('../../../apps/chrome-extension/package.json', import.meta.url))
const require = createRequire(import.meta.url)
const { JSDOM } = extensionRequire('jsdom')
const React = extensionRequire('react')
const { createRoot } = extensionRequire('react-dom/client')
const { flushSync } = extensionRequire('react-dom')

function loadClient(output, modules) {
  globalThis.window.__ModuleLoader__ = {
    load: ({ id, factory }) => { modules.set(id, factory((specifier) => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return extensionRequire('react/jsx-runtime')
      return {}
    })) },
  }
  require(process.env.ACCRUI_WORKSPACE_REVIEW_CLIENT ?? fileURLToPath(new URL('../lib/client.js', import.meta.url)))
  require(`../../../apps/chrome-extension/.output/${output}/plugins/@deepseek-ai/dsh-client-ui-deliverables/client.js`)
}

/**
 * Runs the actual compiled client modules on the user-facing route.  A mock
 * resolver alone is insufficient: this catches the old artifact where the
 * ProducedFiles button bypassed the Review-open message entirely.
 */
test('a produced workspace Markdown chip emits the Markdown Review open event', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', {
    url: 'http://127.0.0.1:3101/?dshWorkspaceReviewNonce=nonce&dshWorkspaceReviewParentOrigin=chrome-extension%3A%2F%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  const posted = []
  const waitForPosts = async count => {
    for (let attempt = 0; attempt < 10 && posted.length < count; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(posted.length, count, `expected ${count} review-open event(s)`)
  }
  const globals = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Event', 'fetch', 'getComputedStyle']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const replace = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  replace('window', dom.window)
  replace('document', dom.window.document)
  replace('navigator', dom.window.navigator)
  replace('HTMLElement', dom.window.HTMLElement)
  replace('Event', dom.window.Event)
  replace('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  Object.defineProperty(dom.window, 'parent', { value: { postMessage: (...args) => { posted.push(args) } }, configurable: true })
  const requests = []
  replace('fetch', async (...args) => {
    requests.push(args)
    return { ok: true, json: async () => ({
    v: 1, reviewId: 'review-1', harnessSessionId: 'session-1', capability: 'capability-1',
    resourceId: 'resource-1', displayPath: 'pmd-workspace/spec/process.md', revision: 'r1', fingerprint: 'f1',
    }) }
  })

  try {
    const modules = new Map()
    loadClient(process.env.ACCRUI_WXT_OUTPUT ?? 'chrome-mv3-dev', modules)
    const { apply: applyWorkspaceReview } = modules.get('@accrui/harness-ui-workspace-review')
    const { ProducedFiles } = modules.get('@deepseek-ai/dsh-client-ui-deliverables')
    const providers = []
    const registry = {
      register(provider) { providers.push(provider); return () => { providers.splice(providers.indexOf(provider), 1) } },
      forClosing(owner) {
        const mentions = providers.toReversed().map(provider => provider.forClosing(owner)).filter(Boolean)
        return mentions.length === 0 ? undefined : { resolve: value => mentions.map(mention => mention.resolve(value)).find(Boolean) }
      },
    }
    const producedPath = 'pmd-workspace/spec/req-5b8f31ba2b51c864/req-5b8f31ba2b51c864_产业带摸排线上化_PRD.md'
    const producedBasename = 'req-5b8f31ba2b51c864_产业带摸排线上化_PRD.md'
    registry.register({
      forClosing: owner => ({
        resolve: value => value === producedBasename
          ? { open: () => owner.openFile(producedPath), label: producedPath, title: producedPath }
          : undefined,
      }),
    })
    const toolFileLinks = { register: () => () => {} }
    applyWorkspaceReview({
      get: (name) => name === 'chatFileMentions' ? registry : name === 'toolFileLinks' ? toolFileLinks : {},
      effect: (callback) => callback(),
      slots: { inject: () => {} },
    })

    const hostOpen = []
    const owner = {
      sessionId: 'session-1', cwd: '/Users/me/Desktop/html', seq: 1, openFile: path => hostOpen.push(path),
      turn: { data: new Map([['deliverables', { produced: [{ seq: 1, path: producedPath }] }]]) },
    }
    const inlineMention = registry.forClosing(owner)?.resolve(producedBasename)
    assert.ok(inlineMention, 'the closing prose basename must remain linked')
    inlineMention.open()
    await waitForPosts(1)
    assert.equal(JSON.parse(requests[0][1].body).relativePath, producedPath,
      'a produced basename must retain its unique nested workspace path')
    const root = createRoot(dom.window.document.getElementById('app'))
    flushSync(() => root.render(React.createElement(ProducedFiles, {
      matched: { paths: ['pmd-workspace/spec/process.md'], resolveFile: path => registry.forClosing(owner)?.resolve(path) },
      openFile: owner.openFile,
      isLoopback: true,
      useHostDescription: selector => selector({ canOpenPath: true }),
      t: (key, values = {}) => key === 'produced.open' ? `打开 ${values.name}` : key,
    })))
    const button = dom.window.document.querySelector('button')
    assert.ok(button, 'the ProducedFiles chip must render')
    button.click()
    await waitForPosts(2)

    assert.deepEqual(hostOpen, [], 'Markdown must not fall through to the system opener')
    assert.equal(requests.length, 2, 'both the closing prose link and produced-file chip must request Review')
    assert.deepEqual(posted[0], [{
      type: 'markdown-review-open/v1', nonce: 'nonce', review: {
        v: 1, reviewId: 'review-1', harnessSessionId: 'session-1', capability: 'capability-1',
        resourceId: 'resource-1', displayPath: 'pmd-workspace/spec/process.md', revision: 'r1', fingerprint: 'f1',
      },
    }, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
    root.unmount()
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    for (const [name, descriptor] of globals) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
    dom.window.close()
  }
})
