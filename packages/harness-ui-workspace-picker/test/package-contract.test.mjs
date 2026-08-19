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
  assert.match(picker, /event\.key !== 'Escape'/)
  assert.match(picker, /function classes\(/)
  assert.doesNotMatch(picker, /from 'clsx'/)
  assert.match(picker, /IconEllipsisOutline16/)
  assert.match(picker, /owner\.startSession\(workspace\.id\)/)
  assert.match(picker, /owner\.renameWorkspace/)
  assert.match(picker, /owner\.deleteWorkspace/)
  assert.match(picker, /id: 'open'/)
  assert.match(picker, /id: 'rename'/)
  assert.match(picker, /id: 'delete'/)
  assert.match(picker, /owner\.openPath\(workspace\.path\)/)
  assert.match(picker, /owner\.labels\.openFolder/)
  assert.match(picker, /side="right"/)
  assert.match(picker, /owner\.labels\.deleteWorkspace/)
  assert.match(picker, /workspaceActionsAria/)
  assert.match(css, /\.popover\s*\{[^}]*display:\s*flex;/s, 'the compact picker must use a non-growing two-pane layout')
  assert.match(css, /\.popover\s*>\s*\.pane:first-child\s*\{[^}]*flex:\s*0\s+0\s+180px;[^}]*width:\s*180px;[^}]*overflow-x:\s*hidden;/s, 'the workspace pane must stay fixed-width and never expose horizontal scrolling')
  assert.match(css, /\.popover\s*>\s*\.pane:first-child\s+\.list\s*\{[^}]*overflow-x:\s*hidden;/s, 'the workspace list itself must not turn its vertical scroller into a horizontal one')
  assert.match(css, /\.sessionsPane\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s, 'the sessions pane must retain the remaining width without forcing the workspace pane wider')
  assert.match(picker, /css\.paneHeader[\s\S]*labels\.workspaces[\s\S]*css\.paneHeader[\s\S]*labels\.sessions/, 'both pane titles must share the same header row')
  assert.match(css, /\.paneHeader\s*\{[^}]*box-sizing:\s*border-box;[^}]*align-items:\s*center;[^}]*height:\s*32px;/s, 'workspace and session titles must occupy the same header height')
  assert.match(css, /\.paneTitle\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*height:\s*28px;[^}]*line-height:\s*16px;/s, 'pane titles must share the same text box as the add-workspace control')
  assert.match(css, /\.row\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s, 'picker rows must keep padding inside the pane and never overflow it')
  assert.match(css, /\.folder\s*\+\s*span\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s, 'long workspace names must truncate on one line')
  assert.match(css, /\.count\s*\{[^}]*flex-shrink:\s*0;/s, 'the workspace session count must remain visible')
  assert.match(css, /\.rowActions\s*\{[^}]*flex-shrink:\s*0;/s, 'hover actions must keep their full icon width')
  assert.match(css, /\.iconButton\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s, 'hover icons must keep a fixed hit target')
  assert.match(css, /\.row:hover \.count,\s*\.rowMenuOpen \.count\s*\{[^}]*display:\s*none;/s, 'hover and an open menu must hide the session count')
  assert.match(css, /\.row:hover \.rowActions,\s*\.rowMenuOpen \.rowActions\s*\{[^}]*display:\s*inline-flex;/s, 'hover and an open menu must reveal new-session plus the actions menu')
  assert.match(css, /@media \(max-width: 360px\)/)
})

test('the compact seat owner exposes workspace rename, delete, and new-session actions', async () => {
  const patch = await readFile(new URL('../../../upstream-contributions/0006-workspace-compact-seat.patch', import.meta.url), 'utf8')
  assert.match(patch, /renameWorkspace, deleteWorkspace, openPath, renderSlot, renderSlotChain, t/)
  assert.match(patch, /workspaceActionsAria: name => t\('actions\.workspace\.aria', \{ name \}\)/)
  assert.match(patch, /newSessionAria: name => t\('actions\.newSession\.aria', \{ name \}\)/)
  assert.match(patch, /path: workspace\.path/)
  assert.match(patch, /createdAt: Date\.parse\(workspace\.createdAt\)/)
  assert.match(patch, /renameWorkspace: \(workspaceId: WorkspaceId, title: string\) => Promise<void>/)
  assert.match(patch, /deleteWorkspace: \(workspaceId: WorkspaceId\) => Promise<void>/)
  assert.match(patch, /openPath: \(path: string\) => Promise<void>/)
  assert.match(patch, /openFolder: t\('open\.folder'\)/)
  assert.match(patch, /openPath: async \(path\) => \{ await ctx\.workspaces\.openPath\(path\) \}/)
})
