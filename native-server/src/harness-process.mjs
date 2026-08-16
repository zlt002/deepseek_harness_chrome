import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  const sibling = resolve(THIS_DIR, '../../../deepseek-harness/apps/cli/lib/bin.js')
  if (existsSync(sibling)) return sibling
  return sibling
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
  return resolve(THIS_DIR, '../..')
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

function connectorPatch(url, token) {
  return `- id: persona
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- insert:
    - id: deepseek-harness-selected-source-routing
      name: ${yamlString(resolve(THIS_DIR, 'selected-source-routing-prompt.mjs'))}

- insert:
    - id: deepseek-harness-browser-connector
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome
        transport: streamable-http
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
          allow:
            - mcp__chrome__code_search

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
          allow:
            - mcp__chrome__knowledge_search
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
  const harnessChromeSkillsDir = resolve(THIS_DIR, '../../skills')
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

/**
 * Spawn and supervise one `dsh --profile web` process.
 */
export class HarnessWebProcess {
  /** @param {{ cliPath?: string, port?: number, env?: NodeJS.ProcessEnv, cwd?: string, mcpConnector?: { url: string, token: string }, extraPatchPaths?: string[] }} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.cliPath = options.cliPath ?? resolveHarnessCli(this.env)
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
    const patchPath = await this.#createConnectorPatch()
    const child = spawn(process.execPath, [this.cliPath, ...harnessArgs(this.port, patchPath, this.extraPatchPaths)], {
      cwd: this.cwd,
      env: {
        ...this.env,
        // Native stdout is reserved for framed messages. The child is piped,
        // but disabling telemetry keeps the development process deterministic.
        DSH_TELEMETRY_DISABLED: this.env.DSH_TELEMETRY_DISABLED ?? '1',
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
    const directory = await mkdtemp(`${tmpdir()}/deepseek-harness-connector-`)
    const patchPath = resolve(directory, 'connector.cordis.yml')
    const connector = this.mcpConnector === undefined ? '' : connectorPatch(this.mcpConnector.url, this.mcpConnector.token)
    await writeFile(patchPath, `${claudeSkillsPatch(this.env)}${connector}`, { mode: 0o600 })
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
