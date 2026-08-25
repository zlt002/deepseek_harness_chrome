import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = new URL('../../../', import.meta.url)
const cordis = await import(new URL('.generated/harness-product/vendor/cordis/lib/index.js', root))

function pluginClientPath(output) {
  return fileURLToPath(new URL(`../../../apps/chrome-extension/.output/${output}/plugins/@deepseek-ai/dsh-client-ui-deliverables/client.js`, import.meta.url))
}

function resolveWxtOutput({ env = process.env, exists = existsSync } = {}) {
  if (env.ACCRUI_WXT_OUTPUT) return env.ACCRUI_WXT_OUTPUT
  return ['chrome-mv3-dev', 'chrome-mv3'].find(output => exists(pluginClientPath(output))) ?? 'chrome-mv3-dev'
}

function fakeReactElement(type, props) { return { type, props: props ?? {} } }

function loadClientBundle(path, modules) {
  let exports
  globalThis.window.__ModuleLoader__ = {
    load({ factory }) { exports = factory(name => modules[name] ?? {}) },
  }
  return import(`${pathToFileURL(path).href}?test=${Date.now()}-${Math.random()}`).then(() => exports)
}

function findClickableFileChip(node, path) {
  if (Array.isArray(node)) return node.map(child => findClickableFileChip(child, path)).find(Boolean)
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === 'button' && node.props.children === path && typeof node.props.onClick === 'function') return node
  const children = node.props?.children
  if (Array.isArray(children)) return children.map(child => findClickableFileChip(child, path)).find(Boolean)
  return findClickableFileChip(children, path)
}

test('a produced Markdown chip opens Markdown Review through the active Cordis resolver', async () => {
  const original = {
    window: globalThis.window,
    fetch: globalThis.fetch,
  }
  const posts = []
  globalThis.window = {
    location: { search: '?dshWorkspaceReviewNonce=nonce&dshWorkspaceReviewParentOrigin=chrome-extension%3A%2F%2Ftest-extension' },
    parent: { postMessage: (...args) => { posts.push(args) } },
    addEventListener() {}, removeEventListener() {},
    __ModuleLoader__: undefined,
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ reviewId: 'review-1', resourceId: 'resource-1' }) })
  try {
    const react = {
      createElement: fakeReactElement,
      useEffect() {}, useLayoutEffect() {},
      useRef: value => ({ current: value }), useState: value => [value, () => {}],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
    const jsx = (type, props) => fakeReactElement(type, props)
    const modules = {
      react,
      'react/jsx-runtime': { jsx, jsxs: jsx },
      '@deepseek-ai/dsh-client-ui-primitives': {},
      '@deepseek-ai/dsh-client-runtime/client': { isAppendSurfaceEvent: () => true },
    }
    const workspace = await loadClientBundle(fileURLToPath(new URL('../lib/client.js', import.meta.url)), modules)
    const deliverables = await loadClientBundle(pluginClientPath(resolveWxtOutput()), modules)
    const ctx = new cordis.Context()
    ctx.provide('slots', { inject: () => () => {} })
    ctx.provide('reviewFeedback', { submitWorkspaceMarkdown: async () => {} })
    ctx.provide('sessions', {})
    ctx.provide('workspaces', {})
    ctx.provide('toolFileLinks', { register: () => () => {} })
    const mentions = {
      providers: [],
      register(provider) { this.providers.push(provider); return () => { this.providers = this.providers.filter(value => value !== provider) } },
      forClosing(owner) {
        const resolved = this.providers.map(provider => provider.forClosing(owner)).filter(Boolean)
        return {
          resolve: path => resolved.map(value => value.resolve(path)).find(Boolean),
        }
      },
    }

    const workspaceFiber = ctx.plugin({ inject: workspace.inject, apply: workspace.apply })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(workspaceFiber.state, 0, 'the resolver owner must wait for the conversation registry')
    ctx.provide('chatFileMentions', mentions)
    await workspaceFiber.await()

    const owner = { sessionId: 'session-1', cwd: '/workspace', seq: 1, turn: { data: { get: () => ({ produced: [{ seq: 1, path: 'process.md' }] }) } }, openFile: () => assert.fail('Markdown must not use the system opener') }
    const match = { paths: ['process.md'], resolveFile: path => mentions.forClosing(owner).resolve(path) }
    const row = deliverables.ProducedFiles({
      matched: match,
      openFile: owner.openFile,
      isLoopback: false,
      useHostDescription: () => undefined,
      t: (key, values) => key === 'produced.open' ? `open ${values.name}` : key,
    })
    const chip = findClickableFileChip(row, 'process.md')
    assert.ok(chip, 'the actual ProducedFiles chip must be clickable')
    chip.props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(posts, [[
      { type: 'markdown-review-open/v1', nonce: 'nonce', review: { reviewId: 'review-1', resourceId: 'resource-1' } },
      'chrome-extension://test-extension',
    ]])
    await workspaceFiber.dispose()
    await ctx.fiber.dispose()
  } finally {
    globalThis.window = original.window
    globalThis.fetch = original.fetch
  }
})
