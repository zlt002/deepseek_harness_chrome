import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

function exportedValues(source, name) {
  const body = source.match(new RegExp(`export const ${name} = \\[((?:.|\\n)*?)\\] as const`))?.[1]
  assert.notEqual(body, undefined, `${name} is missing`)
  return [...body.matchAll(/'([^']+)'/g)].map(match => match[1])
}

test('both trusted renderers explicitly cover the canonical node and action language', async () => {
  const [schema, reactRuntime, iframeRuntime, reducer] = await Promise.all([
    readFile(new URL('../src/prototype-document.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/TrustedPrototypeRuntime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/chrome-extension/entrypoints/prototype-studio/sandbox-preview.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/runtime-state.ts', import.meta.url), 'utf8'),
  ])
  const nodeTypes = exportedValues(schema, 'PROTOTYPE_NODE_TYPES')
  const actionTypes = exportedValues(schema, 'PROTOTYPE_ACTION_TYPES')
  assert.deepEqual(nodeTypes, ['text', 'icon', 'button', 'input', 'card', 'group', 'metric', 'badge', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'breadcrumb', 'empty-state', 'pagination', 'modal'])
  assert.deepEqual(actionTypes, ['navigate', 'open-modal', 'close-modal', 'set-value', 'set-state', 'toggle', 'set-tab', 'submit-success', 'sequence', 'add-row', 'edit-row', 'delete-row'])
  assert.match(schema, /PROTOTYPE_ACTION_TYPES\.includes/)
  assert.match(schema, /PROTOTYPE_NODE_TYPES\.includes/)
  assert.match(schema, /!object\(value\).*?!PROTOTYPE_ACTION_TYPES\.includes\(value\.type as PrototypeActionType\).*?return false/s, 'unknown actions must be rejected by the closed schema')
  for (const type of nodeTypes) {
    assert.match(reactRuntime, new RegExp(`node\\.type === '${type}'`), `React runtime does not explicitly recognize ${type}`)
    assert.match(iframeRuntime, new RegExp(`node\\.type==='${type}'`), `iframe runtime does not explicitly recognize ${type}`)
  }
  for (const type of actionTypes) {
    const reducerPattern = type === 'sequence' ? /action\.type === 'sequence'/ : new RegExp(`case '${type}'`)
    assert.match(reducer, reducerPattern, `React reducer does not explicitly implement ${type}`)
    assert.match(iframeRuntime, new RegExp(`action\\.type==='${type}'`), `iframe runtime does not explicitly implement ${type}`)
  }
  for (const type of ['add-row', 'edit-row', 'delete-row']) {
    assert.match(reactRuntime, new RegExp(`action\\.type === '${type}'`), `React runtime does not explicitly handle ${type}`)
    assert.match(iframeRuntime, new RegExp(`action\\.type==='${type}'`), `iframe runtime does not explicitly handle ${type}`)
  }
  assert.match(reactRuntime, /if \(node\.type === 'tabs'\).*return null/s)
  assert.match(iframeRuntime, /if\(node\.type==='tabs'\).*return null/s)
})
