import { resolve } from 'node:path'
import { launchPreparedUpdate } from '../../apps/native-server/src/release-update/index.mjs'

function requiredOption(name) {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (typeof value !== 'string' || value.startsWith('--')) throw new Error(`Missing ${name}`)
  return value
}

try {
  const packageDir = resolve(requiredOption('--package-dir'))
  const installRoot = resolve(requiredOption('--install-root'))
  const version = requiredOption('--expected-version')
  await launchPreparedUpdate(
    { extractRoot: packageDir, version },
    { installRoot, nativePid: process.pid, platform: 'win32' },
  )
} catch (error) {
  process.stderr.write(`Release-update handoff smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
