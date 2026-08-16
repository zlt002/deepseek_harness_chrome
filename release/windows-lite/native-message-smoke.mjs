#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
const body = Buffer.from('{"type":"ping"}', 'utf8')
const frame = Buffer.alloc(4 + body.length)
frame.writeUInt32LE(body.length, 0)
body.copy(frame, 4)

let stdout = Buffer.alloc(0)
let stderr = ''
const response = await new Promise((resolveResponse, reject) => {
  const timeout = setTimeout(() => {
    child.kill()
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
    if (code === 0) return
    clearTimeout(timeout)
    reject(new Error(`Native Host exited ${String(code)}: ${stderr}`))
  })
  child.stdin.end(frame)
})

if (response?.type !== 'pong') throw new Error(`Unexpected Native Messaging response: ${JSON.stringify(response)}`)
console.log('Native Messaging launcher answered pong.')
