import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const extensionRequire = createRequire(new URL('../../../apps/chrome-extension/package.json', import.meta.url))
const require = createRequire(import.meta.url)
const { JSDOM } = extensionRequire('jsdom')
const React = extensionRequire('react')
const { createRoot } = extensionRequire('react-dom/client')
const { flushSync } = extensionRequire('react-dom')

function pluginClientPath(output) {
  return fileURLToPath(new URL(`../../../apps/chrome-extension/.output/${output}/plugins/@deepseek-ai/dsh-client-ui-tool/client.js`, import.meta.url))
}

function resolveWxtOutput({ env = process.env, exists = existsSync } = {}) {
  if (env.ACCRUI_WXT_OUTPUT) return env.ACCRUI_WXT_OUTPUT
  return ['chrome-mv3-dev', 'chrome-mv3'].find(output => exists(pluginClientPath(output))) ?? 'chrome-mv3-dev'
}

function loadClient(path, modules) {
  globalThis.window.__ModuleLoader__ = {
    load: ({ id, factory }) => modules.set(id, factory(specifier => modules.get(specifier) ?? {})),
  }
  require(path)
}

function primitives() {
  const empty = () => null
  return {
    DisclosureRow: ({ collapsedContent, children }) => React.createElement('div', null, collapsedContent, children),
    StateDot: empty,
    IconBrowseOutline16: empty,
    IconEditOutline16: empty,
    IconInspectOutline12: empty,
    ReadBlock: empty,
    DiffBlock: empty,
    TerminalBlock: empty,
    SearchBlock: empty,
    WebBlock: empty,
    CodeBlock: empty,
  }
}

function toolResult(callId, name, argsRaw) {
  return {
    kind: 'tool-result', seq: 1, time: 1, callId, call: { name, argsRaw }, callTime: 0,
    content: [], isError: false, callView: null, resultView: null, subCalls: [],
  }
}

/**
 * This is the real user-facing composition: the compiled ui-tool package
 * provides its registry and conversation-node wrapper, then the compiled
 * workspace-review plugin registers its provider through ctx.effect().
 */
