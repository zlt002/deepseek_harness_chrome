/**
 * Builds the Windows form of the proven Mac static Web runtime.
 *
 * The JavaScript closure is bundled by esbuild. Only native Windows sidecars
 * are copied from the Windows pnpm store; a release must never copy a full
 * Harness node_modules tree.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  RUNTIME_SELECTED_PLUGIN_PACKAGES,
  STATIC_REGISTRY_PACKAGE_OVERRIDES,
  bundleWithHarnessEsbuild,
  copyWebClientPackages,
  copyWithoutSourceMaps,
  patchBundledWorkerPaths,
  shippedPresetConfigs,
  staticPluginRegistry,
  staticTypertPackages,
  staticWebRunner,
} from '../mac-lite/build-mac-production.mjs'
import { bundleHarnessRuntimePlugin } from '../../scripts/bundle-harness-runtime-plugin.mjs'

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

async function packagePath(harnessRoot, packageName) {
  const virtualStore = path.join(harnessRoot, 'node_modules', '.pnpm')
  const prefix = `${packageName.replace('/', '+')}@`
  const candidates = (await readdir(virtualStore)).filter((entry) => entry.startsWith(prefix)).sort()
  for (const candidate of candidates) {
    const candidatePath = path.join(virtualStore, candidate, 'node_modules', ...packageName.split('/'))
    if (existsSync(candidatePath)) return candidatePath
  }
  throw new Error(`Missing Windows native package: ${packageName}`)
}

async function onlyFile(directory, predicate, description) {
  const files = (await readdir(directory)).filter(predicate)
  if (files.length !== 1) throw new Error(`Expected one ${description} in ${directory}, found ${files.length}`)
  return path.join(directory, files[0])
}

async function copyWindowsNativeAssets(harnessRoot, nativeDir) {
  const sharp = await packagePath(harnessRoot, '@img/sharp-win32-x64')
  const nodePty = await packagePath(harnessRoot, 'node-pty')
  const koffi = await packagePath(harnessRoot, '@koromix/koffi-win32-x64')
  const requireBuiltin = await packagePath(harnessRoot, 'node-addon-require-builtin-win32-x64-msvc')
  const ripgrep = await packagePath(harnessRoot, '@vscode/ripgrep-win32-x64')

  await mkdir(path.join(nativeDir, 'sharp'), { recursive: true })
  const sharpLib = path.join(sharp, 'lib')
  await cp(sharpLib, path.join(nativeDir, 'sharp'), { recursive: true, dereference: true })
  await cp(await onlyFile(sharpLib, (name) => name.endsWith('.node'), 'Sharp addon'), path.join(nativeDir, 'sharp', 'sharp.node'))
  await cp(path.join(nodePty, 'prebuilds', 'win32-x64'), path.join(nativeDir, 'node-pty', 'prebuilds', 'win32-x64'), { recursive: true, dereference: true })
  await mkdir(path.join(nativeDir, 'koffi'), { recursive: true })
  await cp(await onlyFile(koffi, (name) => name.endsWith('.node'), 'Koffi addon'), path.join(nativeDir, 'koffi', 'koffi.node'))
  await mkdir(path.join(nativeDir, 'node-addon-require-builtin'), { recursive: true })
  await cp(await onlyFile(path.join(requireBuiltin, 'prebuilt'), (name) => name.endsWith('.node'), 'node-addon-require-builtin addon'), path.join(nativeDir, 'node-addon-require-builtin', 'addon.node'))
  await mkdir(path.join(nativeDir, 'ripgrep'), { recursive: true })
  await cp(path.join(ripgrep, 'bin', 'rg.exe'), path.join(nativeDir, 'ripgrep', 'rg.exe'))
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

function assertWindowsBuildHost({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error(`Static Windows runtime must build on Windows x64; current host is ${platform}/${arch}.`)
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
  platform = process.platform,
  arch = process.arch,
} = {}) {
  assertWindowsBuildHost({ platform, arch })
  const harnessRoot = path.resolve(sourceDir)
  const required = [
    path.join(harnessRoot, '.harness-product.json'),
    path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'),
    path.join(harnessRoot, 'apps', 'web', 'dist', 'index.html'),
    path.join(harnessRoot, 'apps', 'cli', 'config'),
  ]
  for (const target of required) if (!existsSync(target)) throw new Error(`Built Harness product input is missing: ${target}`)

  const destination = path.resolve(outputDir)
  const staging = `${destination}.staging`
  const harnessDir = path.join(staging, 'harness')
  const cliDir = path.join(harnessDir, 'apps', 'cli')
  const configDir = path.join(cliDir, 'config')
  const temporary = path.join(staging, '.build')
  await resetDirectory(staging)
  try {
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
      aliases: Object.fromEntries([...new Set([...STATIC_REGISTRY_PACKAGE_OVERRIDES, ...RUNTIME_SELECTED_PLUGIN_PACKAGES])].map((name) => [
        name,
        path.join(harnessRoot, 'node_modules', '.pnpm', 'node_modules', ...name.split('/')),
      ]).concat(typertPackages.map((entry) => [`${entry.name}/typert`, entry.artifactPath]))),
    })
    await patchBundledWorkerPaths(bundlePath)

    const nativeServerPath = path.join(temporary, 'native-server.mjs')
    const pluginManagerPath = path.join(temporary, 'plugin-manager.mjs')
    runPnpm(['exec', 'esbuild', path.join(PROJECT_ROOT, 'apps', 'native-server', 'bin.mjs'), '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle', `--outfile=${nativeServerPath}`], { cwd: PROJECT_ROOT })
    runPnpm(['exec', 'esbuild', path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'), '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle', `--outfile=${pluginManagerPath}`], { cwd: PROJECT_ROOT })

    await mkdir(path.join(cliDir, 'lib'), { recursive: true })
    await cp(bundlePath, path.join(cliDir, 'lib', 'server.mjs'))
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
    await copyWebClientPackages(allAliases, configDir)
    await writeFile(path.join(cliDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.5', type: 'module' }, null, 2)}\n`)
    await copyWithoutSourceMaps(path.join(harnessRoot, 'apps', 'web', 'dist'), path.join(harnessDir, 'apps', 'web', 'dist'))
    await mkdir(path.join(harnessDir, 'vendor', 'schemastery', 'lib'), { recursive: true })
    runPnpm(['exec', 'esbuild', path.join(harnessRoot, 'vendor', 'schemastery', 'lib', 'index.mjs'), '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${path.join(harnessDir, 'vendor', 'schemastery', 'lib', 'index.mjs')}`], { cwd: PROJECT_ROOT })
    await writeFile(path.join(harnessDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-root', private: true, type: 'module' }, null, 2)}\n`)
    await mkdir(path.join(staging, 'native-server'), { recursive: true })
    await cp(nativeServerPath, path.join(staging, 'native-server', 'runtime.mjs'))
    await cp(path.join(PROJECT_ROOT, 'apps', 'native-server', 'src', 'selected-source-routing-prompt.mjs'), path.join(staging, 'native-server', 'selected-source-routing-prompt.mjs'))
    await bundleHarnessRuntimePlugin({ outfile: path.join(staging, 'native-server', 'harness-runtime.mjs'), projectRoot: PROJECT_ROOT, harnessRoot })
    await copyWindowsNativeAssets(harnessRoot, path.join(staging, 'native'))
    const marker = {
      format: 'deepseek-harness-windows-static-web-v1', platform: 'win32', arch: 'x64', revision,
      entrypoint: 'harness/apps/cli/lib/server.mjs', bundled: true, nodeModulesIncluded: false,
      dynamicPluginRepository: 'managed-web-profile', staticWebPluginCount: aliases.size,
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildWindowsStaticHarnessRuntime(parseStaticRuntimeArgs(process.argv.slice(2))).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1) },
  )
}
