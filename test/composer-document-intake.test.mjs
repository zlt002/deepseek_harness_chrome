import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { productUiPatch } from '../apps/native-server/src/runtime/harness-process.mjs'

const root = resolve(import.meta.dirname, '..')
const upstream = resolve(root, 'upstream/deepseek-harness')
const patchName = '0015-composer-file-intake.patch'

test('composer file-intake seam stacks after earlier conversation seams', async (t) => {
  const patch = readFileSync(resolve(root, 'upstream-contributions', patchName), 'utf8')
  assert.match(patch, /composerFileIntake/)
  assert.match(patch, /isComposerImageFile/)
  assert.match(patch, /intake\.accept\(sessionId, documents\)/)
  assert.doesNotMatch(patch, /AccrUI|accrui|docx|pptx|xlsx/)

  const work = await mkdtemp(join(tmpdir(), 'accr-composer-file-intake-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const checkout = join(work, 'h')
  execFileSync('git', ['clone', '--no-local', '--no-checkout', upstream, checkout], { stdio: 'pipe' })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: checkout, stdio: 'pipe' })
  execFileSync('git', ['config', 'core.eol', 'lf'], { cwd: checkout, stdio: 'pipe' })
  execFileSync('git', ['checkout', '--detach', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim()], {
    cwd: checkout,
    stdio: 'pipe',
  })
  const patches = (await readdir(resolve(root, 'upstream-contributions')))
    .filter(name => name.endsWith('.patch'))
    .sort()
  for (const name of patches) {
    execFileSync('git', ['apply', '--whitespace=error', resolve(root, 'upstream-contributions', name)], {
      cwd: checkout,
      stdio: 'pipe',
    })
  }
})

test('product runtime mounts document intake through the generic file-intake seam', () => {
  const host = readFileSync(resolve(root, 'packages/harness-ui-document-intake/src/index.ts'), 'utf8')
  const client = readFileSync(resolve(root, 'packages/harness-ui-document-intake/src/client/index.ts'), 'utf8')
  const boot = readFileSync(resolve(root, 'apps/chrome-extension/public/harness/boot.js'), 'utf8')
  assert.match(productUiPatch({}), /@accrui\/harness-ui-document-intake/)
  assert.match(host, /\/api\/composer\.document/)
  assert.match(client, /composerFileIntake/)
  assert.match(client, /conversation\.input\.left/)
  assert.match(boot, /@accrui\/harness-ui-document-intake/)
})
