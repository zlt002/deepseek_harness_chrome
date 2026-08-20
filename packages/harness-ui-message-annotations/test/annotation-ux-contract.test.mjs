import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('anchors the compact entry to the selected tail rect instead of covering the following paragraph', async () => {
  const geometry = await source('../src/client/selection-geometry.js')
  assert.match(geometry, /getClientRects\(\)/)
  assert.match(geometry, /placement: 'right'/)
})

test('keeps the editor compact and avoids duplicating the entire selected quote', async () => {
  const [view, css] = await Promise.all([
    source('../src/client/MessageAnnotations.tsx'),
    source('../src/client/MessageAnnotations.module.css'),
  ])
  assert.doesNotMatch(view, /<blockquote>/)
  assert.match(view, /已选择 \{draft\.quote\.length\} 字/)
  assert.match(css, /max-height: min\(246px, calc\(100vh - 16px\)\)/)
  assert.match(css, /text-overflow: ellipsis/)
})

test('uses a collapsed annotation chip and a bounded page-level preview instead of expanding the composer', async () => {
  const [view, css] = await Promise.all([
    source('../src/client/MessageAnnotations.tsx'),
    source('../src/client/MessageAnnotations.module.css'),
  ])
  assert.doesNotMatch(view, /<details/)
  assert.match(view, /aria-label="查看批注"/)
  assert.match(view, /createPortal\(preview/)
  assert.match(css, /\.trayPopover/)
  assert.match(css, /width: min\(320px, calc\(100vw - 16px\)\)/)
  assert.match(css, /max-height: min\(280px, calc\(100vh - 16px\)\)/)
  assert.match(css, /overflow-wrap: anywhere/)
})

test('gives the page portal an evidence-based interactive overlay layer and an opaque fallback surface', async () => {
  const css = await source('../src/client/MessageAnnotations.module.css')
  assert.match(css, /z-index: 30/)
  assert.match(css, /pointer-events: none/)
  assert.match(css, /pointer-events: auto/)
  assert.match(css, /background: var\(--dsw-bg-primary, #fff\)/)
})

test('keeps the non-editing entry shrink-wrapped while retaining a fixed editor panel', async () => {
  const [view, css] = await Promise.all([
    source('../src/client/MessageAnnotations.tsx'),
    source('../src/client/MessageAnnotations.module.css'),
  ])
  assert.match(view, /css\.entryPanel/)
  assert.match(css, /\.entryPanel \{[^}]*width: fit-content/)
  assert.match(css, /\.editorPanel \{[^}]*width: min\(280px/)
})

test('waits for a stable selection before showing the entry and clears the timer', async () => {
  const view = await source('../src/client/MessageAnnotations.tsx')
  assert.match(view, /SELECTION_STABILITY_DELAY_MS = 500/)
  assert.match(view, /selectionTimerRef/)
  assert.match(view, /clearTimeout\(selectionTimerRef\.current\)/)
  assert.match(view, /setTimeout\(\(\) => \{/)
  assert.match(view, /selectionTimerRef\.current = undefined/)
})