test('real Tool rows route workspace Markdown to Review and keep other files on the Host', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', {
    url: 'http://127.0.0.1:3101/?dshWorkspaceReviewNonce=nonce&dshWorkspaceReviewParentOrigin=chrome-extension%3A%2F%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  const original = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Event', 'fetch', 'getComputedStyle']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const replace = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  replace('window', dom.window)
  replace('document', dom.window.document)
  replace('navigator', dom.window.navigator)
  replace('HTMLElement', dom.window.HTMLElement)
  replace('Event', dom.window.Event)
  replace('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  const posts = []
  Object.defineProperty(dom.window, 'parent', { configurable: true, value: { postMessage: (...args) => posts.push(args) } })
  replace('fetch', async () => ({ ok: true, json: async () => ({ reviewId: 'review-1', resourceId: 'resource-1' }) }))

  try {
    const modules = new Map([
      ['react', React],
      ['react/jsx-runtime', extensionRequire('react/jsx-runtime')],
      ['clsx', (...values) => values.filter(Boolean).join(' ')],
      ['@deepseek-ai/dsh-client-ui-primitives', primitives()],
      ['@deepseek-ai/dsh-client-runtime/client', {}],
    ])
    loadClient(pluginClientPath(resolveWxtOutput()), modules)
    loadClient('../lib/client.js', modules)
    const tool = modules.get('@deepseek-ai/dsh-client-ui-tool')
    const workspace = modules.get('@accrui/harness-ui-workspace-review')
    assert.ok(tool?.apply, 'the actual ui-tool bundle must load')
    assert.ok(workspace?.apply, 'the actual workspace-review bundle must load')

    const services = new Map()
    const entries = []
    const cleanups = []
    const ctx = {
      get: name => services.get(name),
      provide(name, value) { services.set(name, value); this[name] = value },
      effect(callback) { cleanups.push(callback()) },
      plugin(plugin) { plugin.apply(this) },
      slots: {
        inject: (_name, callback) => callback(),
        register(options, component) { entries.push({ options, component }); return () => {} },
      },
      reviewFeedback: { submitWorkspaceMarkdown: async () => {} },
      sessions: { binding: sessionId => sessionId === 'session-1' ? { ctx: { sessionId } } : undefined },
      workspaces: {},
      chatFileMentions: { register: () => () => {} },
      conversation: { input: { for: () => ({ notify: (...notice) => notices.push(notice) }) } },
    }
    services.set('reviewFeedback', ctx.reviewFeedback)
    services.set('sessions', ctx.sessions)
    services.set('workspaces', ctx.workspaces)
    services.set('chatFileMentions', ctx.chatFileMentions)
    services.set('conversation', ctx.conversation)
    tool.apply(ctx)
    workspace.apply(ctx)
    const row = key => entries.find(entry => entry.options.name === 'tool.call.toolview' && entry.options.key === key)?.component
    const toolTree = entries.find(entry => entry.options.name === 'conversation.chat.node' && entry.options.key === 'tool-call')?.component
    assert.ok(toolTree, 'ToolCallTree must receive the registry from the real ui-tool apply')

    const root = createRoot(dom.window.document.getElementById('app'))
    const host = []
    const notices = []
    const flushAsync = async () => {
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    }
    const renderSlot = (_name, owner, options) => {
      const component = row(options.entryKey)
      return component === undefined ? options.fallback : React.createElement(component, { ...owner, t: key => key })
    }
    const render = (callId, name, path, cwd) => flushSync(() => root.render(React.createElement(toolTree, {
      renderSlot,
      node: { data: { root: toolResult(callId, name, JSON.stringify(name === 'read' ? { path } : { file_path: path })) } },
      sessionId: 'session-1', cwd, selectedCallId: undefined,
      openFile: value => host.push(value), inspectCall: () => {}, t: key => key,
    })))

    for (const [callId, name, path] of [
      ['read', 'read', '/workspace/spec/process.md'],
      ['write', 'write', 'spec/output.markdown'],
      ['edit', 'edit', 'spec/revised.md'],
    ]) {
      render(callId, name, path, '/workspace')
      const button = dom.window.document.querySelector('button')
      assert.ok(button, `${name} must render its file link`)
      button.click()
      await flushAsync()
    }
    assert.deepEqual(host, [], 'Markdown must not fall through to the system opener')
    assert.equal(posts.length, 3, 'Read, Write, and Edit Markdown paths must each open Review')

    // Cold/persisted sessions can retain their session identity before their
    // cwd is projected into the chat owner. A relative path is still bounded
    // by the server-side session workspace, so it must not fall back to Host.
    render('cold-write', 'write', 'spec/cold-session.md', undefined)
    const coldMarkdown = dom.window.document.querySelector('button')
    assert.ok(coldMarkdown, 'a cold-session Markdown file must remain clickable')
    coldMarkdown.click()
    await flushAsync()
    assert.deepEqual(host, [], 'a relative cold-session Markdown file must not use the system opener')
    assert.equal(posts.length, 4, 'a relative cold-session Markdown file must open Review')

    // Without cwd, an absolute path cannot be proven to belong to the session
    // workspace. It intentionally remains on the official Host fallback.
    render('cold-absolute', 'read', '/outside-workspace/private.md', undefined)
    const coldAbsolute = dom.window.document.querySelector('button')
    assert.ok(coldAbsolute, 'an unproven absolute Markdown path must remain clickable')
    coldAbsolute.click()
    assert.deepEqual(host, ['/outside-workspace/private.md'])
    assert.equal(posts.length, 4, 'an unproven absolute Markdown path must not open Review')

    render('other', 'read', 'spec/notes.txt', '/workspace')
    const nonMarkdown = dom.window.document.querySelector('button')
    assert.ok(nonMarkdown, 'a non-Markdown file must remain clickable')
    nonMarkdown.click()
    assert.deepEqual(host, ['/outside-workspace/private.md', 'spec/notes.txt'])

    replace('fetch', async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "ENOENT: no such file or directory, lstat '/Users/zhanglt21/Desktop/one/pmd-workspace'" }),
    }))
    render('missing', 'write', 'pmd-workspace/spec/req_1e7d3374/req_1e7d3374_产业带摸排表格线上化_PRD.md', '/Users/zhanglt21/Desktop/one')
    const missing = dom.window.document.querySelector('button')
    assert.ok(missing, 'a missing workspace Markdown file must remain clickable')
    missing.click()
    await flushAsync()
    assert.deepEqual(notices, [[
      'error',
      "ENOENT: no such file or directory, lstat '/Users/zhanglt21/Desktop/one/pmd-workspace'",
    ]], 'the concrete Host open error must be visible in the owning conversation')
    root.unmount()
    await flushAsync()
    cleanups.reverse().forEach(cleanup => cleanup?.())
  } finally {
    for (const [name, descriptor] of original) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
    dom.window.close()
  }
})
