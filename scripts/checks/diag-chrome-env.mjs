// 用接近 Chrome 启动 native host 的精简环境启动 launcher，发 start，看能否复现 "host exited"
import { spawn } from 'node:child_process'
import { ACCRUI_INSTALL_DIRECTORY, ACCRUI_NATIVE_HOST_NAME } from '../../apps/native-server/src/runtime/product-runtime-identity.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const launcher = process.env.ACCRUI_NATIVE_LAUNCHER?.trim()
  || join(homedir(), 'Library/Application Support', ACCRUI_INSTALL_DIRECTORY, ACCRUI_NATIVE_HOST_NAME)
const chromeLikeEnv = {
  HOME: process.env.HOME,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
}
console.log('精简环境变量:', Object.keys(chromeLikeEnv))
const host = spawn(launcher, [], { stdio: ['pipe','pipe','pipe'], env: chromeLikeEnv })
host.on('error', e => { console.log('SPAWN ERROR:', e.message); process.exit(1) })
host.stderr.on('data', c => process.stderr.write('[stderr] ' + c))
let buf = Buffer.alloc(0)
host.stdout.on('data', c => {
  buf = Buffer.concat([buf, c])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4+len) break
    let m; try { m = JSON.parse(buf.subarray(4,4+len).toString()) } catch { m='<bad>' }
    console.log('HOST ->', JSON.stringify(m))
    if (m && (m.type==='server_started'||m.type==='error')) { send({type:'stop'}); setTimeout(()=>process.exit(0),500) }
    buf = buf.subarray(4+len)
  }
})
host.on('exit', (code,sig) => { console.log('HOST EXIT code='+code+' sig='+sig); process.exit(0) })
function frame(m){const b=Buffer.from(JSON.stringify(m));const h=Buffer.allocUnsafe(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b])}
function send(m){host.stdin.write(frame(m))}
send({type:'start'})
setTimeout(()=>{console.log('TIMEOUT 90s');process.exit(2)},90000)
