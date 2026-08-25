import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

test('workspace switch invalidates an old directory response before it can update the new tree', async () => {
  const source = await readFile(new URL('../src/client/tree-request-generation.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports })
  const generation = new module.exports.WorkspaceTreeRequestGeneration()
  const workspaceA = generation.reset()
  const workspaceB = generation.reset()
  assert.equal(generation.isCurrent(workspaceA), false)
  assert.equal(generation.isCurrent(workspaceB), true)
})
