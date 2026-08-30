import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('workspace directory entries use the compact picker row typography', async () => {
  const css = await readFile(new URL('../src/client/WorkspaceReviewAction.module.css', import.meta.url), 'utf8')
  assert.match(css, /.entry\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*36px;[^}]*font:\s*inherit;[^}]*font-size:\s*13px;[^}]*line-height:\s*18px;/s)
})

test('fullscreen directory drawer starts exactly below the Harness header with one continuous panel edge', async () => {
  const css = await readFile(new URL('../src/client/WorkspaceReviewAction.module.css', import.meta.url), 'utf8')
  assert.match(css, /\.fullscreenDrawer\s*\{[^}]*top:\s*72px;/s)
  assert.match(css, /\.drawer\s*\{[^}]*z-index:\s*200;[^}]*top:\s*8px;[^}]*right:\s*8px;[^}]*bottom:\s*8px;[^}]*border:\s*1px solid[^}]*border-radius:\s*12px;/s)
  assert.match(css, /\.drawer\s*\{[^}]*background:\s*var\(--dsw-alias-bg-overlay\);/s, 'the drawer must use the defined opaque overlay surface token')
  assert.doesNotMatch(css, /--dsw-(?:bg-primary|border-secondary|fg-(?:primary|secondary)|interactive-bg-hover)\b/, 'undefined legacy tokens make the drawer transparent')
  assert.doesNotMatch(css, /\.fullscreenDrawer\s*\{[^}]*margin|\.fullscreenDrawer\s*\{[^}]*padding/s)
})
