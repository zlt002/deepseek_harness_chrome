import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import {
  PMD_PRD_SOURCE_QUESTION_ID,
  SELECT_SOURCES_OPTION,
  SELECTED_SOURCES_CONTINUE_MESSAGE,
  SKIP_REMOTE_SOURCES_OPTION,
  hasSelectedSources,
  sourceScopeAction,
  sourceScopeQuestion,
} from '../src/client/source-scope-question.js'

process.env.NODE_PATH = fileURLToPath(new URL('../../../.generated/harness-product/node_modules/', import.meta.url))
createRequire(import.meta.url)('node:module').Module._initPaths()

const require = createRequire(import.meta.url)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')

const question = {
  id: PMD_PRD_SOURCE_QUESTION_ID,
  question: '要用参考资料吗？',
  options: [
    { label: SELECT_SOURCES_OPTION, description: '选代码库或知识库' },
    { label: SKIP_REMOTE_SOURCES_OPTION, description: '不使用资料，直接继续' },
  ],
}

test('routes only the exact pmd-prd source choice to the compact Ask card', () => {
  assert.equal(sourceScopeQuestion([question]), question)
  assert.equal(sourceScopeQuestion([{ ...question, id: 'another_question' }]), undefined)
  assert.equal(sourceScopeQuestion([{ ...question, options: [{ label: SELECT_SOURCES_OPTION }] }]), undefined)
})

test('opens the repository picker only for the select-sources action', () => {
  assert.equal(sourceScopeAction(SELECT_SOURCES_OPTION), 'open-repository-picker')
  assert.equal(sourceScopeAction(SKIP_REMOTE_SOURCES_OPTION), 'continue-without-remote-sources')
  assert.equal(sourceScopeAction('选择知识范围'), undefined)
})

test('does not resolve the Ask selection until the authoritative scope has a source', () => {
  assert.equal(hasSelectedSources({ repositoryIds: [], domainSystems: {} }), false)
  assert.equal(hasSelectedSources({ repositoryIds: ['repo-1'], domainSystems: {} }), true)
  assert.equal(hasSelectedSources({ repositoryIds: [], domainSystems: { logistics: ['csp'] } }), true)
})

function button(container, label) {
  return [...container.querySelectorAll('button')].find(node => node.textContent.includes(label))
}

function matched(key, respond) {
  return { key, sessionId: 'session-1', payload: { questions: [question] }, respond }
}

