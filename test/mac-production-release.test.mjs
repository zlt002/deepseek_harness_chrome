import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildMacProductionPackage } from '../release/mac-lite/build-mac-production.mjs'
import { decodeNativeFrames, encodeNativeFrame } from '../apps/native-server/src/protocol.mjs'

test('Mac production package boots the real Web surface without node_modules', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return t.skip('Mac ARM64 native package test')

  const root = await mkdtemp(path.join(tmpdir(), 'accr-ui-mac-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const releaseDir = path.join(root, 'release')
  await mkdir(releaseDir)
  const result = await buildMacProductionPackage({ releaseDir })
  const payloadZip = path.join(result.packageDir, 'payload.zip')
  const entries = execFileSync('unzip', ['-Z1', payloadZip], { encoding: 'utf8' })
  assert.doesNotMatch(entries, /(^|\/)node_modules\//m)
  assert.doesNotMatch(entries, /\.map$/m)
  assert.match(entries, /runtime\/harness\/apps\/cli\/lib\/code-runtime-worker\.cjs/m)
  assert.match(entries, /runtime\/harness\/apps\/cli\/lib\/workflow-worker\.cjs/m)
  assert.match(entries, /runtime\/native-server\/selected-source-routing-prompt\.mjs/m)
  assert.match(entries, /runtime\/native-server\/harness-runtime\.mjs/m)
  assert.match(entries, /runtime\/product-plugins\/harness-ui-subagent-compact\/lib\/client\.js/m)

  const installed = path.join(root, 'installed')
  await mkdir(installed)
  execFileSync('ditto', ['-x', '-k', payloadZip, installed])
  const server = path.join(installed, 'runtime/harness/apps/cli/lib/server.mjs')
  const serverSource = await readFile(server, 'utf8')
  assert.match(serverSource, /\.\/code-runtime-worker\.cjs/)
  assert.match(serverSource, /\.\/workflow-worker\.cjs/)
  const packagedLauncher = await readFile(path.join(installed, 'runtime/run-native-host.sh'), 'utf8')
  assert.doesNotMatch(packagedLauncher, /DSH_(?:LEGACY_UI_OVERLAY|ENABLE_KNOWLEDGE_SCOPE_UI|ENABLE_SKILL_SETTINGS_UI)/)
  assert.match(packagedLauncher, /DSH_PRODUCT_PLUGIN_ROOT=/)
  const helper = path.join(installed, 'runtime/native/node-pty/spawn-helper')
  const home = path.join(root, 'home')
  const profile = path.join(home, 'profiles/web')
  const plugin = path.join(profile, 'node_modules/test-harness-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'mac-release-test-profile',
    private: true,
    dependencies: { 'test-harness-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'test-harness-plugin'] } },
  }))
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'test-harness-plugin',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.mjs', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(path.join(plugin, 'index.mjs'), 'export const name = "mac-release-external-plugin"\nexport function apply() {}\n')
  await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: mac-release-external-plugin\n      name: test-harness-plugin\n')
  const child = spawn(process.execPath, [server, '--profile', 'web', '--port', '0'], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_ROOT: path.join(installed, 'runtime/harness'),
      DSH_CWD: path.join(installed, 'workspace'),
      DSH_NODE_PTY_SPAWN_HELPER: helper,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGTERM'))
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Web startup timed out: ${stderr}`)), 20_000)
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Web process exited before readiness (${code}): ${stderr}`))
    })
  })
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<title>DeepSeek Harness<\/title>/)
  const bootMatch = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/)
  assert.notEqual(bootMatch, null)
  const boot = JSON.parse(bootMatch[1])
  assert.ok(boot.entries.length >= 30, `Expected the Harness Web client graph, received ${boot.entries.length} entries`)
  for (const entry of boot.entries) {
    const clientResponse = await fetch(new URL(entry.url, url))
    assert.equal(clientResponse.status, 200, `Missing client bundle for ${entry.id}`)
  }

  const pluginInventoryResponse = await fetch(new URL('/api/pluginInventory/list', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'mac-release-plugin-inventory',
      method: 'pluginInventory/list',
      payload: { args: {} },
    }),
  })
  assert.equal(pluginInventoryResponse.status, 200)
  const pluginInventoryBody = await pluginInventoryResponse.json()
  assert.equal(pluginInventoryBody.result.ok, true, JSON.stringify(pluginInventoryBody.result))
  assert.ok(pluginInventoryBody.result.value.entries.length > 0, 'Expected the Host plugin inventory')

  for (const [method, args] of [
    ['dynamicCordisRunner/inventory', {}],
    ['dynamicCordisRunner/syncInspectManifest', { providers: [] }],
  ]) {
    const remoteResponse = await fetch(new URL(`/api/${method}`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `mac-release-${method}`,
        method,
        payload: { args },
      }),
    })
    assert.equal(remoteResponse.status, 200, `${method} was not registered`)
    const remoteBody = await remoteResponse.json()
    assert.equal(remoteBody.result.ok, true, JSON.stringify(remoteBody.result))
  }

  const presetResponse = await fetch(new URL('/api/agentPreset.list', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'mac-release-agent-presets',
      method: 'agentPreset.list',
      payload: {},
    }),
  })
  assert.equal(presetResponse.status, 200)
  const presetBody = await presetResponse.json()
  assert.equal(presetBody.result.ok, true, JSON.stringify(presetBody.result))
  assert.deepEqual(
    presetBody.result.value.presets.map((preset) => preset.id).sort(),
    ['code', 'cordis', 'minimal', 'standard'],
  )

  const sessionResponse = await fetch(new URL('/api/session.create', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'mac-release-code-preset',
      method: 'session.create',
      payload: { sessionId: 'mac-release-code-preset', agentPreset: 'code' },
    }),
  })
  assert.equal(sessionResponse.status, 200)
  const sessionBody = await sessionResponse.json()
  assert.deepEqual(
    sessionBody.result,
    { ok: true, value: { sessionId: 'mac-release-code-preset', agentPreset: 'code' } },
  )

  const commandsResponse = await fetch(new URL('/api/commands/list', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'mac-release-commands',
      method: 'commands/list',
      payload: { args: { agentId: 'mac-release-code-preset' } },
    }),
  })
  assert.equal(commandsResponse.status, 200)
  const commandsBody = await commandsResponse.json()
  assert.equal(commandsBody.result.ok, true, JSON.stringify(commandsBody.result))
  assert.ok(commandsBody.result.value.length > 0, 'Expected the session command roster')

  const skillResponse = await fetch(new URL('/api/skill.list', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'mac-release-code-skills',
      method: 'skill.list',
      payload: { sessionId: 'mac-release-code-preset', includeUnavailable: true },
    }),
  })
  assert.equal(skillResponse.status, 200)
  const skillBody = await skillResponse.json()
  assert.equal(skillBody.result.ok, true, JSON.stringify(skillBody.result))
  assert.ok(skillBody.result.value.skills.length > 0, 'Expected code preset skills to load')

  const installHome = path.join(root, 'installed-home')
  await mkdir(installHome)
  execFileSync(path.join(result.packageDir, 'install.command'), [], {
    env: { ...process.env, HOME: installHome },
  })
  const launcher = path.join(installHome, 'Library/Application Support/accr-ui-harness/runtime/run-native-host.sh')
  const native = spawn(launcher, [], {
    env: { HOME: installHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => native.kill('SIGTERM'))
  let nativeStderr = ''
  let nativeRemainder = Buffer.alloc(0)
  native.stderr.on('data', (chunk) => { nativeStderr += chunk })
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Installed Native Host did not start under Chrome PATH: ${nativeStderr}`)), 20_000)
    native.stdout.on('data', (chunk) => {
      const decoded = decodeNativeFrames(Buffer.concat([nativeRemainder, chunk]))
      nativeRemainder = decoded.remainder
      const message = decoded.messages.find((candidate) => candidate?.type === 'server_started')
      if (message === undefined) return
      clearTimeout(timer)
      resolve(message)
    })
    native.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Installed Native Host exited before readiness (${code}): ${nativeStderr}`))
    })
  })
  native.stdin.write(encodeNativeFrame({ type: 'start' }))
  const startedMessage = await started
  assert.match(startedMessage.payload.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  native.stdin.write(encodeNativeFrame({ type: 'stop' }))
})
