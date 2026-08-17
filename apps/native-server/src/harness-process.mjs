import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { redactSensitiveDiagnostic } from './redact.mjs'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the built DeepSeek Harness CLI. A packaged install sets
 * `DSH_CLI_PATH`; development defaults to the sibling checkout requested by
 * this project.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @returns {string}
 */
export function resolveHarnessCli(env = process.env) {
  const explicit = env.DSH_CLI_PATH?.trim()
  if (explicit) return resolve(explicit)
  const root = env.DSH_ROOT?.trim()
  if (root) return resolve(root, 'apps/cli/lib/bin.js')
  const generatedRoot = resolve(THIS_DIR, '../../../.generated/harness-product')
  const generatedCli = resolve(generatedRoot, 'apps/cli/lib/bin.js')
  if (existsSync(resolve(generatedRoot, '.harness-product.json')) && existsSync(generatedCli)) return generatedCli
  throw new Error(`Generated product Harness is missing or not built: ${generatedRoot}. Run pnpm build:harness-product first, or set DSH_ROOT/DSH_CLI_PATH explicitly for a different Harness checkout.`)
}

/** Resolve the product-owned out-of-tree MCP plugin in source and packages. */
export function resolveHarnessRuntimePlugin(env = process.env) {
  const explicit = env.DSH_HARNESS_RUNTIME_PLUGIN?.trim()
  if (explicit) return resolve(explicit)
  const candidates = [
    // Bundled macOS Native Host: runtime/native-server/runtime.mjs.
    resolve(THIS_DIR, 'harness-runtime.mjs'),
    // Source-based Windows package: runtime/native-server/src/*.mjs.
    resolve(THIS_DIR, '../harness-runtime.mjs'),
    // Product checkout: native-server/src/*.mjs.
    resolve(THIS_DIR, '../../../packages/harness-runtime/src/index.mjs'),
  ]
  return candidates.find(existsSync) ?? candidates.at(-1)
}

/**
 * Resolve the stable working directory used by a Native Messaging launch.
 * Chrome does not guarantee the host process cwd, so session/workspace
 * defaults must not depend on the browser's launch directory.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @returns {string}
 */
export function resolveHarnessCwd(env = process.env) {
  const explicit = env.DSH_CWD?.trim()
  if (explicit) return resolve(explicit)
  const root = env.DSH_ROOT?.trim()
  if (root) return resolve(root)
  return resolve(THIS_DIR, '../../..')
}

/** Resolve the official runtime dependency used by the one product Host plugin. */
export function resolveSchemasteryUrl(cliPath) {
  const harnessRoot = resolve(dirname(cliPath), '../../..')
  return pathToFileURL(join(harnessRoot, 'vendor/schemastery/lib/index.mjs')).href
}

/** Arguments owned by this integration, kept separate from the Harness CLI. */
export function harnessArgs(port, connectorPatchPath, extraPatchPaths = []) {
  return [
    ...connectorPatchPath === undefined ? [] : ['--patch', connectorPatchPath],
    ...extraPatchPaths.flatMap((path) => ['--patch', path]),
    '--profile', 'web',
    '--host', '127.0.0.1',
    '--port', String(port),
  ]
}

function validMcpConnector(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length === 0) return false
  try {
    const url = new URL(value.url)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/mcp'
  } catch {
    return false
  }
}

function connectorPatch(url, token, runtimePluginPath) {
  return `- id: persona
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- insert:
    - id: deepseek-harness-selected-source-routing
      name: ${yamlString(resolve(THIS_DIR, 'selected-source-routing-prompt.mjs'))}

- insert:
    - id: deepseek-harness-browser-connector
      name: ${yamlString(runtimePluginPath)}
      config:
        serverName: chrome
        url: '${url}'
        headers:
          Authorization: 'Bearer ${token}'
        forwardSessionIdentity: true
        # Office/browser operations remain visible to the active Web profile.
        # Selected-source searches are visible only to continuable children;
        # their wrapper tools below are the parent's only entry points.
        toolScopes:
          default: global
          code_search: continuable-child
          knowledge_search: continuable-child
        toolCallTimeoutMs: 1800000
        failOnStartupError: true
        reconnect:
          enabled: false

- insert:
    - id: deepseek-harness-remote-code-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: search_selected_remote_code
        backgroundMode: continuable
        persona: >-
          Search the user-selected remote code repositories. Always call
          mcp__chrome__code_search with exactly one non-empty "question" string before answering; never use "query". Never inspect local
          files or use shell/git as a substitute for the selected remote scope.
        toolFilter:
          allow: []

- insert:
    - id: deepseek-harness-knowledge-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: search_selected_knowledge
        backgroundMode: continuable
        persona: >-
          Search the user-selected enterprise knowledge sources. Always call
          mcp__chrome__knowledge_search with exactly one non-empty "question" string before answering; never use "query". Never inspect local
          files or use shell/git as a substitute for the selected remote scope.
        toolFilter:
          allow: []
`
}

