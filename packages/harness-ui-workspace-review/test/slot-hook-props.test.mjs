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
    load: ({ factory }) => { client = factory(specifier => specifier.startsWith('@deepseek-ai/') ? {} : require(specifier)) },
  },
}
require('../lib/client.js')
const { WorkspaceReviewTree } = client

test('renders the picker child tree with no selected workspace session', () => {
  const props = {
    sessionId: undefined,
    bridge: undefined,
    onOpenFile: async () => {},
    refreshGeneration: 0,
    onClose: () => {},
  }

  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(WorkspaceReviewTree, props)))
})
