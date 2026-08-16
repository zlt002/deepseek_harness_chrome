import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function exists(relativePath) {
  try {
    await access(resolve(root, relativePath))
    return true
  } catch {
    return false
  }
}

async function sourceFiles(directory) {
  const result = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const child = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (['.js', '.mjs', '.ts', '.tsx'].includes(extname(entry.name))) result.push(child)
    }
  }
  await visit(resolve(root, directory))
  return result
}

test('root orchestrates apps while product code stays outside the clean upstream', async () => {
  for (const obsolete of ['entrypoints', 'native-server', 'src', 'wxt.config.ts']) {
    assert.equal(await exists(obsolete), false, `obsolete root application path still exists: ${obsolete}`)
  }
  for (const required of [
    'apps/chrome-extension/entrypoints',
    'apps/chrome-extension/wxt.config.ts',
    'apps/native-server/src',
    'packages/harness-runtime/src',
    'upstream/deepseek-harness/.git',
    'upstream-contributions',
  ]) {
    assert.equal(await exists(required), true, `required architecture path is missing: ${required}`)
  }
  assert.equal(await exists('release/windows-lite/harness-ui.patch'), false)

  const workspace = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /apps\/\*/)
  assert.match(workspace, /packages\/\*/)

  for (const file of await sourceFiles('packages')) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /upstream\/deepseek-harness\/.*\/src/, `product package imports upstream source: ${file}`)
  }
})
