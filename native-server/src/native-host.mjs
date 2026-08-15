import { appendFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { randomUUID } from 'node:crypto'
import { decodeNativeFrames, encodeNativeFrame } from './protocol.mjs'
import { BrowserConnector } from './connector.mjs'
import { HarnessWebProcess } from './harness-process.mjs'
import { redactSensitiveDiagnostic } from './redact.mjs'

const nativeLogPath = process.env.DSH_NATIVE_LOG?.trim()

function nativeLog(message) {
  if (!nativeLogPath) return
  try {
    appendFileSync(nativeLogPath, `${new Date().toISOString()} ${redactSensitiveDiagnostic(message)}\n`)
  } catch {
    // Diagnostics must never interfere with the Native Messaging protocol.
  }
}

function harnessWebUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('Harness Web URL must be an http 127.0.0.1 loopback URL with a port')
  }
  return url.toString().replace(/\/$/, '')
}

function validBrowserTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 4
    && value.browser === 'chrome'
    && Number.isInteger(value.windowId) && value.windowId >= 0
    && Number.isInteger(value.tabId) && value.tabId >= 0
    && typeof value.url === 'string' && value.url.length > 0
}

function sameBrowserTarget(left, right) {
  return validBrowserTarget(left)
    && validBrowserTarget(right)
    && left.browser === right.browser
    && left.windowId === right.windowId
    && left.tabId === right.tabId
    && left.url === right.url
}

function validUnavailableBrowserTarget(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.reason === 'closed_or_changed'
    && validBrowserTarget(value.browserTarget)
}

function validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets) {
  const targets = browserTargets ?? (validBrowserTarget(browserTarget) ? [browserTarget] : [])
  const unavailable = unavailableBrowserTargets ?? []
  return validBrowserTarget(browserTarget)
    && Array.isArray(targets) && targets.length > 0 && targets.every(validBrowserTarget)
    && targets.some((target) => sameBrowserTarget(target, browserTarget))
    && new Set(targets.map((target) => `${target.windowId}:${target.tabId}:${target.url}`)).size === targets.length
    && Array.isArray(unavailable) && unavailable.every(validUnavailableBrowserTarget)
}

