import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PRODUCT_PLUGINS, PRODUCT_TYPECHECK_PLUGIN_PACKAGE_NAMES, PRODUCT_UI_PLUGIN_DIRECTORIES, PRODUCT_UI_PLUGIN_PACKAGE_NAMES } from '../apps/native-server/src/product-plugin-manifest.mjs'

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

test('product plugin manifest drives portable client builds and root quality commands', async () => {
  const script = await readFile(resolve(root, 'scripts/build-harness-client-plugins.mjs'), 'utf8')
  const nativeInstall = await readFile(resolve(root, 'scripts/register-native-host.mjs'), 'utf8')
  const harnessProcess = await readFile(resolve(root, 'apps/native-server/src/harness-process.mjs'), 'utf8')
  const commandRunner = await readFile(resolve(root, 'scripts/run-product-plugin-command.mjs'), 'utf8')
  const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

  assert.match(script, /node_modules', 'tsdown', 'dist', 'run\.mjs'/)
  assert.match(script, /spawnSync\(process\.execPath, \[tsdown/)
  assert.match(script, /DSH_ROOT: harnessRoot/)
  assert.doesNotMatch(script, /tsdown\.cmd/)
  assert.match(script, /PRODUCT_UI_PLUGIN_DIRECTORIES/)
  assert.match(nativeInstall, /PRODUCT_UI_PLUGIN_DIRECTORIES/)
  assert.match(harnessProcess, /PRODUCT_UI_PLUGIN_PACKAGE_NAMES/)
  assert.match(commandRunner, /PRODUCT_PLUGIN_PACKAGE_NAMES/)
  assert.match(commandRunner, /PRODUCT_TYPECHECK_PLUGIN_PACKAGE_NAMES/)
  assert.equal(rootManifest.scripts['typecheck:plugins'], 'node scripts/run-product-plugin-command.mjs typecheck')
  assert.equal(rootManifest.scripts['test:plugins'], 'node scripts/run-product-plugin-command.mjs test')
  assert.equal(rootManifest.scripts.pretest, 'node scripts/prepare-test-runtime.mjs')
  assert.equal(rootManifest.scripts.test, 'node --test --test-concurrency=1 test/*.test.mjs && pnpm test:plugins')

  assert.deepEqual(PRODUCT_UI_PLUGIN_DIRECTORIES, [
    'harness-ui-agent-preset',
    'harness-ui-browser-target',
    'harness-ui-conversation-shell',
    'harness-ui-message-annotations',
    'harness-ui-responsive-sidebar',
    'harness-ui-workspace-picker',
    'harness-ui-account-access',
    'harness-ui-knowledge-scope',
    'harness-ui-subagent-compact',
    'harness-ui-session-log-copy',
    'harness-ui-settings-shell',
    'harness-ui-document-intake',
    'harness-ui-workspace-review',
    'harness-ui-prototype-studio',
    'harness-skill-settings',
    'harness-ui-file-url-paste',
    'harness-ui-html-workbench',
  ])
  assert.equal(PRODUCT_UI_PLUGIN_PACKAGE_NAMES.length, 17)
  assert.equal(PRODUCT_TYPECHECK_PLUGIN_PACKAGE_NAMES.length, 17)
  assert.deepEqual(PRODUCT_UI_PLUGIN_PACKAGE_NAMES.slice(7, 11), [
    '@accrui/harness-ui-subagent-compact',
    '@accrui/harness-ui-session-log-copy',
    '@accrui/harness-ui-settings-shell',
    '@accrui/harness-ui-knowledge-scope',
  ])

  for (const name of PRODUCT_UI_PLUGIN_DIRECTORIES) {
    const config = await readFile(resolve(root, 'packages', name, 'tsdown.config.ts'), 'utf8')
    assert.match(config, /loadHarnessClientBundle/)
    assert.doesNotMatch(config, /upstream\/deepseek-harness/)
  }

  for (const plugin of PRODUCT_PLUGINS) {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages', plugin.directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, plugin.packageName)
    assert.equal(typeof manifest.scripts?.test, 'string', `${plugin.directory} is missing its package test command`)
    if (plugin.typecheck) assert.equal(typeof manifest.scripts?.typecheck, 'string', `${plugin.directory} is missing its package typecheck command`)
  }
})

test('Windows release workflow retains upstream, typecheck, and complete test gates', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/build-windows-lite.yml'), 'utf8')
  assert.match(workflow, /run: pnpm verify:upstream/)
  assert.match(workflow, /pnpm typecheck\r?\n\s+pnpm typecheck:plugins\r?\n\s+pnpm sync-harness-assets\r?\n\s+pnpm test/)
})

test('product commands never silently fall back to the clean upstream checkout', async () => {
  for (const relativePath of [
    'scripts/build-harness-client-plugins.mjs',
    'scripts/sync-harness-assets.mjs',
    'scripts/load-harness-client-bundle.mjs',
    'scripts/register-native-host.mjs',
    'scripts/restart-dev.mjs',
    'apps/native-server/src/harness-process.mjs',
    'release/mac-lite/build-mac-production.mjs',
    'release/windows-lite/materialize-harness-runtime.mjs',
  ]) {
    const source = await readFile(resolve(root, relativePath), 'utf8')
    assert.doesNotMatch(source, /upstream\/deepseek-harness/, `${relativePath} still falls back to the clean upstream checkout`)
  }

  for (const relativePath of [
    'scripts/build-harness-client-plugins.mjs',
    'scripts/sync-harness-assets.mjs',
    'scripts/load-harness-client-bundle.mjs',
    'scripts/register-native-host.mjs',
    'scripts/restart-dev.mjs',
    'apps/native-server/src/harness-process.mjs',
    'release/mac-lite/build-mac-production.mjs',
  ]) {
    const source = await readFile(resolve(root, relativePath), 'utf8')
    assert.match(source, /pnpm build:harness-product/, `${relativePath} does not explain how to create the required product Harness`)
  }
})
