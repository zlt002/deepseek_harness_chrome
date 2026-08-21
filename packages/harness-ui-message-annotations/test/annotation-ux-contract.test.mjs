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

test('uses Harness theme tokens for the portal surface and interactive controls', async () => {
  const css = await source('../src/client/MessageAnnotations.module.css')
  assert.match(css, /z-index: 30/)
  assert.match(css, /pointer-events: none/)
  assert.match(css, /pointer-events: auto/)
  assert.match(css, /background: var\(--dsw-specific-menu\)/)
  assert.match(css, /border: 1px solid var\(--dsw-alias-border-inverted\)/)
  assert.match(css, /box-shadow: var\(--dsw-shadow-lv3\)/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}|var\(--dsw-(?:bg|fg|border|interactive)-/i)
})

test('keeps entry, textarea, and footer buttons theme-safe in both Harness themes', async () => {
  const css = await source('../src/client/MessageAnnotations.module.css')
  assert.match(css, /\.entry \{[^}]*var\(--dsw-alias-button-floating-fill\)[^}]*var\(--dsw-alias-label-primary\)/)
  assert.match(css, /\.entry:hover, \.entry:focus-visible \{[^}]*var\(--dsw-alias-button-floating-hover\)/)
  assert.match(css, /\.panel textarea \{[^}]*var\(--dsw-specific-input-major\)[^}]*var\(--dsw-alias-label-primary\)/)
  assert.match(css, /\.panel textarea::placeholder \{[^}]*var\(--dsw-alias-label-caption\)/)
  assert.match(css, /\.panel footer button:last-child \{[^}]*var\(--dsw-alias-button-primary-fill\)[^}]*var\(--dsw-alias-label-primary-foreground\)/)
  assert.match(css, /\.panel footer button:last-child:hover:not\(:disabled\) \{[^}]*var\(--dsw-alias-button-primary-hover\)/)
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

test('aligns the annotation chip with the composer card and knowledge-scope strip', async () => {
  const css = await source('../src/client/MessageAnnotations.module.css')
  assert.match(css, /max-width: var\(--dsh-composer-card-max-width\)/)
  assert.match(css, /margin: 0 auto 6px/)
  assert.match(css, /padding: 0 12px/)
  assert.doesNotMatch(css, /margin: 0 12px 6px/)
})
