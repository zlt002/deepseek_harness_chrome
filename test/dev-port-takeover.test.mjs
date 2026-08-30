import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// scripts/prepare-dev-port.mjs is a POSIX development helper which invokes
// lsof and kill. These process-level fakes are shell scripts, so they cannot
// exercise that contract on Windows (where neither command is present).
const testPosixPortGuard = process.platform === 'win32' ? test.skip : test

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(projectRoot, 'scripts/prepare-dev-port.mjs')

async function createFakeCommands() {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-harness-dev-port-'))
  const lsof = join(directory, 'lsof')
  const kill = join(directory, 'kill')
  const ps = join(directory, 'ps')
  await writeFile(lsof, `#!/bin/sh
case " $* " in
  *" -d cwd "*) printf 'n%s\\n' "$DEV_PORT_TEST_WXT_CWD"; exit 0 ;;
esac
if [ "\${DEV_PORT_TEST_LSOF_EXIT:-0}" -ne 0 ]; then
  exit "\$DEV_PORT_TEST_LSOF_EXIT"
fi
if [ -f "\$DEV_PORT_TEST_KILL_FILE" ] && [ "\${DEV_PORT_TEST_KILL_KEEPS_LISTENING:-0}" -ne 1 ]; then
  exit 0
fi
if [ -f "\$DEV_PORT_TEST_TERM_FILE" ] && [ "\${DEV_PORT_TEST_TERM_KEEPS_LISTENING:-0}" -ne 1 ]; then
  exit 0
fi
printf '%s\\n' "\$DEV_PORT_TEST_LISTENERS"
`, 'utf8')
  await writeFile(ps, `#!/bin/sh
printf '%s\\n' "$DEV_PORT_TEST_WXT_COMMAND"
`, 'utf8')
  await writeFile(kill, `#!/bin/sh
printf '%s\\n' "\$*" >> "\$DEV_PORT_TEST_CALLS_FILE"
if [ "$1" = '-TERM' ]; then
  touch "\$DEV_PORT_TEST_TERM_FILE"
elif [ "$1" = '-KILL' ]; then
  touch "\$DEV_PORT_TEST_KILL_FILE"
fi
`, 'utf8')
  await Promise.all([chmod(lsof, 0o755), chmod(kill, 0o755), chmod(ps, 0o755)])
  return directory
}

async function runPrepare(overrides = {}) {
  const directory = await createFakeCommands()
  const callsFile = join(directory, 'calls')
  const termFile = join(directory, 'term')
  const killFile = join(directory, 'killed')
  const env = {
    ...process.env,
    ...overrides,
    PATH: `${directory}:${process.env.PATH}`,
    DEV_PORT_WAIT_MS: '20',
    DEV_PORT_POLL_MS: '1',
    DEV_PORT_TEST_CALLS_FILE: callsFile,
    DEV_PORT_TEST_TERM_FILE: termFile,
    DEV_PORT_TEST_KILL_FILE: killFile,
    DEV_PORT_TEST_WXT_COMMAND: `node ${join(projectRoot, 'apps/chrome-extension/node_modules/wxt/bin/wxt.mjs')} --port 3101`,
    DEV_PORT_TEST_WXT_CWD: join(projectRoot, 'apps/chrome-extension'),
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: projectRoot, env, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  let calls = ''
  try {
    calls = await readFile(callsFile, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await rm(directory, { recursive: true, force: true })
  return { ...result, calls }
}

testPosixPortGuard('continues without sending signals when port 3101 has no listener', async () => {
  const result = await runPrepare({ DEV_PORT_TEST_LISTENERS: '' })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.calls, '')
  assert.match(result.stdout, /3101 is available/)
})

testPosixPortGuard('terminates every listener and continues after TERM releases port 3101', async () => {
  const result = await runPrepare({ DEV_PORT_TEST_LISTENERS: '101\n202' })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.calls, '-TERM 101\n-TERM 202\n')
  assert.match(result.stdout, /Released port 3101/)
})

testPosixPortGuard('escalates only remaining listeners to KILL when TERM does not release port 3101', async () => {
  const result = await runPrepare({
    DEV_PORT_TEST_LISTENERS: '101\n202',
    DEV_PORT_TEST_TERM_KEEPS_LISTENING: '1',
  })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.calls, '-TERM 101\n-TERM 202\n-KILL 101\n-KILL 202\n')
  assert.match(result.stdout, /Released port 3101/)
})

testPosixPortGuard('fails without signalling when it cannot resolve port 3101 listeners', async () => {
  const result = await runPrepare({ DEV_PORT_TEST_LSOF_EXIT: '2' })

  assert.notEqual(result.code, 0)
  assert.equal(result.calls, '')
  assert.match(result.stderr, /Unable to inspect listeners on port 3101/)
})

testPosixPortGuard('fails without signalling when lsof returns an invalid listener PID', async () => {
  const result = await runPrepare({ DEV_PORT_TEST_LISTENERS: 'not-a-pid' })

  assert.notEqual(result.code, 0)
  assert.equal(result.calls, '')
  assert.match(result.stderr, /Unable to resolve listeners on port 3101/)
})

testPosixPortGuard('fails when port 3101 remains occupied after the bounded KILL wait', async () => {
  const result = await runPrepare({
    DEV_PORT_TEST_LISTENERS: '101',
    DEV_PORT_TEST_TERM_KEEPS_LISTENING: '1',
    DEV_PORT_TEST_KILL_KEEPS_LISTENING: '1',
  })

  assert.notEqual(result.code, 0)
  assert.equal(result.calls, '-TERM 101\n-KILL 101\n')
  assert.match(result.stderr, /Port 3101 remains occupied after TERM and KILL/)
})
