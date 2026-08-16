import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstream = resolve(root, 'upstream/deepseek-harness')

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const registered = git(['ls-files', '--stage', 'upstream/deepseek-harness'])
const expected = registered.split(/\s+/)[1]
if (!expected) throw new Error('upstream/deepseek-harness is not registered as a git submodule')

const actual = git(['rev-parse', 'HEAD'], upstream)
const dirty = git(['status', '--porcelain', '--untracked-files=all'], upstream)

if (actual !== expected) {
  throw new Error(`upstream/deepseek-harness is at ${actual}, expected ${expected}`)
}
if (dirty !== '') {
  throw new Error(`upstream/deepseek-harness contains local changes:\n${dirty}`)
}

console.log(`clean upstream DeepSeek Harness: ${actual}`)