process.on('uncaughtException', (error) => {
  nativeLog(`uncaughtException ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
process.on('unhandledRejection', (error) => {
  nativeLog(`unhandledRejection ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})

/**
 * Chrome Native Messaging host. Its stdout is protocol-only; diagnostics go
 * to stderr so Chrome never sees an unframed byte.
 */
export class NativeHost {
  /** @param {{ processFactory?: (options: { mcpConnector: { url: string, token: string } }) => HarnessWebProcess, connectorFactory?: (options: { requestExtension: (request: object) => void }) => BrowserConnector, exit?: (code: number) => void }} [options] */
  constructor(options = {}) {
    this.processFactory = options.processFactory ?? ((processOptions) => new HarnessWebProcess(processOptions))
    this.connectorFactory = options.connectorFactory ?? ((connectorOptions) => new BrowserConnector(connectorOptions))
    this.exit = options.exit ?? ((code) => process.exit(code))
    this.harness = undefined
    this.connector = undefined
    this.browserTargets = new Map()
    this.browserTargetSets = new Map()
    this.unavailableBrowserTargets = new Map()
    this.currentRunId = undefined
    this.serverUrl = undefined
    this.startPromise = undefined
    this.closePromise = undefined
    this.buffer = Buffer.alloc(0)
    this.closed = false
  }

  /** Attach stdin/stdout and start consuming frames. */
  start() {
    nativeLog(`start pid=${process.pid} cwd=${process.cwd()} stdinTTY=${String(stdin.isTTY)} stdoutTTY=${String(stdout.isTTY)}`)
    stdin.on('data', (chunk) => {
      try {
        nativeLog(`stdin data bytes=${String(chunk.length)}`)
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
        const decoded = decodeNativeFrames(this.buffer)
        this.buffer = decoded.remainder
        nativeLog(`decoded messages=${String(decoded.messages.length)} remainder=${String(this.buffer.length)} errors=${String(decoded.errors.length)}`)
        for (const error of decoded.errors) this.send({ type: 'error', error })
        for (const message of decoded.messages) void this.handle(message)
      } catch (error) {
        this.send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
        void this.close('invalid native frame')
      }
    })
    stdin.on('end', () => {
      nativeLog('stdin end')
      void this.close('browser disconnected')
    })
    stdin.on('error', (error) => {
      nativeLog(`stdin error ${error.message}`)
      void this.close(`stdin error: ${error.message}`)
    })
    stdout.on('error', (error) => {
      nativeLog(`stdout error ${error.message}`)
      void this.close(`stdout error: ${error.message}`)
    })
  }

  /** @param {unknown} message */
  async handle(message) {
    if (this.closed) return
    if (!message || typeof message !== 'object') {
      this.send({ type: 'error', error: 'Native message must be an object.' })
      return
    }
    const type = message.type
    if (type === 'ping') {
      this.send({ type: 'pong' })
      return
    }
    if (type === 'start') {
      await this.startHarness(message.browserTarget, message.browserTargets, message.unavailableBrowserTargets)
      return
    }
    if (type === 'transfer-browser-target') {
      this.transferBrowserTarget(message.requestId, message.runId, message.browserTarget, message.browserTargets, message.unavailableBrowserTargets)
      return
    }
    if (type === 'connector_response') {
      if (this.connector?.acceptExtensionResponse(message) !== true) {
        this.send({ type: 'error', error: 'Unrecognized Connector response.' })
      }
      return
    }
    if (type === 'stop') {
      await this.close('stop requested')
      return
    }
    this.send({ type: 'error', error: `Unknown native message type: ${String(type)}` })
  }

  async startHarness(browserTarget, browserTargets, unavailableBrowserTargets) {
    if (this.closed) return
    const boundTarget = this.currentRunId === undefined ? undefined : this.browserTargets.get(this.currentRunId)
    if (validBrowserTarget(browserTarget) && validBrowserTarget(boundTarget) && !sameBrowserTarget(browserTarget, boundTarget)) {
      this.send({ type: 'error', error: 'Harness Run is already bound to a different Browser Target.' })
      return
    }
    if (browserTarget !== undefined && !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      this.send({ type: 'error', error: 'Browser Target binding must contain a trusted primary target and one or more unique selected targets.' })
      return
    }
    if (this.currentRunId === undefined) this.#createRun(browserTarget, browserTargets, unavailableBrowserTargets)
    else if (validBrowserTarget(browserTarget) && boundTarget === undefined) {
      this.send({ type: 'error', error: 'Harness Run is unbound. Use transfer-browser-target to bind an explicit Browser Target.' })
      return
    }
    if (this.serverUrl !== undefined) {
      this.send({ type: 'server_started', payload: { url: this.serverUrl, runId: this.currentRunId } })
      return
    }
    if (this.startPromise === undefined) {
      this.startPromise = this.#startHarness().finally(() => {
        this.startPromise = undefined
      })
    }
    try {
      const url = await this.startPromise
      this.send({ type: 'server_started', payload: { url, runId: this.currentRunId } })
    } catch (error) {
      this.send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  transferBrowserTarget(requestId, runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (typeof requestId !== 'string' || requestId.length === 0 || typeof runId !== 'string' || runId.length === 0
      || !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      this.send({ type: 'browser_target_transfer_failed', requestId, error: 'transfer-browser-target requires a request id, Run id, and explicit Chrome Browser Target.' })
      return false
    }
    if (runId !== this.currentRunId) {
      this.send({ type: 'browser_target_transfer_failed', requestId, error: 'Browser Target transfer does not match the active Harness Run.' })
      return false
    }
    this.browserTargets.set(runId, { ...browserTarget })
    const targetSet = browserTargets ?? [browserTarget]
    const unavailable = unavailableBrowserTargets ?? []
    this.browserTargetSets.set(runId, targetSet.map((target) => ({ ...target })))
    this.unavailableBrowserTargets.set(runId, unavailable.map((item) => ({ browserTarget: { ...item.browserTarget }, reason: item.reason })))
    this.connector?.bindBrowserTarget(runId, browserTarget, targetSet, unavailable)
    const isMultiTarget = browserTargets !== undefined || unavailableBrowserTargets !== undefined
    this.send({ type: 'browser_target_transferred', requestId, payload: {
      runId, browserTarget: { ...browserTarget },
      ...(isMultiTarget ? {
        browserTargets: targetSet.map((target) => ({ ...target })),
        unavailableBrowserTargets: unavailable.map((item) => ({ browserTarget: { ...item.browserTarget }, reason: item.reason })),
      } : {}),
    } })
    return true
  }

  async close(reason) {
    if (this.closed) return
    this.closed = true
    nativeLog(`close reason=${reason}`)
    this.closePromise = (async () => {
      if (reason !== 'browser disconnected') process.stderr.write(`[native-server] ${reason}\n`)
      await this.harness?.stop()
      this.harness = undefined
      await this.connector?.stop()
      this.connector = undefined
      this.browserTargets.clear()
      this.browserTargetSets.clear()
      this.unavailableBrowserTargets.clear()
      this.currentRunId = undefined
      this.serverUrl = undefined
      this.exit(0)
    })()
    await this.closePromise
  }

  async #startHarness() {
    try {
      if (this.connector === undefined) {
        this.connector = this.connectorFactory({
          requestExtension: (request) => this.send(request),
        })
        if (this.currentRunId !== undefined) {
          this.connector.registerRun(this.currentRunId, this.browserTargets.get(this.currentRunId), this.browserTargetSets.get(this.currentRunId), this.unavailableBrowserTargets.get(this.currentRunId))
        }
      }
      const connector = await this.connector.start()
      if (this.harness === undefined) {
        this.harness = this.processFactory({
          mcpConnector: { url: `${connector.url}/mcp`, token: connector.token },
        })
      }
      const harnessUrl = await this.harness.start()
      this.serverUrl = harnessWebUrl(harnessUrl)
      return this.serverUrl
    } catch (error) {
      await this.harness?.stop()
      this.harness = undefined
      await this.connector?.stop()
      this.connector = undefined
      this.browserTargets.clear()
      this.browserTargetSets.clear()
      this.unavailableBrowserTargets.clear()
      this.currentRunId = undefined
      this.serverUrl = undefined
      throw error
    }
  }

  #createRun(browserTarget, browserTargets, unavailableBrowserTargets) {
    const runId = randomUUID()
    this.currentRunId = runId
    if (validBrowserTarget(browserTarget)) {
      const targetSet = browserTargets ?? [browserTarget]
      const unavailable = unavailableBrowserTargets ?? []
      this.browserTargets.set(runId, { ...browserTarget })
      this.browserTargetSets.set(runId, targetSet.map((target) => ({ ...target })))
      this.unavailableBrowserTargets.set(runId, unavailable.map((item) => ({ browserTarget: { ...item.browserTarget }, reason: item.reason })))
    }
    this.connector?.registerRun(runId, browserTarget, browserTargets, unavailableBrowserTargets)
  }

  /** @param {unknown} message */
  send(message) {
    if (this.closed) return
    try {
      nativeLog(`send type=${typeof message === 'object' && message !== null ? String(message.type) : 'unknown'}`)
      stdout.write(encodeNativeFrame(message))
    } catch (error) {
      process.stderr.write(`[native-server] failed to write response: ${String(error)}\n`)
    }
  }
}

/** Start the production host when this module is used as the executable. */
export function runNativeHost() {
  const host = new NativeHost()
  host.start()
  return host
}
