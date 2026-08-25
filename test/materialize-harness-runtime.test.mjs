import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertWindowsMaterializationHost,
  assertWindowsNativeClosure,
  legacyDeployArgs,
  materializeHarnessRuntime,
  parseMaterializerArgs,
} from '../release/windows-lite/materialize-harness-runtime.mjs'

async function writeFixture(root, relativePath, content = '') {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  return target
}

async function createCheckoutFixture() {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'harness-materializer-source-'))
  await writeFixture(sourceDir, 'package.json', JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  await writeFixture(sourceDir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  await writeFixture(sourceDir, 'apps/cli/lib/bin.js', 'console.log("source")\n')
  await writeFixture(sourceDir, 'apps/web/dist/index.html', '<!doctype html>')
  for (const [directory, name] of [
    ['vendor/cosmokit', '@deepseek-ai/cosmokit'],
    ['vendor/schemastery', '@deepseek-ai/schemastery'],
    ['vendor/group', '@deepseek-ai/cordis-plugin-group'],
    ['vendor/logger-console', '@deepseek-ai/cordis-plugin-logger-console'],
  ]) {
    await writeFixture(sourceDir, `${directory}/package.json`, JSON.stringify({ name }))
    await writeFixture(sourceDir, `${directory}/lib/index.js`, 'export {}\n')
    await writeFixture(sourceDir, `${directory}/node_modules/not-runtime.txt`, 'must not be copied\n')
  }
  for (const directory of ['native/landlock-run/packages/linux-arm64', 'native/landlock-run/packages/linux-x64']) {
    await writeFixture(sourceDir, `${directory}/package.json`, '{}')
  }
  return sourceDir
}

async function deployFixture({ deployDir }) {
  await writeFixture(deployDir, 'package.json', JSON.stringify({ name: '@deepseek-ai/dsh' }))
  await writeFixture(deployDir, 'lib/bin.js', 'console.log("dsh help")\n')
  await writeFixture(deployDir, 'config/default.yml', '[]\n')
  for (const packageName of ['dsh-app-boot', 'dsh-web-app', 'dsh-web-frontend']) {
    await writeFixture(deployDir, `node_modules/@deepseek-ai/${packageName}/package.json`, JSON.stringify({ name: `@deepseek-ai/${packageName}` }))
  }
}

test('Windows materializer refuses to manufacture a target runtime from macOS or another architecture', () => {
  assert.throws(() => assertWindowsMaterializationHost({ platform: 'darwin', arch: 'arm64' }), /Windows x64 runtime materialization must run on Windows x64/)
  assert.throws(() => assertWindowsMaterializationHost({ platform: 'win32', arch: 'arm64' }), /Windows x64 runtime materialization must run on Windows x64/)
  assert.doesNotThrow(() => assertWindowsMaterializationHost({ platform: 'win32', arch: 'x64' }))
})

test('Windows materializer requires an explicit built Harness source', async () => {
  await assert.rejects(materializeHarnessRuntime({ platform: 'win32', arch: 'x64' }), /requires an explicit sourceDir/)
})

test('materializer deploys a production closure, runs smoke, and only then writes the marker', async () => {
  const sourceDir = await createCheckoutFixture()
  const outputDir = path.join(await mkdtemp(path.join(tmpdir(), 'harness-materializer-output-')), 'runtime')
  let smokeCalled = false
  const result = await materializeHarnessRuntime({
    sourceDir,
    outputDir,
    revision: 'fixture-revision',
    platform: 'win32',
    arch: 'x64',
    resolveRevision: () => 'fixture-revision',
    deploy: async (options) => {
      await deployFixture(options)
      const nestedVendor = path.join(options.deployDir, 'node_modules/.pnpm/fake/node_modules/@deepseek-ai/cosmokit')
      await mkdir(path.dirname(nestedVendor), { recursive: true })
      await symlink(path.join(sourceDir, 'vendor/cosmokit'), nestedVendor, 'dir')
      const linuxOnly = path.join(options.deployDir, 'node_modules/.pnpm/fake/node_modules/@deepseek-ai/node-addon-landlock-run-linux-arm64')
      await symlink(path.join(sourceDir, 'native/landlock-run/packages/linux-arm64'), linuxOnly, 'dir')
      const cliSelfLink = path.join(options.deployDir, 'node_modules/.pnpm/node_modules/@deepseek-ai/dsh')
      await mkdir(path.dirname(cliSelfLink), { recursive: true })
      await symlink(path.join(sourceDir, 'apps/cli'), cliSelfLink, 'dir')
    },
    smoke(command, args, options) {
      smokeCalled = true
      assert.equal(command, process.execPath)
      assert.deepEqual(args, ['apps/cli/lib/bin.js', '--help'])
      assert.equal(options.cwd, path.join(`${outputDir}.staging`, 'runtime'))
      return { status: 0, stdout: 'dsh help\n', stderr: '' }
    },
  })
  assert.equal(smokeCalled, true)
  assert.equal(result.marker.closureComplete, true)
  assert.equal(result.marker.platform, 'win32')
  assert.equal(existsSync(path.join(outputDir, '.git')), false)
  assert.equal(existsSync(path.join(outputDir, 'apps/cli/lib/bin.js')), true)
  assert.equal(existsSync(path.join(outputDir, 'apps/web/dist/index.html')), true)
  assert.equal(existsSync(path.join(outputDir, 'node_modules/@deepseek-ai/cosmokit/lib/index.js')), true)
  assert.equal(existsSync(path.join(outputDir, 'node_modules/.pnpm/fake/node_modules/@deepseek-ai/cosmokit/lib/index.js')), true)
  assert.equal(existsSync(path.join(outputDir, 'node_modules/.pnpm/fake/node_modules/@deepseek-ai/node-addon-landlock-run-linux-arm64')), false)
  assert.equal(existsSync(path.join(outputDir, 'node_modules/.pnpm/node_modules/@deepseek-ai/dsh')), false)
  assert.equal(existsSync(path.join(outputDir, 'node_modules/@deepseek-ai/cordis-plugin-logger-console/package.json')), true)
  assert.equal(existsSync(path.join(outputDir, 'node_modules/@deepseek-ai/cordis-plugin-group/node_modules/not-runtime.txt')), false)
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, 'harness-runtime.json'), 'utf8')), result.marker)
})

