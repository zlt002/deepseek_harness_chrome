import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceFilePath } from '../src/client/workspace-file-path.mjs'

test('joins a Host-listed relative path to the native workspace root', () => {
  assert.equal(workspaceFilePath('/projects/accrui', 'spec/manifest.json'), '/projects/accrui/spec/manifest.json')
  assert.equal(workspaceFilePath('C:\\projects\\accrui', 'spec/manifest.json'), 'C:\\projects\\accrui\\spec\\manifest.json')
})

test('refuses a malformed display path before calling the system opener', () => {
  for (const displayPath of ['', '../secret.txt', 'spec/../../secret.txt', 'spec\\secret.txt']) {
    assert.throws(() => workspaceFilePath('/projects/accrui', displayPath), /workspace file path is invalid/)
  }
})
