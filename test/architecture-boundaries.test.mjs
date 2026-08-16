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

test('Harness product checkout pins LF before applying portable patches', async () => {
  const attributes = await readFile(resolve(root, '.gitattributes'), 'utf8')
  const script = await readFile(resolve(root, 'scripts/materialize-harness-product.mjs'), 'utf8')
  const clone = script.indexOf("runVisible('git', ['clone'")
  const autocrlf = script.indexOf("runVisible('git', ['config', 'core.autocrlf', 'false']")
  const eol = script.indexOf("runVisible('git', ['config', 'core.eol', 'lf']")
  const checkout = script.indexOf("runVisible('git', ['checkout'")
  const apply = script.indexOf("runVisible('git', ['apply', '--check'")

  assert.match(attributes, /^\*\.patch text eol=lf$/m)
  assert.match(script, /process\.env\.npm_execpath/)
  assert.doesNotMatch(script, /spawnSync\('pnpm'/)
  assert.ok(clone >= 0)
  assert.ok(clone < autocrlf && autocrlf < eol && eol < checkout && checkout < apply)
})

test('Harness client plugins execute the portable tsdown JavaScript entrypoint', async () => {
  const script = await readFile(resolve(root, 'scripts/build-harness-client-plugins.mjs'), 'utf8')

  assert.match(script, /node_modules', 'tsdown', 'dist', 'run\.mjs'/)
  assert.match(script, /spawnSync\(process\.execPath, \[tsdown/)
  assert.match(script, /DSH_ROOT: harnessRoot/)
  assert.doesNotMatch(script, /tsdown\.cmd/)

  for (const name of [
    'harness-ui-agent-preset',
    'harness-ui-browser-target',
    'harness-ui-knowledge-scope',
    'harness-skill-settings',
  ]) {
    const config = await readFile(resolve(root, 'packages', name, 'tsdown.config.ts'), 'utf8')
    assert.match(config, /loadHarnessClientBundle/)
    assert.doesNotMatch(config, /upstream\/deepseek-harness/)
  }
})
