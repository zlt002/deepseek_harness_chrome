#!/usr/bin/env node
// 手动模拟 Chrome Native Messaging：启动 launcher，发 start，打印 host 的所有响应与 stderr。
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCRUI_INSTALL_DIRECTORY, ACCRUI_NATIVE_HOST_NAME } from '../../apps/native-server/src/runtime/product-runtime-identity.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const launcher = process.env.DSH_NATIVE_LAUNCHER?.trim()
  || (process.platform === 'darwin'
    ? resolve(homedir(), 'Library/Application Support', ACCRUI_INSTALL_DIRECTORY, ACCRUI_NATIVE_HOST_NAME)
    : resolve(here, '../..', 'native-host', ACCRUI_NATIVE_HOST_NAME))

const host = spawn(launcher, [], { stdio: ['pipe', 'pipe', 'pipe'] })
host.on('error', (e) => { console.log('SPAWN ERROR:', e.message); process.exit(1) })

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}
function send(msg) { host.stdin.write(frame(msg)) }

let buf = Buffer.alloc(0)
host.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    let msg
    try { msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) } catch { msg = '<bad json>' }
    console.log('HOST ->', JSON.stringify(msg))
    if (msg && (msg.type === 'server_started' || msg.type === 'error')) {
      console.log('terminal response received, sending stop...')
      send({ type: 'stop' })
      setTimeout(() => process.exit(0), 500)
    }
    buf = buf.subarray(4 + len)
  }
})
host.stderr.on('data', (c) => process.stderr.write('[host stderr] ' + c))
host.on('exit', (code, sig) => { console.log(`HOST EXIT code=${code} sig=${sig}`); process.exit(0) })

console.log('sending start...')
send({ type: 'start' })
const stopTimer = setTimeout(() => { console.log('sending stop...'); send({ type: 'stop' }) }, 60_000)
const killTimer = setTimeout(() => { console.log('TIMEOUT 75s'); process.exit(2) }, 75_000)
process.on('exit', () => { clearTimeout(stopTimer); clearTimeout(killTimer) })
