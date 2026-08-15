/**
 * Materialize a Windows x64 DeepSeek Harness runtime from a built sibling
 * checkout. The only public operation owns deploy, reshaping, native checks,
 * smoke testing, and marker creation behind one seam.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..')
const DEFAULT_SOURCE_DIR = path.resolve(PROJECT_ROOT, '..', 'deepseek-harness')
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'release', 'windows-lite', 'harness-runtime-win32-x64')
const MARKER_FILE = 'harness-runtime.json'
const FRONTEND_DIST = 'node_modules/@deepseek-ai/dsh-web-frontend/dist'
const REQUIRED_VENDOR_PACKAGES = [
  { name: '@deepseek-ai/cosmokit', directory: 'vendor/cosmokit' },
  { name: '@deepseek-ai/schemastery', directory: 'vendor/schemastery' },
  { name: '@deepseek-ai/cordis-plugin-group', directory: 'vendor/group' },
  { name: '@deepseek-ai/cordis-plugin-logger-console', directory: 'vendor/logger-console' },
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}): ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
}

async function copyDereferenced(source, destination) {
  await cp(source, destination, { recursive: true, dereference: true, force: true })
}

export function assertWindowsMaterializationHost({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Windows x64 runtime materialization must run on Windows x64; current host is ${platform}/${arch}.`)
  }
}

export async function validateBuiltHarnessCheckout(sourceDir) {
  const root = path.resolve(sourceDir)
  const required = ['package.json', 'apps/cli/lib/bin.js', 'apps/web/dist/index.html', 'pnpm-lock.yaml']
  const missing = required.filter((relativePath) => !existsSync(path.join(root, relativePath)))
  if (missing.length > 0) throw new Error(`Harness checkout is not built: missing ${missing.join(', ')}`)
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh-root') {
    throw new Error(`Harness checkout package.json must identify @deepseek-ai/dsh-root, received ${String(manifest.name)}`)
  }
  return root
}

function sourceRevision(sourceDir, requestedRevision) {
  const head = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!requestedRevision) return head
  const expected = execFileSync('git', ['-C', sourceDir, 'rev-parse', `${requestedRevision}^{commit}`], { encoding: 'utf8' }).trim()
  if (expected !== head) throw new Error(`Harness checkout HEAD ${head} does not match requested revision ${expected}.`)
  return head
}

export function legacyDeployArgs({ sourceDir, deployDir }) {
  return ['--dir', sourceDir, '--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', '--ignore-scripts', deployDir]
}

function deployHarnessCli({ sourceDir, deployDir }) {
  run('pnpm.cmd', legacyDeployArgs({ sourceDir, deployDir }), { shell: process.platform === 'win32' })
}

async function assertNoExternalSymlinks(root) {
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      const metadata = await lstat(child)
      if (metadata.isSymbolicLink()) {
        const target = await realpath(child)
        const relative = path.relative(root, target)
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) continue
        throw new Error(`Deployed runtime contains an external symlink: ${child} -> ${target}`)
      }
      if (metadata.isDirectory()) await visit(child)
    }
  }
  await visit(root)
}

async function materializeExternalVendorSymlinks({ root, sourceDir, deployedModules }) {
  const targetPackages = new Map()
  for (const vendorPackage of REQUIRED_VENDOR_PACKAGES) {
    const sourcePackage = await realpath(path.join(sourceDir, vendorPackage.directory))
    targetPackages.set(sourcePackage.toLowerCase(), path.join(deployedModules, ...vendorPackage.name.split('/')))
  }
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      const metadata = await lstat(child)
      if (metadata.isSymbolicLink()) {
        const target = await realpath(child)
        const replacement = targetPackages.get(target.toLowerCase())
        if (replacement === undefined) continue
        await unlink(child)
        await copyDereferenced(replacement, child)
        continue
      }
      if (metadata.isDirectory()) await visit(child)
    }
  }
  await visit(root)
}

async function findNativeAddons(root) {
  const addons = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && entry.name.endsWith('.node')) addons.push(child)
    }
  }
  await visit(root)
  return addons
}

export async function assertWindowsNativeClosure(nodeModulesDir) {
  const nodePtyDir = path.join(nodeModulesDir, 'node-pty')
  const addons = await findNativeAddons(nodeModulesDir)
  const nodePtyAddons = addons.filter((addon) => addon.includes(`${path.sep}node-pty${path.sep}`))
  if (existsSync(nodePtyDir)) {
    const targetDirectory = `${path.sep}prebuilds${path.sep}win32-x64${path.sep}`
    const targetAddons = nodePtyAddons.filter((addon) => addon.includes(targetDirectory))
    if (targetAddons.length === 0) throw new Error('Windows runtime contains node-pty but no win32-x64 prebuilt addon.')
    for (const addon of targetAddons) {
      const header = await readFile(addon)
      if (header[0] !== 0x4d || header[1] !== 0x5a) throw new Error(`node-pty win32-x64 addon is not a Windows PE binary: ${addon}`)
    }
  }
  const activeAddons = addons.filter((addon) => !addon.includes(`${path.sep}node-pty${path.sep}prebuilds${path.sep}`))
  for (const addon of activeAddons) {
    if (/(?:darwin|linux|android|freebsd|openbsd|sunos)-(?:arm64|x64|ia32|armv7l)/.test(addon)) {
      throw new Error(`Windows runtime contains a non-Windows platform native package: ${addon}`)
    }
    const header = await readFile(addon)
    if (header[0] !== 0x4d || header[1] !== 0x5a) {
      throw new Error(`Native addon is not a Windows PE binary: ${addon}`)
    }
  }
  return [...new Set([...nodePtyAddons.filter((addon) => addon.includes(`${path.sep}prebuilds${path.sep}win32-x64${path.sep}`)), ...activeAddons])]
    .map((addon) => path.relative(nodeModulesDir, addon).replaceAll('\\', '/')).sort()
}

async function copyRequiredVendorPackages({ sourceDir, deployedModules }) {
  for (const vendorPackage of REQUIRED_VENDOR_PACKAGES) {
    const sourcePackageDir = path.join(sourceDir, vendorPackage.directory)
    const sourceManifestPath = path.join(sourcePackageDir, 'package.json')
    const sourceLibDir = path.join(sourcePackageDir, 'lib')
    if (!existsSync(sourceManifestPath) || !existsSync(sourceLibDir)) {
      throw new Error(`Built Harness vendor package is missing lib/package.json: ${vendorPackage.directory}`)
    }
    const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
    if (manifest.name !== vendorPackage.name) {
      throw new Error(`Vendor package name mismatch for ${vendorPackage.directory}: ${String(manifest.name)}`)
    }
    const destination = path.join(deployedModules, ...vendorPackage.name.split('/'))
    await mkdir(destination, { recursive: true })
    await copyDereferenced(sourceManifestPath, path.join(destination, 'package.json'))
    await copyDereferenced(sourceLibDir, path.join(destination, 'lib'))
  }
}

async function assembleRuntime({ sourceDir, deployedDir, outputDir, revision, smoke = run }) {
  const deployedCli = path.join(deployedDir, 'lib', 'bin.js')
  const deployedModules = path.join(deployedDir, 'node_modules')
  const frontendDist = path.join(deployedDir, FRONTEND_DIST)
  const sourceFrontendDist = path.join(sourceDir, 'apps', 'web', 'dist')
  const required = [deployedCli, deployedModules, path.join(sourceFrontendDist, 'index.html')]
  const missing = required.filter((target) => !existsSync(target))
  if (missing.length > 0) throw new Error(`Harness runtime inputs are incomplete: ${missing.join(', ')}`)
  await copyRequiredVendorPackages({ sourceDir, deployedModules })
  await materializeExternalVendorSymlinks({ root: deployedDir, sourceDir, deployedModules })
  await copyDereferenced(sourceFrontendDist, frontendDist)
  await assertNoExternalSymlinks(deployedDir)
  const nativeAddons = await assertWindowsNativeClosure(deployedModules)
  await mkdir(path.join(outputDir, 'apps', 'cli'), { recursive: true })
  await copyDereferenced(path.join(deployedDir, 'lib'), path.join(outputDir, 'apps', 'cli', 'lib'))
  await copyDereferenced(path.join(deployedDir, 'config'), path.join(outputDir, 'apps', 'cli', 'config'))
  await copyDereferenced(deployedModules, path.join(outputDir, 'node_modules'))
  await copyDereferenced(frontendDist, path.join(outputDir, 'apps', 'web', 'dist'))
  await writeFile(path.join(outputDir, 'apps', 'cli', 'package.json'), await readFile(path.join(deployedDir, 'package.json')))
  await writeFile(path.join(outputDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-root', private: true, type: 'module' }, null, 2)}\n`)
  const smokeResult = smoke(process.execPath, ['apps/cli/lib/bin.js', '--help'], {
    cwd: outputDir,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
  })
  if (smokeResult.status !== 0 || !`${smokeResult.stdout ?? ''}${smokeResult.stderr ?? ''}`.includes('dsh')) {
    throw new Error(`Harness runtime smoke failed: ${(smokeResult.stderr || smokeResult.stdout || '').trim()}`)
  }
  const marker = {
    format: 'deepseek-harness-windows-runtime-v1',
    platform: 'win32',
    arch: 'x64',
    revision,
    entrypoint: 'apps/cli/lib/bin.js',
    closureComplete: true,
    nativeAddons,
  }
  await writeFile(path.join(outputDir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return marker
}

/** Materialize and verify a portable Windows x64 runtime without touching the sibling checkout. */
export async function materializeHarnessRuntime({
  sourceDir = DEFAULT_SOURCE_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  revision,
  platform = process.platform,
  arch = process.arch,
  deploy = deployHarnessCli,
  smoke,
  resolveRevision = sourceRevision,
} = {}) {
  assertWindowsMaterializationHost({ platform, arch })
  const sourceRoot = await validateBuiltHarnessCheckout(sourceDir)
  const resolvedRevision = resolveRevision(sourceRoot, revision)
  const absoluteOutput = path.resolve(outputDir)
  const stagingDir = `${absoluteOutput}.staging`
  const deployDir = path.join(stagingDir, 'deploy')
  await resetDirectory(stagingDir)
  try {
    await deploy({ sourceDir: sourceRoot, deployDir })
    const marker = await assembleRuntime({ sourceDir: sourceRoot, deployedDir: deployDir, outputDir: path.join(stagingDir, 'runtime'), revision: resolvedRevision, smoke })
    await rm(absoluteOutput, { recursive: true, force: true })
    await rename(path.join(stagingDir, 'runtime'), absoluteOutput)
    return { outputDir: absoluteOutput, marker }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

export function parseMaterializerArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!['--source', '--out', '--revision'].includes(argument)) throw new Error(`Unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${argument}`)
    options[{ '--source': 'sourceDir', '--out': 'outputDir', '--revision': 'revision' }[argument]] = value
    index += 1
  }
  return options
}

async function main() {
  const result = await materializeHarnessRuntime(parseMaterializerArgs(process.argv.slice(2)))
  console.log(`Materialized ${result.outputDir}`)
  console.log(`Harness revision: ${result.marker.revision}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