function yamlString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Mount the installed Harness-native skills before the optional Claude catalog
 * so the product-owned contract wins when both roots contain the same name.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function claudeSkillsPatch(env = process.env) {
  const home = env.HOME?.trim() || homedir()
  const claudeSkillsDir = resolve(home, '.claude/skills')
  const harnessChromeSkillsDir = env.DSH_PRODUCT_SKILLS_ROOT?.trim()
    ? resolve(env.DSH_PRODUCT_SKILLS_ROOT)
    : [
        // Product source: apps/native-server/src -> repository skills/.
        resolve(THIS_DIR, '../../../skills'),
        // Installed Mac runtime: runtime/native-server -> app data skills/.
        resolve(THIS_DIR, '../../skills'),
      ].find(existsSync) ?? resolve(THIS_DIR, '../../../skills')
  return `- insert:
    - id: deepseek-harness-chrome-claude-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        includeDefaultRoots: false
        customSkillDirs:
          - ${yamlString(harnessChromeSkillsDir)}
          - ${yamlString(claudeSkillsDir)}
`
}

/** Product UI packages stay outside the official Harness checkout. */
export function productUiPatch(env = process.env) {
  const packages = productUiPackages(env)
  return packages.map((name, index) => `- insert:
    - id: deepseek-harness-product-ui-${index}
      name: '${name}'
`).join('')
}

function productUiPackages(env = process.env) {
  // Browser Target is the first completed externalization. The generated e327
  // product tree removes its built-in package before this product package is
  // mounted; all other replacements remain disabled to avoid duplicate slots.
  if (env.DSH_LEGACY_UI_OVERLAY === '1') {
    return [
      '@accrui/harness-ui-browser-target',
      '@accrui/harness-ui-subagent-compact',
    ]
  }
  const packages = [
    '@accrui/harness-ui-agent-preset',
    '@accrui/harness-ui-browser-target',
    '@accrui/harness-ui-subagent-compact',
  ]
  if (env.DSH_ENABLE_SKILL_SETTINGS_UI === '1') packages.push('@accrui/harness-skill-settings')
  // Knowledge Scope needs the generic composer-above/card-overlay seam. Keep
  // the package built, but do not mount it against an older clean upstream.
  if (env.DSH_ENABLE_KNOWLEDGE_SCOPE_UI === '1') {
    packages.push('@accrui/harness-ui-knowledge-scope')
  }
  return packages
}

/**
 * Make product packages resolvable from the Harness Web profile without
 * copying them into the official checkout or overwriting user-installed data.
 */
