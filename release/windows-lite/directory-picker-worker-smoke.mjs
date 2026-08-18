#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function killWindowsProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) child.kill()
}

export function smokeDirectoryPickerWorker({ nodeExecutable, workerPath, timeoutMs = 20_000 }) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawn(nodeExecutable, [workerPath], {
      env: { ...process.env, DSH_DIALOG_TITLE: 'Harness Windows package smoke' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: false,
    })
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killWindowsProcessTree(child)
      if (error) rejectSmoke(error)
      else resolveSmoke({ showing: true })
    }
    const timer = setTimeout(() => finish(new Error(`Directory-picker worker did not report showing: ${stderr}`)), timeoutMs)
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', finish)
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(`Directory-picker worker exited before showing (${String(code ?? signal)}): ${stderr}`))
    })
    child.on('message', message => {
      if (message?.kind === 'error') return finish(new Error(`Directory-picker worker failed: ${message.message}`))
      if (message?.kind === 'showing') finish()
    })
  })
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('This smoke test must run on Windows.')
  const nodeIndex = argv.indexOf('--node')
  const workerIndex = argv.indexOf('--worker')
  const nodeExecutable = nodeIndex >= 0 ? resolve(argv[nodeIndex + 1] ?? '') : ''
  const workerPath = workerIndex >= 0 ? resolve(argv[workerIndex + 1] ?? '') : ''
  if (!nodeExecutable || !existsSync(nodeExecutable)) throw new Error(`Verified Node.js executable is missing: ${nodeExecutable}`)
  if (!workerPath || !existsSync(workerPath)) throw new Error(`Directory-picker worker is missing: ${workerPath}`)
  await smokeDirectoryPickerWorker({ nodeExecutable, workerPath })
  console.log('Directory-picker worker loaded Koffi and reported showing.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
