import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

// Client bundles deliberately externalize React to the materialized Harness.
// Make that runtime available before loading the real compiled component.
process.env.NODE_PATH = new URL('../../../.generated/harness-product/node_modules/', import.meta.url).pathname
createRequire(import.meta.url)('node:module').Module._initPaths()

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
let client
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      client = factory(specifier => {
        if (specifier === '@deepseek-ai/dsh-client-runtime/client') {
          return {
            createSnapshotStore(initial) {
              return {
                getSnapshot: () => initial,
                set: () => {},
                subscribe: () => () => {},
              }
            },
          }
        }
        return specifier.startsWith('@deepseek-ai/') ? {} : require(specifier)
      })
    },
  },
}
require('../lib/client.js')
const { ConversationPresentation, apply } = client

test('renders when the conversation slot maps injected presentation stores to hooks', () => {
  const props = {
    matched: {
      phase: 'hero',
      renderHeader: () => null,
      renderHero: () => null,
      renderSession: () => null,
      renderComposer: () => null,
    },
    useShowProcess: selector => selector(false),
    useComposerFullscreen: selector => selector(false),
  }

  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(ConversationPresentation, props)))
})

test('renders the process visibility settings row from the injected useShowProcess hook', () => {
  let settingsRow
  const settingsScope = {
    bind: () => ({ getSnapshot: () => ({ value: undefined }), subscribe: () => () => {}, set: () => Promise.resolve() }),
  }
  apply({
    settingsScope,
    get: name => name === 'permissionLabels'
      ? { register: () => () => {} }
      : { setView: () => {}, register: () => () => {} },
    effect: () => {},
    inject: () => {},
    slots: {
      inject: (_name, callback) => { callback() },
      register: (definition, component) => {
        if (definition.id === 'process-visibility') settingsRow = component
        return () => {}
      },
    },
  })

  const markup = renderToStaticMarkup(React.createElement(settingsRow, {
    useShowProcess: selector => selector(false),
    setShowProcess: () => {},
  }))

  assert.match(markup, /aria-label="显示会话过程"/)
  assert.doesNotMatch(markup, /checked=""/)
})
