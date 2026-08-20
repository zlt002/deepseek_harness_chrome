#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { encodeNativeMessage } from './native-message-smoke.mjs'

export const EXPECTED_PRODUCT_CLIENT_IDS = [
  '@accrui/harness-ui-agent-preset',
  '@accrui/harness-ui-browser-target',
  '@accrui/harness-ui-conversation-shell',
  '@accrui/harness-ui-message-annotations',
  '@accrui/harness-ui-responsive-sidebar',
  '@accrui/harness-ui-workspace-picker',
  '@accrui/harness-ui-account-access',
  '@accrui/harness-ui-subagent-compact',
  '@accrui/harness-ui-session-log-copy',
  '@accrui/harness-ui-settings-shell',
  '@accrui/harness-ui-knowledge-scope',
  '@accrui/harness-ui-document-intake',
  '@accrui/harness-ui-workspace-review',
  '@accrui/harness-skill-settings',
]

export async function verifyProductUiBoot(baseUrl, fetchImpl = fetch) {
  const response = await fetchImpl(baseUrl)
  if (!response.ok) throw new Error(`Harness Web root returned HTTP ${response.status}.`)
  const html = await response.text()
  const match = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/)
  if (match === null) throw new Error('Harness Web root did not expose __DSH_BOOT__.')
  const boot = JSON.parse(match[1])
  const byId = new Map(boot.entries.map(entry => [entry.id, entry]))
  for (const id of EXPECTED_PRODUCT_CLIENT_IDS) {
    const entry = byId.get(id)
    if (entry === undefined) throw new Error(`Harness Web boot is missing activated product client plugin: ${id}`)
    const client = await fetchImpl(new URL(entry.url, baseUrl))
    if (!client.ok) throw new Error(`Product client bundle returned HTTP ${client.status}: ${id}`)
  }
  return { productClientCount: EXPECTED_PRODUCT_CLIENT_IDS.length }
}

function killWindowsProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) child.kill()
}

function waitForStarted(child, timeoutMs = 90_000) {
  return new Promise((resolveStarted, rejectStarted) => {
    let buffer = Buffer.alloc(0)
    let stderr = ''
    const timer = setTimeout(() => rejectStarted(new Error(`Harness Web startup timed out: ${stderr}`)), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.removeListener('data', onData)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
    }
    const fail = error => { cleanup(); rejectStarted(error) }
    const onStderr = chunk => { stderr += chunk.toString() }
    const onError = error => fail(error)
    const onClose = (code, signal) => fail(new Error(`Native Host exited before Harness Web startup (${String(code ?? signal)}): ${stderr}`))
    const onData = chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (buffer.length < 4 + length) return
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
        buffer = buffer.subarray(4 + length)
        if (message?.type === 'native_error') return fail(new Error(message.error ?? message.message ?? 'Native Host reported an error.'))
        if (message?.type !== 'server_started') continue
        cleanup()
        resolveStarted(message.payload.url)
        return
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onStderr)
    child.once('close', onClose)
    child.once('error', onError)
  })
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
    windowsVerbatimArguments: true,
  })
  try {
    child.stdin.write(encodeNativeMessage({ type: 'start' }))
    const url = await waitForStarted(child)
    const result = await verifyProductUiBoot(url)
    child.stdin.end(encodeNativeMessage({ type: 'stop' }))
    console.log(`Harness Web activated ${result.productClientCount} product client plugins.`)
  } finally {
    setTimeout(() => killWindowsProcessTree(child), 5_000).unref()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
