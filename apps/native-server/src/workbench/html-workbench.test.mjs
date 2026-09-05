import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { atomicWrite, fingerprint, previewEdits, readWorkspace, safeEditPath } from './html-workbench.mjs'

async function temporaryRoot() { return mkdtemp(join(await realpath(tmpdir()), 'html-workbench-')) }

test('HTML Workbench reads only local linked CSS and produces reviewable diffs', async () => {
  const root = await temporaryRoot()
  try {
    await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="site.css"><main>old</main>')
    await writeFile(join(root, 'site.css'), '.a{color:red}')
    const url = new URL(`file://${join(root, 'index.html')}`).href
    const preview = await previewEdits(url, [{ path: 'index.html', content: '<main>new</main>' }, { path: 'site.css', content: '.a{color:blue}' }])
    assert.match(preview.diff, /--- index\.html/); assert.match(preview.diff, /\+<main>new<\/main>/)
    assert.equal(preview.snapshot.stylesheets.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTML Workbench rejects remote, parent, and unlinked CSS writes', async () => {
  const root = await temporaryRoot()
  try {
    await writeFile(join(root, 'index.html'), '<main>x</main>')
    const url = new URL(`file://${join(root, 'index.html')}`).href
    await assert.rejects(() => previewEdits(url, [{ path: '../escape.css', content: 'x' }]), /out-of-workspace/)
    await assert.rejects(() => previewEdits(url, [{ path: 'other.css', content: 'x' }]), /linked same-directory CSS/)
    const workspace = await readWorkspace(url)
    assert.throws(() => safeEditPath(workspace, 'https://bad/x.css'), /out-of-workspace/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTML Workbench atomic writes preserve exact readback', async () => {
  const root = await temporaryRoot()
  try {
    const page = join(root, 'index.html'); await writeFile(page, 'old')
    await atomicWrite([{ absolute: page, content: 'new' }])
    assert.equal(await readFile(page, 'utf8'), 'new'); assert.equal(fingerprint('new').length, 64)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTML Workbench keeps the write bound to the verified directory when its pathname is swapped before temp creation', async () => {
  const root = await temporaryRoot(); const outside = await temporaryRoot(); const moved = `${root}-moved`
  try {
    const page = join(root, 'index.html'); const outsidePage = join(outside, 'index.html')
    await writeFile(page, 'old'); await writeFile(outsidePage, 'outside')
    await atomicWrite([{ absolute: page, content: 'new' }], {
      beforeTemporaryCreate: async () => { await rename(root, moved); await symlink(outside, root) },
    })
    assert.equal(await readFile(join(moved, 'index.html'), 'utf8'), 'new')
    assert.equal(await readFile(outsidePage, 'utf8'), 'outside')
  } finally { await rm(root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('HTML Workbench rejects symlinked HTML/CSS and bounded reads fail before a write', async () => {
  const root = await temporaryRoot()
  try {
    await writeFile(join(root, 'real.html'), '<main>safe</main>'); await symlink(join(root, 'real.html'), join(root, 'index.html'))
    const url = new URL(`file://${join(root, 'index.html')}`).href
    await assert.rejects(() => readWorkspace(url), /Symlinked HTML/)
    await rm(join(root, 'index.html')); await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="site.css">')
    await writeFile(join(root, 'real.css'), '.safe{}'); await symlink(join(root, 'real.css'), join(root, 'site.css'))
    await assert.rejects(() => readWorkspace(url), /Symlinked CSS/)
    await rm(join(root, 'site.css')); await writeFile(join(root, 'site.css'), 'x'.repeat(250_001))
    await assert.rejects(() => readWorkspace(url), /CSS file exceeds/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTML Workbench rejects symlinked HTML and CSS ancestors', async () => {
  const root = await temporaryRoot()
  try {
    const realHtml = join(root, 'real-html'); await mkdir(realHtml); await writeFile(join(realHtml, 'index.html'), '<main>safe</main>')
    const linkedHtml = join(root, 'linked-html'); await symlink(realHtml, linkedHtml)
    const linkedHtmlUrl = new URL(`file://${join(linkedHtml, 'index.html')}`).href
    await assert.rejects(() => readWorkspace(linkedHtmlUrl), /Symlinked HTML Browser Target/)

    const styleRoot = join(root, 'styles-real'); await mkdir(styleRoot); await writeFile(join(styleRoot, 'site.css'), '.safe{}')
    await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="styles/site.css">')
    await symlink(styleRoot, join(root, 'styles'))
    const url = new URL(`file://${join(root, 'index.html')}`).href
    await assert.rejects(() => readWorkspace(url), /Symlinked CSS/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
