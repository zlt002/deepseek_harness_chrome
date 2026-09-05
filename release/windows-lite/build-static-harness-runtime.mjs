/**
 * Builds the Windows form of the proven Mac static Web runtime.
 *
 * The JavaScript closure is bundled by esbuild. Only native Windows sidecars
 * are copied from the Windows pnpm store; a release must never copy a full
 * Harness node_modules tree.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  RUNTIME_SELECTED_PLUGIN_PACKAGES,
  STATIC_REGISTRY_PACKAGE_OVERRIDES,
  bundleDirectoryPickerWorker,
  bundleWithHarnessEsbuild,
  copyWebClientPackages,
  copyWithoutSourceMaps,
  directoryPickerKoffiShimSource,
  patchBundledWorkerPaths,
  shippedPresetConfigs,
  staticBundleAliases,
  staticPluginRegistry,
  staticTypertPackages,
  staticWebRunner,
} from '../mac-lite/build-mac-production.mjs'
import { bundleHarnessDefaultWorkspacePlugin, bundleHarnessRuntimePlugin, bundleHarnessTrackingPlugin } from '../../scripts/build/bundle-harness-runtime-plugin.mjs'
import { materializeWindowsNativeAssets, validateWindowsNativeAssets } from './windows-native-assets.mjs'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..')
const GENERATED_HARNESS_ROOT = path.join(PROJECT_ROOT, '.generated', 'harness-product')
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'release', 'windows-lite', 'harness-static-win32-x64')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return result
}

function runPnpm(args, options = {}) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args], options)
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, options)
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
}

async function sizeOf(root) {
  let bytes = 0
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) bytes += (await stat(child)).size
    }
  }
  await visit(root)
  return bytes
}

/** Ensure the packaged child process cannot fall back to a Harness node_modules tree. */
export async function assertDirectoryPickerWorkerContract({ serverPath, workerPath }) {
  if (!existsSync(workerPath)) throw new Error(`Static runtime is missing directory-picker worker: ${workerPath}`)
  const [server, worker] = await Promise.all([readFile(serverPath, 'utf8'), readFile(workerPath, 'utf8')])
  if (!server.includes('directory-picker-worker.cjs')) throw new Error('Static server does not point directory-picker-native at directory-picker-worker.cjs.')
  if (worker.includes('node_modules')) throw new Error('Static directory-picker worker must not depend on runtime/harness/node_modules.')
}

/**
 * The static server normally resolves this entry from its package tree. The
 * Windows release deliberately has no Harness node_modules tree, so keep the
 * resolver pointed at the sibling standalone runner instead.
 */
