import { appendFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { decodeNativeFrames, encodeNativeFrame } from './protocol.mjs'
import { HarnessWebProcess } from './harness-process.mjs'

const nativeLogPath = process.env.DSH_NATIVE_LOG?.trim()

function nativeLog(message) {
  if (!nativeLogPath) return
  try {
    appendFileSync(nativeLogPath, `${new Date().toISOString()} ${message}\n`)
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
  /** @param {{ processFactory?: () => HarnessWebProcess, exit?: (code: number) => void }} [options] */
  constructor(options = {}) {
    this.processFactory = options.processFactory ?? (() => new HarnessWebProcess())
    this.exit = options.exit ?? ((code) => process.exit(code))
    this.harness = undefined
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
      await this.startHarness()
      return
    }
    if (type === 'stop') {
      await this.close('stop requested')
      return
    }
    this.send({ type: 'error', error: `Unknown native message type: ${String(type)}` })
  }

  async startHarness() {
    if (this.closed) return
    if (this.serverUrl !== undefined) {
      this.send({ type: 'server_started', payload: { url: this.serverUrl } })
      return
    }
    if (this.startPromise === undefined) {
      this.startPromise = this.#startHarness().finally(() => {
        this.startPromise = undefined
      })
    }
    try {
      const url = await this.startPromise
      this.send({ type: 'server_started', payload: { url } })
    } catch (error) {
      this.send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  async close(reason) {
    if (this.closed) return
    this.closed = true
    nativeLog(`close reason=${reason}`)
    this.closePromise = (async () => {
      if (reason !== 'browser disconnected') process.stderr.write(`[native-server] ${reason}\n`)
      await this.harness?.stop()
      this.harness = undefined
      this.serverUrl = undefined
      this.exit(0)
    })()
    await this.closePromise
  }

  async #startHarness() {
    try {
      if (this.harness === undefined) this.harness = this.processFactory()
      const harnessUrl = await this.harness.start()
      this.serverUrl = harnessWebUrl(harnessUrl)
      return this.serverUrl
    } catch (error) {
      await this.harness?.stop()
      this.harness = undefined
      this.serverUrl = undefined
      throw error
    }
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
