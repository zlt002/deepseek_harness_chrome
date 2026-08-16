#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const launcherIndex = process.argv.indexOf('--launcher')
const launcher = launcherIndex >= 0 ? resolve(process.argv[launcherIndex + 1] ?? '') : ''
if (!launcher || !existsSync(launcher)) throw new Error(`Native Host launcher is missing: ${launcher}`)
if (process.platform !== 'win32') throw new Error('This smoke test must run on Windows.')

const command = process.env.ComSpec || 'cmd.exe'
const child = spawn(command, ['/d', '/s', '/c', `"${launcher}"`], {
  env: process.env,
  stdio: 'pipe',
  windowsHide: true,
})
function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function killProcessTree() {
  if (child.exitCode !== null || child.pid === undefined) return
  spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

let stdout = Buffer.alloc(0)
let stderr = ''
const closed = new Promise((resolveClose) => {
  child.once('close', (code) => resolveClose(code))
})
const response = await new Promise((resolveResponse, reject) => {
  const timeout = setTimeout(() => {
    killProcessTree()
    reject(new Error(`Native Messaging ping timed out: ${stderr}`))
  }, 10_000)
  child.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk])
    if (stdout.length < 4) return
    const length = stdout.readUInt32LE(0)
    if (stdout.length < 4 + length) return
    clearTimeout(timeout)
    resolveResponse(JSON.parse(stdout.subarray(4, 4 + length).toString('utf8')))
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', (error) => {
    clearTimeout(timeout)
    reject(error)
  })
  child.once('close', (code) => {
    clearTimeout(timeout)
    reject(new Error(`Native Host exited before pong (${String(code)}): ${stderr}`))
  })
  child.stdin.write(encodeMessage({ type: 'ping' }))
})

if (response?.type !== 'pong') {
  killProcessTree()
  throw new Error(`Unexpected Native Messaging response: ${JSON.stringify(response)}`)
}

child.stdin.end(encodeMessage({ type: 'stop' }))
const exitCode = await new Promise((resolveExit, reject) => {
  const timeout = setTimeout(() => {
    killProcessTree()
    reject(new Error(`Native Host did not exit after stop: ${stderr}`))
  }, 10_000)
  closed.then((code) => {
    clearTimeout(timeout)
    resolveExit(code)
  })
})
if (exitCode !== 0) throw new Error(`Native Host exited ${String(exitCode)} after pong: ${stderr}`)
console.log('Native Messaging launcher answered pong.')