test('materializer leaves no marker behind when the host-level smoke fails', async () => {
  const sourceDir = await createCheckoutFixture()
  const outputDir = path.join(await mkdtemp(path.join(tmpdir(), 'harness-materializer-smoke-')), 'runtime')
  await assert.rejects(materializeHarnessRuntime({
    sourceDir,
    outputDir,
    revision: 'fixture-revision',
    platform: 'win32',
    arch: 'x64',
    resolveRevision: () => 'fixture-revision',
    deploy: deployFixture,
    smoke: () => ({ status: 1, stdout: '', stderr: 'broken deploy' }),
  }), /Harness runtime smoke failed/)
  assert.equal(existsSync(path.join(outputDir, 'harness-runtime.json')), false)
})

test('materializer checks the active Windows x64 node-pty prebuild but ignores its other platform prebuilds', async () => {
  const nodeModulesDir = await mkdtemp(path.join(tmpdir(), 'harness-native-addon-'))
  await writeFixture(nodeModulesDir, 'node-pty/prebuilds/darwin-arm64/pty.node', 'Mach-O')
  const target = path.join(nodeModulesDir, 'node-pty/prebuilds/win32-x64/pty.node')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
  assert.deepEqual(await assertWindowsNativeClosure(nodeModulesDir), ['node-pty/prebuilds/win32-x64/pty.node'])
})

test('materializer rejects a non-Windows active platform addon instead of marking it complete', async () => {
  const nodeModulesDir = await mkdtemp(path.join(tmpdir(), 'harness-native-addon-'))
  await writeFixture(nodeModulesDir, '@img/sharp-darwin-arm64/lib/sharp.node', 'Mach-O')
  await assert.rejects(assertWindowsNativeClosure(nodeModulesDir), /non-Windows platform native package/)
})

test('materializer uses pnpm legacy deploy for pnpm 11 workspace closure compatibility', () => {
  assert.deepEqual(legacyDeployArgs({ sourceDir: 'D:\\harness', deployDir: 'D:\\deploy' }), [
    '--dir', 'D:\\harness', '--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', '--ignore-scripts', 'D:\\deploy',
  ])
})

test('materializer CLI only accepts explicit source, output, and revision inputs', () => {
  assert.deepEqual(parseMaterializerArgs(['--source', 'D:\\harness', '--out', 'D:\\runtime', '--revision', 'abc123']), {
    sourceDir: 'D:\\harness', outputDir: 'D:\\runtime', revision: 'abc123',
  })
  assert.throws(() => parseMaterializerArgs([]), /Missing required option: --source/)
  assert.throws(() => parseMaterializerArgs(['--source', 'D:\\harness']), /Missing required option: --out/)
  assert.throws(() => parseMaterializerArgs(['--source', 'D:\\harness', '--out', 'D:\\runtime']), /Missing required option: --revision/)
  assert.throws(() => parseMaterializerArgs(['--platform', 'win32']), /Unknown argument/)
})
