import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

async function moduleAt(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports })
  return module.exports
}

test('directory session keeps the current session only when it belongs to the selected workspace', async () => {
  const { selectWorkspaceDirectorySession } = await moduleAt('../src/client/directory-selection.ts')
  const sessions = [{ id: 'first' }, { id: 'current' }]
  assert.equal(selectWorkspaceDirectorySession(sessions, 'current').id, 'current')
  assert.equal(selectWorkspaceDirectorySession(sessions, 'outside').id, 'first')
  assert.equal(selectWorkspaceDirectorySession([], 'current'), undefined)
})

test('popover max height is exactly trigger-bottom to visible-bottom less the safe inset', async () => {
  const { workspacePickerMaxHeight } = await moduleAt('../src/client/popover-geometry.ts')
  assert.equal(workspacePickerMaxHeight(300.9, 800.2), 487)
  assert.equal(workspacePickerMaxHeight(900, 800), 0)
})

test('tabs use roving keyboard navigation from either tab', async () => {
  const { workspacePickerTabForKey } = await moduleAt('../src/client/tab-navigation.ts')
  assert.equal(workspacePickerTabForKey('sessions', 'ArrowRight'), 'directory')
  assert.equal(workspacePickerTabForKey('directory', 'ArrowLeft'), 'sessions')
  assert.equal(workspacePickerTabForKey('directory', 'Home'), 'sessions')
  assert.equal(workspacePickerTabForKey('sessions', 'End'), 'directory')
  assert.equal(workspacePickerTabForKey('sessions', 'Enter'), undefined)
})
