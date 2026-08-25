import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function navigationModule() {
  const source = await readFile(new URL('./example-tab-navigation.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}`)
}

test('example tabs support the standard arrow, Home, and End keyboard pattern', async () => {
  const { nextExampleTab } = await navigationModule()
  assert.equal(nextExampleTab('overview', 'ArrowRight'), 'components')
  assert.equal(nextExampleTab('components', 'ArrowLeft'), 'overview')
  assert.equal(nextExampleTab('overview', 'ArrowDown'), 'components')
  assert.equal(nextExampleTab('components', 'ArrowUp'), 'overview')
  assert.equal(nextExampleTab('components', 'Home'), 'overview')
  assert.equal(nextExampleTab('overview', 'End'), 'components')
  assert.equal(nextExampleTab('overview', 'Enter'), undefined)
})
