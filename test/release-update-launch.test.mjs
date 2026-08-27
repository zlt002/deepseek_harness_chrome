import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import test from 'node:test'
import { launchPreparedUpdate } from '../apps/native-server/src/release-update/index.mjs'
import { readUpdateStatus } from '../apps/native-server/src/release-update/update-status.mjs'

test('detached updater hands cleanup to the installer as soon as the Native Host exits', async () => {
  let invocation
  const child = new EventEmitter()
  child.unref = () => {}
  const launched = launchPreparedUpdate(
    { version: '1.1.81', extractRoot: 'C:\\temp\\package' },
    {
      installRoot: 'C:\\Users\\tester\\AppData\\Local\\accr-ui-harness',
      nativePid: 1234,
      platform: 'win32',
      spawnImpl: (...args) => { invocation = args; return child },
    },
  )
  assert.equal(invocation[0], 'powershell.exe')
  const command = invocation[1].at(-1)
  assert.match(command, /\.accrui-update-status\.json/)
  assert.match(command, /Write-UpdateStatus 'pending'/)
  assert.match(command, /Write-UpdateStatus 'succeeded'/)
  assert.match(command, /Write-UpdateStatus 'failed'/)
  assert.match(command, /Get-Process -Id 1234/)
  assert.match(command, /\$nativeDeadline = \[DateTime\]::UtcNow\.AddSeconds\(10\)/)
  assert.match(command, /while \(\(Get-Process -Id 1234 -ErrorAction SilentlyContinue\) -and \[DateTime\]::UtcNow -lt \$nativeDeadline\)/)
  assert.match(command, /& powershell\.exe -NoProfile -ExecutionPolicy Bypass -File '[^']*install\.ps1' -InstallRoot \$installRoot/)
  assert.match(command, /if \(\$LASTEXITCODE -ne 0\) \{ throw "安装程序退出码：\$LASTEXITCODE" \}/)
  assert.doesNotMatch(command, /Get-OldProductProcesses|while \(Get-Process -Id 1234 -ErrorAction SilentlyContinue\) \{ Start-Sleep/)
  assert.doesNotMatch(command, /taskkill\.exe|Stop-Process|chrome\.exe|msedge\.exe/i)
  child.emit('spawn')
  assert.equal(await launched, true)
})

test('detached updater reports a PowerShell spawn failure before the Native Host can confirm the update', async () => {
  const child = new EventEmitter()
  child.unref = () => { throw new Error('unref must not run after spawn failure') }
  const launched = launchPreparedUpdate(
    { version: '1.1.81', extractRoot: 'C:\\temp\\package' },
    {
      installRoot: 'C:\\Users\\tester\\AppData\\Local\\accr-ui-harness',
      nativePid: 1234,
      platform: 'win32',
      spawnImpl: () => child,
    },
  )
  const failure = new Error('powershell.exe is unavailable')
  child.emit('error', failure)
  await assert.rejects(launched, failure)
})

test('reads the last persisted updater result from the install root', async () => {
  let requestedPath
  const status = await readUpdateStatus('/tmp/accr-ui-harness', {
    readFileImpl: async path => {
      requestedPath = path
      return JSON.stringify({ state: 'failed', version: '1.1.81', updatedAt: '2026-08-27T00:00:00.000Z', error: '安装内容不完整', logPath: '%TEMP%\\accr-ui-harness-install.log' })
    },
  })
  assert.equal(requestedPath, resolve('/tmp/accr-ui-harness', '.accrui-update-status.json'))
  assert.deepEqual(status, { state: 'failed', version: '1.1.81', updatedAt: '2026-08-27T00:00:00.000Z', error: '安装内容不完整', logPath: '%TEMP%\\accr-ui-harness-install.log' })
})
