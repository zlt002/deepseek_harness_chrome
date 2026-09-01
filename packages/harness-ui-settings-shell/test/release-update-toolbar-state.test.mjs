import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = await readFile(new URL('../src/client/release-update-toolbar-state.ts', import.meta.url), 'utf8')
const output = await build({ stdin: { contents: source, loader: 'ts', resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) }, bundle: true, format: 'esm', platform: 'node', write: false })
const state = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const [toolbarSource, toolbarCss, indexSource, sectionSource, confirmationSource] = await Promise.all([
  readFile(new URL('../src/client/ReleaseUpdateToolbar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/ReleaseUpdateToolbar.module.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/ReleaseUpdateSection.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/release-update-confirmation.ts', import.meta.url), 'utf8'),
])

test('compact upgrade action occupies no toolbar seat without a verified update', () => {
  assert.equal(state.supportsReleaseUpdateToolbar('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), true)
  assert.equal(state.supportsReleaseUpdateToolbar('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), false)
  assert.deepEqual(state.checkedReleaseToolbarState({ available: false }), { phase: 'hidden' })
  assert.equal(state.releaseToolbarAction({ phase: 'checking' }), undefined)
  assert.equal(state.releaseToolbarAction({ phase: 'hidden' }), undefined)
  assert.equal(state.releaseToolbarAction({ phase: 'error', error: 'network' }), undefined)
})

test('a verified update enables exactly the existing prepare action', () => {
  const ready = state.checkedReleaseToolbarState({ available: true, version: '1.1.76' })
  assert.deepEqual(ready, { phase: 'ready', version: '1.1.76' })
  assert.equal(state.releaseToolbarAction(ready), 'prepare')
  assert.match(indexSource, /sidebar\.compact\.action/)
  assert.match(toolbarSource, /request\('prepare', candidate\)/)
  assert.match(toolbarSource, /升级失败：/)
  assert.match(toolbarSource, /IconDownloadOutline16/)
  assert.match(toolbarSource, /aria-label=\{label\}/)
  assert.match(toolbarCss, /color:var\(--dsw-alias-state-success-primary\)/)
})

test('online update tells users to reopen only the side panel', () => {
  assert.match(sectionSource, /只需关闭当前侧边栏/)
  assert.match(sectionSource, /无需退出 Chrome 或 Edge/)
  assert.match(sectionSource, /最近一次更新失败/)
  assert.match(sectionSource, /最近一次更新成功/)
  assert.doesNotMatch(sectionSource, /扩展管理页重新加载扩展/)
})

test('every manual update entry warns before interrupting the current conversation', () => {
  assert.match(toolbarSource, /confirmReleaseUpdate\(\)/)
  assert.match(sectionSource, /confirmReleaseUpdate\(\)/)
  assert.match(confirmationSource, /正在执行的任务结束/)
  assert.match(confirmationSource, /window\.confirm/)
})

test('an expired update candidate clears the preparing state', () => {
  assert.match(sectionSource, /candidate === undefined\) \{[\s\S]*?setPending\(undefined\)[\s\S]*?return/)
})
