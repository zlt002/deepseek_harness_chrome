#!/usr/bin/env node
/** Build a fresh Windows Lite ZIP on macOS using a verified Windows native asset export. */
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertWindowsNativeAssetsAvailable } from './windows-native-assets.mjs'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}

function runPnpm(args) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args])
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args)
}

export function parseMacWindowsReleaseArgs(argv) {
  const options = {}
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!['--native-assets', '--version', '--out'].includes(argument)) throw new Error(`Unknown argument: ${argument}`)
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${argument}`)
    options[{ '--native-assets': 'nativeAssetsDir', '--version': 'version', '--out': 'releaseDir' }[argument]] = value
    index += 1
  }
  if (!options.nativeAssetsDir) throw new Error('Missing required option: --native-assets <Windows x64 asset directory>.')
  return options
}

export async function buildWindowsLiteWithNativeAssets({ nativeAssetsDir, version, releaseDir } = {}) {
  if (!nativeAssetsDir) throw new Error('buildWindowsLiteWithNativeAssets requires nativeAssetsDir.')
  const verifiedNativeAssetsDir = await assertWindowsNativeAssetsAvailable(nativeAssetsDir)
  // Always rebuild the generated Harness and extension first. A cached native
  // directory is never allowed to make JavaScript/UI output stale.
  runPnpm(['build:harness-product'])
  runPnpm(['build'])
  const revision = execFileSync('git', ['-C', path.join(PROJECT_ROOT, 'upstream', 'deepseek-harness'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runtimeDir = path.join(PROJECT_ROOT, 'release', 'windows-lite', 'harness-static-win32-x64')
  run(process.execPath, [
    path.join(MODULE_DIR, 'build-static-harness-runtime.mjs'),
    '--source', path.join(PROJECT_ROOT, '.generated', 'harness-product'),
    '--out', runtimeDir,
    '--revision', revision,
    '--native-assets', verifiedNativeAssetsDir,
  ])
  const releaseArgs = [
    path.join(MODULE_DIR, 'windows-release.mjs'),
    '--harness-runtime', runtimeDir,
  ]
  if (version) releaseArgs.push('--version', version)
  if (releaseDir) releaseArgs.push('--out', path.resolve(releaseDir))
  run(process.execPath, releaseArgs)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildWindowsLiteWithNativeAssets(parseMacWindowsReleaseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  })
}
