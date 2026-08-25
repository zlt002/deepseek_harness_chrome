import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('workspace directory entries use the compact picker row typography', async () => {
  const css = await readFile(new URL('../src/client/WorkspaceReviewAction.module.css', import.meta.url), 'utf8')
  assert.match(css, /.entry\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*36px;[^}]*font:\s*inherit;[^}]*font-size:\s*13px;[^}]*line-height:\s*18px;/s)
})
