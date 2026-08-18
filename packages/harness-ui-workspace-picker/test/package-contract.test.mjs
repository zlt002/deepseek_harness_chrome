import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

test('keeps the e327 compact picker in an out-of-tree public workspace seat', async () => {
  const [client, picker, css] = await Promise.all([
    read('src/client/index.ts'), read('src/client/CompactWorkspacePicker.tsx'), read('src/client/CompactWorkspacePicker.module.css'),
  ])
  assert.match(client, /sidebar\.workspaces\.compact/)
  assert.match(
    client,
    /name:\s*'sidebar\.workspaces\.compact'[\s\S]*?select:\s*owner\s*=>\s*owner[\s\S]*?CompactWorkspacePicker/,
    'chain workspace registration must select the matched owner',
  )
  assert.match(picker, /requestWorkspaceAdd/)
  assert.match(picker, /owner\.directoryFlow/)
  assert.match(picker, /document\.addEventListener\('pointerdown'/)
  assert.match(picker, /event\.key === 'Escape'/)
  assert.match(picker, /function classes\(/)
  assert.doesNotMatch(picker, /from 'clsx'/)
  assert.match(css, /\.popover\s*\{[^}]*display:\s*flex;/s, 'the compact picker must use a non-growing two-pane layout')
  assert.match(css, /\.popover\s*>\s*\.pane:first-child\s*\{[^}]*flex:\s*0\s+0\s+180px;[^}]*width:\s*180px;[^}]*overflow-x:\s*hidden;/s, 'the workspace pane must stay fixed-width and never expose horizontal scrolling')
  assert.match(css, /\.popover\s*>\s*\.pane:first-child\s+\.list\s*\{[^}]*overflow-x:\s*hidden;/s, 'the workspace list itself must not turn its vertical scroller into a horizontal one')
  assert.match(css, /\.sessionsPane\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s, 'the sessions pane must retain the remaining width without forcing the workspace pane wider')
  assert.match(css, /\.row\s*\{[^}]*min-width:\s*0;/s, 'picker rows must be allowed to shrink')
  assert.match(css, /\.folder\s*\+\s*span\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s, 'long workspace names must truncate on one line')
  assert.match(css, /\.count\s*\{[^}]*flex-shrink:\s*0;/s, 'the workspace session count must remain visible')
  assert.match(css, /@media \(max-width: 360px\)/)
})
