import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { launchPreparedUpdate } from '../apps/native-server/src/release-update/index.mjs'
import { readUpdateStatus } from '../apps/native-server/src/release-update/update-status.mjs'

async function waitFor(getValue, message = 'Timed out waiting for test setup.') {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const value = getValue()
    if (value !== undefined) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
  throw new Error(message)
}

test('detached updater writes a standalone script and waits for ready before handing cleanup to the installer', async () => {
  let invocation
  const child = new EventEmitter()
  let unrefCalled = false
  child.unref = () => { unrefCalled = true }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    assert.equal(invocation[0], 'cmd.exe')
    assert.deepEqual(invocation[1].slice(0, -1), ['/d', '/s', '/c'])
    const launcherPath = invocation[1].at(-1)
    const launcher = await readFile(launcherPath)
    assert.equal(launcher.every(byte => byte <= 0x7f), true)
    assert.match(launcher.toString('ascii'), /\r\n/)
    assert.match(launcher.toString('ascii'), /> "%~dp0cmd-started" echo started/)
    assert.match(launcher.toString('ascii'), /powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0updater\.ps1"/)
    assert.match(launcher.toString('ascii'), /exit \/b %ERRORLEVEL%/)
    const updaterScriptPath = join(dirname(launcherPath), 'updater.ps1')
    const script = await readFile(updaterScriptPath, 'utf8')
    assert.match(script, /\.accrui-update-status\.json/)
    assert.match(script, /Write-UpdateStatus 'pending'/)
    assert.match(script, /ready/)
    assert.match(script, /go/)
    assert.match(script, /cancel/)
    assert.match(script, /Write-UpdateStatus 'succeeded'/)
    assert.match(script, /Write-UpdateStatus 'failed'/)
    assert.match(script, /Get-Process -Id 1234/)
    assert.match(script, /\$nativeDeadline = \[DateTime\]::UtcNow\.AddSeconds\(10\)/)
    assert.match(script, /while \(\(Get-Process -Id 1234 -ErrorAction SilentlyContinue\) -and \[DateTime\]::UtcNow -lt \$nativeDeadline\)/)
    assert.match(script, /\$progressPath = Join-Path \$installRoot '\.accrui-update-progress\.txt'/)
    assert.match(script, /Remove-Item -LiteralPath \$progressPath -Force -ErrorAction SilentlyContinue/)
    assert.match(script, /& powershell\.exe -NoProfile -ExecutionPolicy Bypass -File '[^']*install\.ps1' -InstallRoot \$installRoot -ProgressPath \$progressPath/)
    assert.match(script, /if \(\$LASTEXITCODE -ne 0\) \{ throw "安装程序退出码：\$LASTEXITCODE" \}/)
    assert.doesNotMatch(script, /Get-OldProductProcesses|while \(Get-Process -Id 1234 -ErrorAction SilentlyContinue\) \{ Start-Sleep/)
    assert.doesNotMatch(script, /taskkill\.exe|Stop-Process|chrome\.exe|msedge\.exe/i)

    child.emit('spawn')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 15))
    assert.equal(unrefCalled, false)
    await writeFile(join(dirname(updaterScriptPath), 'ready'), 'ready', 'utf8')
    assert.equal(await launched, true)
    await access(join(dirname(updaterScriptPath), 'go'))
    assert.equal(unrefCalled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater returns the persisted handoff error when its process exits before ready', async () => {
  let invocation
  const child = new EventEmitter()
  child.unref = () => { throw new Error('unref must not run before ready') }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    const handoffRoot = dirname(invocation[1].at(-1))
    await writeFile(join(handoffRoot, 'error'), 'ACL denied writing ready marker', 'utf8')
    await writeFile(join(handoffRoot, 'cmd-started'), 'started', 'utf8')
    child.emit('exit', 1)
    await assert.rejects(launched, /ACL denied writing ready marker（exit code 1；cmd已启动）/)
    await access(join(handoffRoot, 'cancel'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater returns captured PowerShell stderr when it exits before ready', async () => {
  let invocation
  let stderrFd
  const child = new EventEmitter()
  child.unref = () => { throw new Error('unref must not run before ready') }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        spawnImpl: (...args) => {
          invocation = args
          stderrFd = args[2].stdio[2]
          writeSync(stderrFd, "At updater.ps1:1 char:1\nParserError: Unexpected token '}' in expression.\n")
          return child
        },
      },
    )
    invocation = await waitFor(() => invocation)
    assert.equal(typeof stderrFd, 'number')
    assert.throws(() => writeSync(stderrFd, 'must fail after parent closes its descriptor'), /EBADF|bad file descriptor/i)
    child.emit('spawn')
    child.emit('exit', 1)
    await assert.rejects(launched, /ParserError: Unexpected token '}' in expression\./)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater falls back to a generic error when it exits before ready without a persisted cause', async () => {
  let invocation
  const child = new EventEmitter()
  child.unref = () => { throw new Error('unref must not run before ready') }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    child.emit('exit', 1)
    await assert.rejects(launched, /就绪握手前退出（exit code 1；cmd未启动）/)
    await access(join(dirname(invocation[1].at(-1)), 'cancel'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater cancels without publishing go when it exits while the go marker is being committed', async () => {
  let invocation
  let releaseGo
  let signalGoWrite
  let unrefCalled = false
  const child = new EventEmitter()
  child.unref = () => { unrefCalled = true }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const goWriteStarted = new Promise(resolvePromise => { signalGoWrite = resolvePromise })
    const goWriteReleased = new Promise(resolvePromise => { releaseGo = resolvePromise })
    const writeFileImpl = async (path, ...args) => {
      if (basename(path) === 'go.pending') {
        signalGoWrite()
        await goWriteReleased
      }
      return writeFile(path, ...args)
    }
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        writeFileImpl,
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    await writeFile(join(dirname(invocation[1].at(-1)), 'ready'), 'ready', 'utf8')
    await goWriteStarted
    assert.equal(unrefCalled, true)
    const rejection = assert.rejects(launched, /就绪握手前退出/)
    child.emit('exit', 1)
    releaseGo()
    await rejection
    const handoffRoot = dirname(invocation[1].at(-1))
    await assert.rejects(access(join(handoffRoot, 'go')))
    await access(join(handoffRoot, 'cancel'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater does not publish go when its temporary go marker write fails', async () => {
  let invocation
  const child = new EventEmitter()
  child.unref = () => {}
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const writeFileImpl = async (path, ...args) => {
      if (basename(path) === 'go.pending') {
        await writeFile(path, 'partial', 'utf8')
        throw new Error('go temporary write failed')
      }
      return writeFile(path, ...args)
    }
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        writeFileImpl,
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    await writeFile(join(dirname(invocation[1].at(-1)), 'ready'), 'ready', 'utf8')
    await assert.rejects(launched, /go temporary write failed/)
    const handoffRoot = dirname(invocation[1].at(-1))
    await assert.rejects(access(join(handoffRoot, 'go')))
    await access(join(handoffRoot, 'cancel'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater stops the handshake timeout before slowly committing go', async () => {
  let invocation
  let releaseGo
  let signalGoWrite
  const child = new EventEmitter()
  child.unref = () => {}
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const goWriteStarted = new Promise(resolvePromise => { signalGoWrite = resolvePromise })
    const goWriteReleased = new Promise(resolvePromise => { releaseGo = resolvePromise })
    const writeFileImpl = async (path, ...args) => {
      if (basename(path) === 'go.pending') {
        signalGoWrite()
        await goWriteReleased
      }
      return writeFile(path, ...args)
    }
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        // Windows CI can take hundreds of milliseconds to schedule the spawned
        // cmd process and its first filesystem poll. This test exercises timeout
        // cancellation after the ready handshake, so give that setup a realistic
        // window and then wait past it while committing go is intentionally held.
        handshakeTimeoutMs: 1_000,
        writeFileImpl,
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    await writeFile(join(dirname(invocation[1].at(-1)), 'ready'), 'ready', 'utf8')
    await goWriteStarted
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_100))
    const handoffRoot = dirname(invocation[1].at(-1))
    await assert.rejects(access(join(handoffRoot, 'cancel')))
    releaseGo()
    assert.equal(await launched, true)
    await access(join(handoffRoot, 'go'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater reports a cancellation marker write failure with the original error', async () => {
  let invocation
  const child = new EventEmitter()
  child.unref = () => {}
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const writeFileImpl = async (path, ...args) => {
      if (basename(path) === 'cancel') throw new Error('disk full')
      return writeFile(path, ...args)
    }
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        handshakeTimeoutMs: 20,
        writeFileImpl,
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    await assert.rejects(launched, /未在 20ms 内完成就绪握手。；取消标记写入失败：disk full/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater cancels a late ready handshake instead of allowing a delayed install', async () => {
  let invocation
  const child = new EventEmitter()
  child.unref = () => { throw new Error('unref must not run after handshake timeout') }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        handshakeTimeoutMs: 20,
        spawnImpl: (...args) => { invocation = args; return child },
      },
    )
    invocation = await waitFor(() => invocation)
    child.emit('spawn')
    await assert.rejects(launched, /未在 .* 内完成就绪握手/)
    const handoffRoot = dirname(invocation[1].at(-1))
    await access(join(handoffRoot, 'cancel'))
    await writeFile(join(handoffRoot, 'ready'), 'late', 'utf8')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    await assert.rejects(access(join(handoffRoot, 'go')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater reports a PowerShell spawn failure before the Native Host can confirm the update', async () => {
  const child = new EventEmitter()
  child.unref = () => { throw new Error('unref must not run after spawn failure') }
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    const launched = launchPreparedUpdate(
      { version: '1.1.81', extractRoot: root },
      {
        installRoot: join(root, 'install-root'),
        nativePid: 1234,
        platform: 'win32',
        spawnImpl: () => child,
      },
    )
    const failure = new Error('powershell.exe is unavailable')
    const rejection = assert.rejects(launched, failure)
    await waitFor(() => child.listenerCount('error') > 0 ? true : undefined)
    child.emit('error', failure)
    await rejection
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached updater closes the stderr capture descriptor when PowerShell spawn throws', async () => {
  let stderrFd
  const root = await mkdtemp(join(tmpdir(), 'release-update-launch-'))
  try {
    await assert.rejects(
      launchPreparedUpdate(
        { version: '1.1.81', extractRoot: root },
        {
          installRoot: join(root, 'install-root'),
          nativePid: 1234,
          platform: 'win32',
          spawnImpl: (...args) => {
            stderrFd = args[2].stdio[2]
            throw new Error('powershell.exe is unavailable')
          },
        },
      ),
      /powershell\.exe is unavailable/,
    )
    assert.equal(typeof stderrFd, 'number')
    assert.throws(() => writeSync(stderrFd, 'must fail after spawn throws'), /EBADF|bad file descriptor/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
