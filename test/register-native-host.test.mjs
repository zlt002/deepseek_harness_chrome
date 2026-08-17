import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(projectRoot, 'scripts/register-native-host.mjs')
const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const devExtensionId = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function runRegister(home, overrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, DEEPSEEK_HARNESS_EXTENSION_ID: extensionId, ...overrides }
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete env[name]
    }
    const child = spawn(process.execPath, [script], {
      env,
      stdio: 'pipe',
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

function pingLauncher(launcher) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, [], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: 'pipe',
    })
    const ping = Buffer.from('{"type":"ping"}', 'utf8')
    const frame = Buffer.alloc(4 + ping.length)
    frame.writeUInt32LE(ping.length, 0)
    ping.copy(frame, 4)
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let response
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`native host response timeout: ${stderr}`))
    }, 2_000)
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk])
      if (response !== undefined || stdout.length < 4) return
      const length = stdout.readUInt32LE(0)
      if (stdout.length < 4 + length) return
      response = JSON.parse(stdout.subarray(4, 4 + length).toString('utf8'))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`native host exited ${String(code)}: ${stderr}`))
        return
      }
      resolve(response)
    })
    child.stdin.end(frame)
  })
}

test('installs the native host into a stable macOS location', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const installRoot = join(home, 'Library/Application Support/DeepSeekHarness')
  const launcher = join(installRoot, 'com.deepseek.harness.chrome')
  const nativeServer = join(installRoot, 'native-server')
  const manifestPaths = [
    join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.harness.chrome.json'),
    join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.deepseek.harness.chrome.json'),
  ]
  try {
    const result = await runRegister(home)
    assert.equal(result.code, 0, result.stderr)
    await stat(launcher)
    await stat(join(nativeServer, 'bin.mjs'))
    await stat(join(nativeServer, 'src/native-host.mjs'))
    await stat(join(nativeServer, 'harness-runtime.mjs'))
    const installedSkill = join(installRoot, 'skills/pmd-prd/SKILL.md')
    await stat(installedSkill)
    const installedSkillSource = await readFile(installedSkill, 'utf8')
    assert.match(installedSkillSource, /Harness Workspace 是唯一用户界面/)
    assert.match(installedSkillSource, /自动生成内部 `requirementId`/)
    assert.doesNotMatch(installedSkillSource, /pmd-workspace|clarification\.md/)

    const manifests = await Promise.all(manifestPaths.map(async (manifestPath) => JSON.parse(await readFile(manifestPath, 'utf8'))))
    for (const manifest of manifests) {
      assert.equal(manifest.path, launcher)
      assert.ok(manifest.allowed_origins.includes(`chrome-extension://${extensionId}/`))
    }

    const launcherSource = await readFile(launcher, 'utf8')
    assert.match(launcherSource, new RegExp(`exec .*${nativeServer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin\\.mjs`))
    assert.doesNotMatch(launcherSource, new RegExp(`${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/native-server`))
    assert.doesNotMatch(JSON.stringify(manifests), new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('can reinstall over a pnpm-linked native host dependency', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const installedSdk = join(home, 'Library/Application Support/DeepSeekHarness/native-server/node_modules/@modelcontextprotocol/sdk')
  const workspaceSdk = join(projectRoot, 'apps/native-server/node_modules/@modelcontextprotocol/sdk')
  try {
    const first = await runRegister(home)
    assert.equal(first.code, 0, first.stderr)

    await rm(installedSdk, { recursive: true, force: true })
    await symlink(await realpath(workspaceSdk), installedSdk)
    assert.equal((await lstat(installedSdk)).isSymbolicLink(), true)

    const second = await runRegister(home)
    assert.equal(second.code, 0, second.stderr)
    assert.equal((await lstat(installedSdk)).isDirectory(), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installed native host resolves self-contained product UI packages', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const nativeServer = join(home, 'Library/Application Support/DeepSeekHarness/native-server')
  const dshHome = join(home, '.dsh')
  try {
    const result = await runRegister(home)
    assert.equal(result.code, 0, result.stderr)

    const harnessProcessUrl = `${pathToFileURL(join(nativeServer, 'src/harness-process.mjs')).href}?test=${Date.now()}`
    const { prepareProductUiPackages } = await import(harnessProcessUrl)
    await prepareProductUiPackages({ HOME: home, DSH_HOME: dshHome })

    for (const packageName of ['harness-ui-agent-preset', 'harness-ui-subagent-compact']) {
      const link = join(dshHome, `profiles/web/node_modules/@accrui/${packageName}`)
      assert.equal(
        resolve(dirname(link), await readlink(link)),
        await realpath(join(nativeServer, 'product-plugins', packageName)),
      )
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('allows production and development extension ids together', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const manifestPath = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.harness.chrome.json')
  try {
    const result = await runRegister(home, {
      DEEPSEEK_HARNESS_EXTENSION_ID: `${extensionId},${devExtensionId}`,
    })
    assert.equal(result.code, 0, result.stderr)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.allowed_origins, [
      `chrome-extension://${extensionId}/`,
      `chrome-extension://${devExtensionId}/`,
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('merges a previously registered extension origin instead of replacing it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const manifestPath = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.harness.chrome.json')
  try {
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({
      name: 'com.deepseek.harness.chrome',
      description: 'existing host',
      path: '/existing/launcher',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }))

    const result = await runRegister(home, {
      DEEPSEEK_HARNESS_EXTENSION_ID: devExtensionId,
    })
    assert.equal(result.code, 0, result.stderr)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.allowed_origins, [
      `chrome-extension://${extensionId}/`,
      `chrome-extension://${devExtensionId}/`,
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('merges existing Edge origins and adds the current extension id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const manifestPath = join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.deepseek.harness.chrome.json')
  try {
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ allowed_origins: [`chrome-extension://${devExtensionId}/`] }))

    const result = await runRegister(home)
    assert.equal(result.code, 0, result.stderr)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.allowed_origins, [
      `chrome-extension://${devExtensionId}/`,
      `chrome-extension://${extensionId}/`,
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('records the generated product Harness root when no launch override is supplied', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const launcher = join(home, 'Library/Application Support/DeepSeekHarness/com.deepseek.harness.chrome')
  const productRoot = resolve(projectRoot, '.generated/harness-product')
  try {
    const result = await runRegister(home, {
      DSH_ROOT: undefined,
      DSH_CLI_PATH: undefined,
      DSH_CWD: undefined,
      DSH_NATIVE_LOG: undefined,
    })
    assert.equal(result.code, 0, result.stderr)
    const source = await readFile(launcher, 'utf8')
    assert.match(source, new RegExp(`export DSH_ROOT='${productRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.doesNotMatch(source, /DSH_(?:LEGACY_UI_OVERLAY|ENABLE_KNOWLEDGE_SCOPE_UI|ENABLE_SKILL_SETTINGS_UI)/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('treats a blank Harness root as an absent override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const launcher = join(home, 'Library/Application Support/DeepSeekHarness/com.deepseek.harness.chrome')
  const productRoot = resolve(projectRoot, '.generated/harness-product')
  try {
    const result = await runRegister(home, { DSH_ROOT: '   ', DSH_CLI_PATH: undefined })
    assert.equal(result.code, 0, result.stderr)
    const source = await readFile(launcher, 'utf8')
    assert.match(source, new RegExp(`export DSH_ROOT='${productRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.doesNotMatch(source, /DSH_(?:LEGACY_UI_OVERLAY|ENABLE_KNOWLEDGE_SCOPE_UI|ENABLE_SKILL_SETTINGS_UI)/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installed launcher answers a Native Messaging ping in a Chrome-like environment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-home-'))
  const launcher = join(home, 'Library/Application Support/DeepSeekHarness/com.deepseek.harness.chrome')
  try {
    const result = await runRegister(home)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await pingLauncher(launcher), { type: 'pong' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
