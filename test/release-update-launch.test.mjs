import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { launchPreparedUpdate } from '../apps/native-server/src/release-update/index.mjs'
import { readUpdateStatus } from '../apps/native-server/src/release-update/update-status.mjs'

test('detached updater persists outcome and waits only for old product processes', () => {
  let invocation
  const child = { unref: () => {} }
  launchPreparedUpdate(
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
  assert.match(command, /Get-OldProductProcesses/)
  assert.match(command, /Get-Process -Id 1234/)
  assert.doesNotMatch(command, /taskkill\.exe|Stop-Process|chrome\.exe|msedge\.exe/i)
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
