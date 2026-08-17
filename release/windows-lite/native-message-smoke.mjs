#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function destroyStream(stream) {
  try { stream?.destroy?.() } catch {}
}

function removeListener(emitter, event, listener) {
  emitter?.removeListener?.(event, listener)
}

function fallbackTerminate(child) {
  try { child.kill?.() } catch {}
  destroyStream(child.stdin)
  destroyStream(child.stdout)
  destroyStream(child.stderr)
  try { child.unref?.() } catch {}
}

/** Exercise one already-launched Native Host through one bounded state machine. */
export function smokeNativeMessageChild({
  child,
  killTree,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pingTimeoutMs = DEFAULT_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!child?.stdin || !child?.stdout || !child?.stderr) throw new Error('Native Host child must expose piped stdin/stdout/stderr streams.')
  if (typeof killTree !== 'function') throw new Error('killTree must be provided.')

  return new Promise((resolveSmoke, rejectSmoke) => {
    let state = 'waiting-pong'
    let settled = false
    let timeout
    let stdout = Buffer.alloc(0)
    let stderr = ''

    const clearActiveTimer = () => {
      if (timeout === undefined) return
      clearTimer(timeout)
      timeout = undefined
    }
    const cleanupListeners = () => {
      removeListener(child.stdout, 'data', onStdoutData)
      removeListener(child.stdout, 'error', onStdoutError)
      removeListener(child.stderr, 'data', onStderrData)
      removeListener(child.stderr, 'error', onStderrError)
      removeListener(child.stdin, 'error', onStdinError)
      removeListener(child.stdin, 'finish', onStdinFinish)
      removeListener(child, 'error', onChildError)
      removeListener(child, 'close', onChildClose)
    }
    const closeStreams = () => {
      destroyStream(child.stdin)
      destroyStream(child.stdout)
      destroyStream(child.stderr)
      try { child.unref?.() } catch {}
    }
    const fail = (error, terminate = true) => {
      if (settled) return
      settled = true
      clearActiveTimer()
      cleanupListeners()
      let terminationFailure = ''
      if (terminate && child.exitCode === null && child.signalCode === null) {
        try {
          const result = killTree()
          if (result === false || result?.ok === false) {
            terminationFailure = result?.error ? `; process-tree termination failed: ${result.error}` : '; process-tree termination failed'
            fallbackTerminate(child)
          }
        } catch (killError) {
          terminationFailure = `; process-tree termination failed: ${killError instanceof Error ? killError.message : String(killError)}`
          fallbackTerminate(child)
        }
      }
      closeStreams()
      const base = error instanceof Error ? error.message : String(error)
      rejectSmoke(new Error(`${base}${terminationFailure}`))
    }
    const succeed = () => {
      if (settled) return
      settled = true
      clearActiveTimer()
      cleanupListeners()
      closeStreams()
      resolveSmoke({ type: 'pong' })
    }
    const armTimeout = (milliseconds, message) => {
      clearActiveTimer()
      timeout = setTimer(() => fail(new Error(`${message}: ${stderr}`)), milliseconds)
    }
    const onStderrData = (chunk) => { stderr += chunk.toString() }
    const onStdoutError = (error) => fail(new Error(`Native Host stdout failed: ${error.message}`))
    const onStderrError = (error) => fail(new Error(`Native Host stderr failed: ${error.message}`))
    const onStdinError = (error) => fail(new Error(`Native Host stdin failed: ${error.message}`))
    const onChildError = (error) => fail(error)
    const onStdinFinish = () => {
      if (state === 'writing-stop') state = 'waiting-exit'
    }
    const onChildClose = (code, signal) => {
      if (state === 'waiting-pong') {
        fail(new Error(`Native Host exited before pong (${String(code ?? signal)}): ${stderr}`), false)
      } else if (state !== 'waiting-exit') {
        fail(new Error(`Native Host exited before the stop frame finished writing (${String(code ?? signal)}): ${stderr}`), false)
      } else if (code !== 0) {
        fail(new Error(`Native Host exited ${String(code ?? signal)} after pong: ${stderr}`), false)
      } else {
        succeed()
      }
    }
    const onStdoutData = (chunk) => {
      if (state !== 'waiting-pong') return
      stdout = Buffer.concat([stdout, Buffer.from(chunk)])
      if (stdout.length < 4) return
      const length = stdout.readUInt32LE(0)
      if (length > MAX_FRAME_BYTES) {
        fail(new Error(`Native Messaging response frame is too large: ${String(length)} bytes`))
        return
      }
      if (stdout.length < 4 + length) return
      let response
      try {
        response = JSON.parse(stdout.subarray(4, 4 + length).toString('utf8'))
      } catch (error) {
        fail(new Error(`Native Messaging response is invalid JSON: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      if (response?.type !== 'pong') {
        fail(new Error(`Unexpected Native Messaging response: ${JSON.stringify(response)}`))
        return
      }
      state = 'writing-stop'
      armTimeout(stopTimeoutMs, 'Native Host did not exit after stop')
      try {
        child.stdin.end(encodeNativeMessage({ type: 'stop' }))
      } catch (error) {
        fail(new Error(`Native Host stop write failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    }

    child.stdout.on('data', onStdoutData)
    child.stdout.on('error', onStdoutError)
    child.stderr.setEncoding?.('utf8')
    child.stderr.on('data', onStderrData)
    child.stderr.on('error', onStderrError)
    child.stdin.on('error', onStdinError)
    child.stdin.on('finish', onStdinFinish)
    child.once('error', onChildError)
    child.once('close', onChildClose)
    armTimeout(pingTimeoutMs, 'Native Messaging ping timed out')
    try {
      child.stdin.write(encodeNativeMessage({ type: 'ping' }))
    } catch (error) {
      fail(new Error(`Native Host ping write failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}

function killWindowsProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return { ok: true }
  const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  if (result.error) return { ok: false, error: result.error.message }
  if (result.status !== 0) return { ok: false, error: `taskkill.exe exited ${String(result.status)}` }
  return { ok: true }
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('This smoke test must run on Windows.')
  const launcherIndex = argv.indexOf('--launcher')
  const launcher = launcherIndex >= 0 ? resolve(argv[launcherIndex + 1] ?? '') : ''
  if (!launcher || !existsSync(launcher)) throw new Error(`Native Host launcher is missing: ${launcher}`)

  const command = process.env.ComSpec || 'cmd.exe'
  const child = spawn(command, ['/d', '/s', '/c', `"${launcher}"`], {
    env: process.env,
    stdio: 'pipe',
    windowsHide: true,
    // cmd.exe needs to receive the surrounding quotes literally. Without
    // this, Node escapes them as \" and cmd treats that as part of the path.
    windowsVerbatimArguments: true,
  })
  await smokeNativeMessageChild({ child, killTree: () => killWindowsProcessTree(child) })
  console.log('Native Messaging launcher answered pong and stopped cleanly.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
