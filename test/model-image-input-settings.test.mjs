import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const upstream = resolve(root, 'upstream/deepseek-harness')
const patchName = '0014-model-image-input-checkbox.patch'

test('model image-input checkbox seam applies to the clean upstream', () => {
  execFileSync('git', ['apply', '--check', resolve(root, 'upstream-contributions', patchName)], {
    cwd: upstream,
    stdio: 'pipe',
  })
  const patch = readFileSync(resolve(root, 'upstream-contributions', patchName), 'utf8')
  assert.match(patch, /modelSupportsImage/)
  assert.match(patch, /input: event\.target\.checked \? \[\.\.\.IMAGE_INPUT\] : undefined/)
  assert.match(patch, /input: \['text', 'image'\]/)
  assert.match(patch, /支持多模态图片/)
  assert.doesNotMatch(patch, /AccrUI|accrui/)
})