test('requires an explicit request-scoped confirmation after source selection', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const prior = new Map(['window', 'document', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  })
  let overlayShows = 0
  let client
  let snapshot = { sessionId: 'session-1', scope: { repositoryIds: ['already-selected'], domainSystems: {} } }
  dom.window.__ModuleLoader__ = {
    load: ({ factory }) => {
      client = factory(specifier => {
        if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { useComposerOverlay: () => ({ show: () => { overlayShows += 1 } }) }
        if (specifier.startsWith('@deepseek-ai/')) return { createSnapshotStore: value => ({ get: () => value }) }
        return require(specifier)
      })
    },
  }
  try {
    delete require.cache[require.resolve('../lib/client.js')]
    require('../lib/client.js')
    const container = dom.window.document.getElementById('root')
    const root = createRoot(container)
    let firstResponses = 0
    const firstPayloads = []
    const first = matched('wait-a', async (value) => { firstResponses += 1; firstPayloads.push(value); return { accepted: true } })
    const render = wait => root.render(React.createElement(client.SourceScopeQuestion, {
      matched: wait,
      useKnowledgeScope: selector => selector(snapshot),
    }))

    await act(async () => { render(first) })
    assert.equal(firstResponses, 0, 'an existing selection must not answer before the user confirms')
    await act(async () => { button(container, '选择资料').click() })
    assert.equal(overlayShows, 1)
    assert.equal(firstResponses, 0, 'opening the picker must not answer')
    assert.equal(button(container, '使用已选资料').disabled, false)

    snapshot = { sessionId: 'session-1', scope: { repositoryIds: [], domainSystems: {} } }
    await act(async () => { render(first) })
    assert.equal(button(container, '使用已选资料').disabled, true)
    snapshot = { sessionId: 'session-1', scope: { repositoryIds: ['first-new-selection'], domainSystems: {} } }
    await act(async () => { render(first) })
    assert.equal(firstResponses, 0, 'the first newly selected source must not auto-answer')
    const confirm = button(container, '使用已选资料')
    assert.equal(confirm.disabled, false)
    await act(async () => { confirm.click(); confirm.click(); await Promise.resolve() })
    assert.equal(firstResponses, 1, 'rapid double confirmation must respond once')
    assert.deepEqual(firstPayloads, [{
      ok: true,
      value: {
        sessionId: 'session-1',
        answer: { answers: [{ id: PMD_PRD_SOURCE_QUESTION_ID, selected: [], custom: SELECTED_SOURCES_CONTINUE_MESSAGE }] },
      },
    }], 'confirming an actual selection must wake /pmd-prd with an unambiguous continuation message')

    let resolveOld
    const oldResponse = new Promise(resolve => { resolveOld = resolve })
    const pending = matched('wait-pending', async () => oldResponse)
    await act(async () => { render(pending) })
    await act(async () => { button(container, '选择资料').click() })
    await act(async () => { button(container, '使用已选资料').click() })
    let secondResponses = 0
    const next = matched('wait-next', async () => { secondResponses += 1; return { accepted: true } })
    await act(async () => { render(next) })
    await act(async () => { button(container, '选择资料').click() })
    assert.equal(button(container, '使用已选资料').disabled, false, 'a replacement wait must not inherit busy state')
    await act(async () => { button(container, '使用已选资料').click(); await Promise.resolve() })
    assert.equal(secondResponses, 1, 'a replacement wait must submit independently')
    resolveOld({ accepted: true })

    let attempts = 0
    const retry = matched('wait-retry', async () => ({ accepted: ++attempts > 1, reason: 'stale' }))
    await act(async () => { render(retry) })
    await act(async () => { button(container, '选择资料').click() })
    await act(async () => { button(container, '使用已选资料').click(); await Promise.resolve(); await Promise.resolve() })
    assert.equal(button(container, '使用已选资料').disabled, false, 'a rejected response must be retryable')
    await act(async () => { button(container, '使用已选资料').click(); await Promise.resolve() })
    assert.equal(attempts, 2)
    await act(async () => { root.unmount() })
  } finally {
    dom.window.close()
    for (const [key, value] of prior) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})

test('elects the pmd-prd source card before the generic Ask card', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=test-nonce&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Ftest-extension',
  })
  const prior = new Map(['window', 'document'].map(key => [key, globalThis[key]]))
  const modules = new Map()
  const entries = []
  Object.assign(globalThis, { window: dom.window, document: dom.window.document })
  dom.window.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      modules.set(id, factory(specifier => {
        if (specifier === '@deepseek-ai/dsh-client-runtime/client') return { createSnapshotStore: initial => ({ get: () => initial, set: () => {} }) }
        if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { useComposerOverlay: () => ({ show: () => {} }) }
        return require(specifier)
      }))
    },
  }
  const ctx = {
    effect: callback => { callback() },
    locale: { register: () => {} },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { if (options.name === 'conversation.composer') entries.push({ options, component }) },
    },
  }
  try {
    runInThisContext(await readFile(new URL('../../../.generated/harness-product/packages/client/ui-user-questions/lib/client.js', import.meta.url), 'utf8'))
    runInThisContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
    modules.get('@deepseek-ai/dsh-client-ui-user-questions').apply(ctx)
    modules.get('@accrui/harness-ui-knowledge-scope').apply(ctx)
    assert.equal(entries.length, 2)
    const genericQuestionComposer = entries.find(entry => entry.options.priority === undefined)?.component
    const elect = interactions => entries
      .toSorted((left, right) => (left.options.priority ?? 0) - (right.options.priority ?? 0))
      .map(entry => ({ entry, matched: entry.options.select({ interactions }) }))
      .find(candidate => candidate.matched !== null)

    const pmdWait = { kind: 'question', payload: { questions: [question] } }
    const pmdWinner = elect([pmdWait])
    assert.equal(pmdWinner.entry.component, modules.get('@accrui/harness-ui-knowledge-scope').SourceScopeQuestion)
    assert.equal(pmdWinner.matched, pmdWait)

    const ordinaryWait = { kind: 'question', payload: { questions: [{ ...question, id: 'ordinary_question' }] } }
    const ordinaryWinner = elect([ordinaryWait])
    assert.equal(ordinaryWinner.entry.component, genericQuestionComposer)
    assert.equal(ordinaryWinner.matched, ordinaryWait)
  } finally {
    dom.window.close()
    for (const [key, value] of prior) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