export async function patchBundledWindowsAclRunnerPath(serverPath) {
  const source = await readFile(serverPath, 'utf8')
  // esbuild renames imported helpers (for example fileURLToPath2) when the
  // complete server contains another binding with the same name.
  const packageEntry = /\bfileURLToPath\d*\(\s*import\.meta\.resolve\((['"])@deepseek-ai\/dsh-sandbox-windows-acl\/runner\1\)\s*\)/g
  const relativeEntry = 'fileURLToPath(new URL("./windows-acl-runner.cjs", import.meta.url))'
  const matches = [...source.matchAll(packageEntry)]
  if (matches.length !== 1) {
    throw new Error('Static server does not resolve the Windows ACL runner from its package entry.')
  }
  await writeFile(serverPath, source.replace(packageEntry, relativeEntry))
}

/** Build the upstream ACL runner with its Koffi JS code and the shipped native sidecar. */
export async function bundleWindowsAclRunner({ harnessRoot = GENERATED_HARNESS_ROOT, outfile } = {}) {
  if (!outfile) throw new Error('bundleWindowsAclRunner requires outfile')
  const runner = path.join(harnessRoot, 'packages', 'sandbox', 'sandbox-windows-acl', 'lib', 'runner.js')
  if (!existsSync(runner)) throw new Error(`Built Windows ACL runner is missing: ${runner}`)
  const shim = path.join(path.dirname(outfile), '.windows-acl-koffi-shim.cjs')
  await mkdir(path.dirname(outfile), { recursive: true })
  await writeFile(shim, directoryPickerKoffiShimSource())
  const program = `
import { build } from 'esbuild';
await build({
  entryPoints: [process.env.DSH_WINDOWS_ACL_RUNNER],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'bundle',
  alias: { koffi: process.env.DSH_WINDOWS_ACL_KOFFI_SHIM },
  outfile: process.env.DSH_WINDOWS_ACL_OUTFILE,
});
`
  try {
    run(process.execPath, ['--input-type=module', '-e', program], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DSH_WINDOWS_ACL_RUNNER: runner,
        DSH_WINDOWS_ACL_KOFFI_SHIM: shim,
        DSH_WINDOWS_ACL_OUTFILE: outfile,
      },
    })
  } finally {
    await rm(shim, { force: true })
  }
}

/** Ensure the release runner cannot resolve into runtime/harness/node_modules. */
export async function assertWindowsAclRunnerContract({ serverPath, runnerPath }) {
  if (!existsSync(runnerPath)) throw new Error(`Static runtime is missing Windows ACL runner: ${runnerPath}`)
  const [server, runner] = await Promise.all([readFile(serverPath, 'utf8'), readFile(runnerPath, 'utf8')])
  if (!server.includes('new URL("./windows-acl-runner.cjs", import.meta.url)')) {
    throw new Error('Static server does not point sandbox-local at windows-acl-runner.cjs.')
  }
  if (runner.includes('node_modules')) throw new Error('Static Windows ACL runner must not depend on runtime/harness/node_modules.')
  if (!runner.includes('native/koffi/koffi.node')) throw new Error('Static Windows ACL runner does not load the shipped Koffi sidecar.')
}

/**
 * Creates a static Harness closure rooted at outputDir. The profile directory
 * is deliberately external: dsh plugin add writes user-installed plugins
 * there, so upgrades never overwrite plugins or user data.
 */
export async function buildWindowsStaticHarnessRuntime({
  sourceDir = GENERATED_HARNESS_ROOT,
  outputDir = DEFAULT_OUTPUT_DIR,
  revision = 'unknown',
  nativeAssetsDir,
  platform = process.platform,
  arch = process.arch,
  nativeAssetPlatform = platform,
  nativeAssetArch = arch,
} = {}) {
  const harnessRoot = path.resolve(sourceDir)
  const required = [
    path.join(harnessRoot, '.harness-product.json'),
    path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'),
    path.join(harnessRoot, 'apps', 'web', 'dist', 'index.html'),
    path.join(harnessRoot, 'apps', 'cli', 'config'),
  ]
  for (const target of required) if (!existsSync(target)) throw new Error(`Built Harness product input is missing: ${target}`)

  // Product plugin artifacts are intentionally not committed. Build them
  // against this exact materialized Harness so a clean CI checkout has the
  // concrete lib/index.js and lib/client.js files required below.
  runPnpm(['build:harness-client-plugins'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DSH_ROOT: harnessRoot },
  })

  const destination = path.resolve(outputDir)
  const staging = `${destination}.staging`
  const harnessDir = path.join(staging, 'harness')
  const cliDir = path.join(harnessDir, 'apps', 'cli')
  const configDir = path.join(cliDir, 'config')
  const temporary = path.join(staging, '.build')
  await resetDirectory(staging)
  try {
    // The JS closure is cross-built with an explicit win32-x64 resolver below.
    // Only copying native sidecars needs a real Windows x64 host. Without an
    // imported asset directory, retain the existing all-Windows behavior.
    const nativeAssets = nativeAssetsDir
      ? await validateWindowsNativeAssets({ nativeAssetsDir, sourceDir: harnessRoot })
      : await materializeWindowsNativeAssets({
        sourceDir: harnessRoot,
        outputDir: path.join(staging, '.native-assets'),
        platform: nativeAssetPlatform,
        arch: nativeAssetArch,
      })
    const nativeAssetMarker = nativeAssets.marker
    const dumpHome = path.join(temporary, 'dump-home')
    const dump = run(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'web', '--dump-default-config'], {
      cwd: harnessRoot,
      env: { ...process.env, DSH_HOME: dumpHome, DSH_TELEMETRY_DISABLED: '1' },
    }).stdout
    const presetConfigs = await shippedPresetConfigs(path.join(harnessRoot, 'apps', 'cli', 'config'))
    const { aliases, staticConfig } = staticPluginRegistry(dump, presetConfigs.map((preset) => preset.contents))
    if (aliases.size === 0) throw new Error('Static Web profile contains no plugin entries')
    const allAliases = new Map([...aliases, ...RUNTIME_SELECTED_PLUGIN_PACKAGES.map((name, index) => [name, `d${index}`])])
    const typertPackages = await staticTypertPackages(allAliases)
    const bundlePath = path.join(temporary, 'server.mjs')
    bundleWithHarnessEsbuild({
      contents: staticWebRunner(aliases, typertPackages),
      sourcefile: 'static-web-runner.mjs',
      resolveDir: path.join(harnessRoot, 'apps', 'cli'),
      outfile: bundlePath,
      nativeTarget: 'win32-x64',
      aliases: {
        ...staticBundleAliases([...STATIC_REGISTRY_PACKAGE_OVERRIDES, ...RUNTIME_SELECTED_PLUGIN_PACKAGES], harnessRoot),
        ...Object.fromEntries(typertPackages.map((entry) => [`${entry.name}/typert`, entry.artifactPath])),
      },
    })
    await patchBundledWorkerPaths(bundlePath, { includeDirectoryPicker: true })
    await patchBundledWindowsAclRunnerPath(bundlePath)

    const nativeServerPath = path.join(temporary, 'native-server.mjs')
    const pluginManagerPath = path.join(temporary, 'plugin-manager.mjs')
    runPnpm(['exec', 'esbuild', path.join(PROJECT_ROOT, 'apps', 'native-server', 'bin.mjs'), '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle', `--outfile=${nativeServerPath}`], { cwd: PROJECT_ROOT })
    runPnpm(['exec', 'esbuild', path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'), '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle', `--outfile=${pluginManagerPath}`], { cwd: PROJECT_ROOT })

    await mkdir(path.join(cliDir, 'lib'), { recursive: true })
    await cp(bundlePath, path.join(cliDir, 'lib', 'server.mjs'))
    await bundleDirectoryPickerWorker({
      harnessRoot,
      outfile: path.join(cliDir, 'lib', 'directory-picker-worker.cjs'),
    })
    await assertDirectoryPickerWorkerContract({
      serverPath: path.join(cliDir, 'lib', 'server.mjs'),
      workerPath: path.join(cliDir, 'lib', 'directory-picker-worker.cjs'),
    })
    await bundleWindowsAclRunner({
      harnessRoot,
      outfile: path.join(cliDir, 'lib', 'windows-acl-runner.cjs'),
    })
    await assertWindowsAclRunnerContract({
      serverPath: path.join(cliDir, 'lib', 'server.mjs'),
      runnerPath: path.join(cliDir, 'lib', 'windows-acl-runner.cjs'),
    })
    await cp(pluginManagerPath, path.join(cliDir, 'lib', 'plugin-manager.mjs'))
    for (const worker of [
      ['code-runtime/code-runtime-worker-thread', 'code-runtime-worker.cjs'],
      ['workflow/workflow-worker-thread', 'workflow-worker.cjs'],
    ]) await cp(path.join(harnessRoot, 'packages', worker[0], 'lib', 'worker.cjs'), path.join(cliDir, 'lib', worker[1]))

    await copyWithoutSourceMaps(path.join(harnessRoot, 'apps', 'cli', 'config'), configDir)
    await writeFile(path.join(configDir, 'static-web.cordis.yml'), staticConfig)
    for (const preset of presetConfigs) {
      // Use the common aliases, not a one-file local registry.
      await writeFile(path.join(configDir, preset.relativePath), preset.contents.replace(/^([ \t]*name:\s+)['"]([^'"]+)['"]\s*$/gm, (line, prefix, name) => aliases.has(name) ? `${prefix}'cordis:${aliases.get(name)}'` : line))
    }
    await copyWebClientPackages(allAliases, configDir, { harnessRoot })
    await writeFile(path.join(cliDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.5', type: 'module' }, null, 2)}\n`)
    await copyWithoutSourceMaps(path.join(harnessRoot, 'apps', 'web', 'dist'), path.join(harnessDir, 'apps', 'web', 'dist'))
    await mkdir(path.join(harnessDir, 'vendor', 'schemastery', 'lib'), { recursive: true })
    runPnpm(['exec', 'esbuild', path.join(harnessRoot, 'vendor', 'schemastery', 'lib', 'index.mjs'), '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${path.join(harnessDir, 'vendor', 'schemastery', 'lib', 'index.mjs')}`], { cwd: PROJECT_ROOT })
    await writeFile(path.join(harnessDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-root', private: true, type: 'module' }, null, 2)}\n`)
    await mkdir(path.join(staging, 'native-server'), { recursive: true })
    await cp(nativeServerPath, path.join(staging, 'native-server', 'runtime.mjs'))
    await cp(path.join(PROJECT_ROOT, 'apps', 'native-server', 'src', 'knowledge', 'selected-source-routing-prompt.mjs'), path.join(staging, 'native-server', 'selected-source-routing-prompt.mjs'))
    await cp(path.join(PROJECT_ROOT, 'apps', 'native-server', 'src', 'product-office-skills.mjs'), path.join(staging, 'native-server', 'product-office-skills.mjs'))
    await bundleHarnessRuntimePlugin({ outfile: path.join(staging, 'native-server', 'harness-runtime.mjs'), projectRoot: PROJECT_ROOT })
    await bundleHarnessTrackingPlugin({ outfile: path.join(staging, 'native-server', 'harness-tracking.mjs'), projectRoot: PROJECT_ROOT })
    await bundleHarnessDefaultWorkspacePlugin({ outfile: path.join(staging, 'native-server', 'harness-default-workspace.mjs'), projectRoot: PROJECT_ROOT })
    await cp(nativeAssets.nativeDir ?? path.join(nativeAssets.outputDir, 'native'), path.join(staging, 'native'), { recursive: true, dereference: true })
    await rm(path.join(staging, '.native-assets'), { recursive: true, force: true })
    const marker = {
      format: 'deepseek-harness-windows-static-web-v1', platform: 'win32', arch: 'x64', revision,
      entrypoint: 'harness/apps/cli/lib/server.mjs', bundled: true, nodeModulesIncluded: false,
      dynamicPluginRepository: 'managed-web-profile', staticWebPluginCount: aliases.size,
      nativeAssets: {
        format: nativeAssetMarker.format,
        inputsFingerprint: nativeAssetMarker.inputs.fingerprint,
        filesFingerprint: createHash('sha256').update(JSON.stringify(nativeAssetMarker.files)).digest('hex'),
      },
    }
    await writeFile(path.join(staging, 'harness-runtime.json'), `${JSON.stringify(marker, null, 2)}\n`)
    await rm(temporary, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
    await cp(staging, destination, { recursive: true, dereference: true })
    return { outputDir: destination, marker, bytes: await sizeOf(destination) }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export function parseStaticRuntimeArgs(argv) {
  const options = {}
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!['--source', '--out', '--revision', '--native-assets'].includes(argument)) throw new Error(`Unknown argument: ${argument}`)
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${argument}`)
    options[{ '--source': 'sourceDir', '--out': 'outputDir', '--revision': 'revision', '--native-assets': 'nativeAssetsDir' }[argument]] = value
    index += 1
  }
  return options
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildWindowsStaticHarnessRuntime(parseStaticRuntimeArgs(process.argv.slice(2))).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1) },
  )
}