export async function prepareProductUiPackages(env = process.env) {
  const home = env.HOME?.trim() || homedir()
  const dshHome = resolve(env.DSH_HOME?.trim() || resolve(home, '.dsh'))
  const sourceRoot = env.DSH_PRODUCT_PLUGIN_ROOT?.trim()
    ? resolve(env.DSH_PRODUCT_PLUGIN_ROOT)
    : [
        // Product source: apps/native-server/src -> repository packages/.
        resolve(THIS_DIR, '../../../packages'),
        // Installed Mac runtime: runtime/native-server -> runtime/product-plugins/.
        resolve(THIS_DIR, '../product-plugins'),
        // Installed Windows runtime: runtime/native-server/src -> runtime/product-plugins/.
        resolve(THIS_DIR, '../../product-plugins'),
      ].find((candidate) => existsSync(candidate)) ?? resolve(THIS_DIR, '../../../packages')
  for (const packageName of productUiPackages(env)) {
    const source = resolve(sourceRoot, packageName.split('/').at(-1))
    for (const required of ['package.json', 'lib/index.js', 'lib/client.js']) {
      if (!existsSync(resolve(source, required))) {
        throw new Error(`Product Harness UI package is not built: ${resolve(source, required)}. Run pnpm build:harness-client-plugins.`)
      }
    }
    const link = resolve(dshHome, 'profiles/web/node_modules', ...packageName.split('/'))
    await mkdir(dirname(link), { recursive: true })
    let needsLink = true
    try {
      const info = await lstat(link)
      if (!info.isSymbolicLink()) throw new Error(`Refusing to replace unmanaged Harness plugin path: ${link}`)
      const current = resolve(dirname(link), await readlink(link))
      if (current === source) needsLink = false
      else await rm(link, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (needsLink) await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

/**
 * Spawn and supervise one `dsh --profile web` process.
 */
export class HarnessWebProcess {
  /** @param {{ cliPath?: string, runtimePluginPath?: string, port?: number, env?: NodeJS.ProcessEnv, cwd?: string, mcpConnector?: { url: string, token: string }, extraPatchPaths?: string[] }} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.cliPath = options.cliPath ?? resolveHarnessCli(this.env)
    this.runtimePluginPath = options.runtimePluginPath ?? resolveHarnessRuntimePlugin(this.env)
    this.port = options.port ?? 0
    this.cwd = options.cwd ?? resolveHarnessCwd(this.env)
    this.mcpConnector = options.mcpConnector
    this.extraPatchPaths = options.extraPatchPaths ?? []
    this.connectorPatchDir = undefined
    this.connectorPatchPath = undefined
    this.child = undefined
    this.url = undefined
    this.startPromise = undefined
    this.stopping = false
  }

  /** @returns {Promise<string>} */
  start() {
    if (this.url) return Promise.resolve(this.url)
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#start().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true
    const child = this.child
    this.child = undefined
    this.url = undefined
    try {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } finally {
      await this.#removeConnectorPatch()
    }
  }

  async #start() {
    if (!existsSync(this.cliPath)) {
      throw new Error(`DeepSeek Harness CLI was not found: ${this.cliPath}. Set DSH_CLI_PATH or DSH_ROOT.`)
    }
    this.stopping = false
    await prepareProductUiPackages(this.env)
    const patchPath = await this.#createConnectorPatch()
    const child = spawn(process.execPath, [this.cliPath, ...harnessArgs(this.port, patchPath, this.extraPatchPaths)], {
      cwd: this.cwd,
      env: {
        ...this.env,
        // Native stdout is reserved for framed messages. The child is piped,
        // but disabling telemetry keeps the development process deterministic.
        DSH_TELEMETRY_DISABLED: this.env.DSH_TELEMETRY_DISABLED ?? '1',
        DSH_PRODUCT_SCHEMATERY_URL: this.env.DSH_PRODUCT_SCHEMATERY_URL ?? resolveSchemasteryUrl(this.cliPath),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[deepseek-harness] ${redactSensitiveDiagnostic(chunk)}`)
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      this.url = undefined
    })

    try {
      return await new Promise((resolveUrl, reject) => {
      let settled = false
      const finish = (error, url) => {
        if (settled) return
        settled = true
        if (error) {
          reject(error)
        } else {
          this.url = url
          resolveUrl(url)
        }
      }
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        const match = /^dsh web: (https?:\/\/\S+)/.exec(line.trim())
        if (match) {
          void this.#waitForHttp(match[1]).then(
            () => finish(undefined, match[1]),
            (error) => finish(error instanceof Error ? error : new Error(String(error))),
          )
        }
      })
      child.once('error', (error) => finish(error))
      child.once('exit', (code, signal) => {
        if (!settled && !this.stopping) {
          finish(new Error(`DeepSeek Harness exited before readiness (code=${String(code)}, signal=${String(signal)}).`))
        }
      })
      })
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async #createConnectorPatch() {
    if (this.mcpConnector !== undefined && !validMcpConnector(this.mcpConnector)) throw new Error('Native Host supplied an invalid Browser Connector endpoint')
    if (this.mcpConnector !== undefined && !existsSync(this.runtimePluginPath)) {
      throw new Error(`Harness runtime plugin was not found: ${this.runtimePluginPath}`)
    }
    const directory = await mkdtemp(`${tmpdir()}/deepseek-harness-connector-`)
    const patchPath = resolve(directory, 'connector.cordis.yml')
    const connector = this.mcpConnector === undefined ? '' : connectorPatch(this.mcpConnector.url, this.mcpConnector.token, this.runtimePluginPath)
    await writeFile(patchPath, `${claudeSkillsPatch(this.env)}${productUiPatch(this.env)}${connector}`, { mode: 0o600 })
    this.connectorPatchDir = directory
    this.connectorPatchPath = patchPath
    return patchPath
  }

  async #removeConnectorPatch() {
    const directory = this.connectorPatchDir
    this.connectorPatchDir = undefined
    this.connectorPatchPath = undefined
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }

  async #waitForHttp(url) {
    const deadline = Date.now() + 15_000
    let lastError
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: 'manual' })
        if (response.status < 500) return
        lastError = new Error(`Harness Web UI returned HTTP ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw lastError instanceof Error ? lastError : new Error(`Harness Web UI did not become ready: ${url}`)
  }
}
