/**
 * Windows x64 files that cannot be produced on macOS.
 *
 * This is deliberately separate from the static Harness JavaScript closure:
 * a Windows machine creates this small, verified input once, while macOS can
 * rebuild the current Harness/product code around it on every package.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WINDOWS_NODE_REQUIREMENT_LABEL } from './node-version-policy.mjs'

export const WINDOWS_NATIVE_ASSETS_MARKER = 'windows-native-assets.json'
export const WINDOWS_NATIVE_ASSETS_FORMAT = 'accrui-windows-native-assets-v1'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const NATIVE_ASSET_LAYOUT = [
  'node-pty/prebuilds/win32-x64/pty.node',
  'sharp/sharp.node',
  'koffi/koffi.node',
  'node-addon-require-builtin/addon.node',
  'ripgrep/rg.exe',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertWindowsBuildHost({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Windows native assets must materialize on Windows x64; current host is ${platform}/${arch}.`)
  }
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
}

export async function resolveWindowsNativePackage(harnessRoot, packageName) {
  const virtualStore = path.join(harnessRoot, 'node_modules', '.pnpm')
  const prefix = `${packageName.replace('/', '+')}@`
  const candidates = (await readdir(virtualStore)).filter((entry) => entry.startsWith(prefix)).sort()
  const matches = []
  for (const candidate of candidates) {
    const candidatePath = path.join(virtualStore, candidate, 'node_modules', ...packageName.split('/'))
    if (existsSync(candidatePath)) matches.push(candidatePath)
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`Ambiguous Windows native package ${packageName}; found ${matches.length} installed versions. Reinstall the Windows Harness product with a clean pnpm store.`)
  throw new Error(`Missing Windows native package: ${packageName}`)
}

async function onlyFile(directory, predicate, description) {
  const files = (await readdir(directory)).filter(predicate)
  if (files.length !== 1) throw new Error(`Expected one ${description} in ${directory}, found ${files.length}`)
  return path.join(directory, files[0])
}

async function copyWindowsNativeAssets(harnessRoot, nativeDir) {
  const sharp = await resolveWindowsNativePackage(harnessRoot, '@img/sharp-win32-x64')
  const nodePty = await resolveWindowsNativePackage(harnessRoot, 'node-pty')
  const koffi = await resolveWindowsNativePackage(harnessRoot, '@koromix/koffi-win32-x64')
  const requireBuiltin = await resolveWindowsNativePackage(harnessRoot, 'node-addon-require-builtin-win32-x64-msvc')
  const ripgrep = await resolveWindowsNativePackage(harnessRoot, '@vscode/ripgrep-win32-x64')

  await mkdir(path.join(nativeDir, 'sharp'), { recursive: true })
  const sharpLib = path.join(sharp, 'lib')
  await cp(sharpLib, path.join(nativeDir, 'sharp'), { recursive: true, dereference: true })
  await cp(await onlyFile(sharpLib, (name) => name.endsWith('.node'), 'Sharp addon'), path.join(nativeDir, 'sharp', 'sharp.node'))
  await cp(path.join(nodePty, 'prebuilds', 'win32-x64'), path.join(nativeDir, 'node-pty', 'prebuilds', 'win32-x64'), { recursive: true, dereference: true })
  await mkdir(path.join(nativeDir, 'koffi'), { recursive: true })
  await cp(path.join(koffi, 'win32_x64', 'koffi.node'), path.join(nativeDir, 'koffi', 'koffi.node'))
  await mkdir(path.join(nativeDir, 'node-addon-require-builtin'), { recursive: true })
  await cp(await onlyFile(path.join(requireBuiltin, 'prebuilt'), (name) => name.endsWith('.node'), 'node-addon-require-builtin addon'), path.join(nativeDir, 'node-addon-require-builtin', 'addon.node'))
  await mkdir(path.join(nativeDir, 'ripgrep'), { recursive: true })
  await cp(path.join(ripgrep, 'bin', 'rg.exe'), path.join(nativeDir, 'ripgrep', 'rg.exe'))
}

async function filesWithHashes(root) {
  const result = {}
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      const relative = path.relative(root, target).replaceAll(path.sep, '/')
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) throw new Error(`Windows native assets must not contain symlinks: ${relative}`)
      if (metadata.isDirectory()) await visit(target)
      else if (metadata.isFile()) result[relative] = sha256(await readFile(target))
    }
  }
  await visit(root)
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

async function assertWindowsBinary(target) {
  const bytes = await readFile(target)
  const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : -1
  if (
    bytes[0] !== 0x4d || bytes[1] !== 0x5a
    || peOffset < 0 || peOffset + 6 > bytes.length
    || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) throw new Error(`Windows native asset is not an x64 PE binary: ${target}`)
}

async function assertNativeLayout(nativeDir) {
  const missing = NATIVE_ASSET_LAYOUT.filter((relative) => !existsSync(path.join(nativeDir, relative)))
  if (missing.length > 0) throw new Error(`Windows native assets are incomplete: missing ${missing.join(', ')}`)
  const files = await filesWithHashes(nativeDir)
  for (const relative of Object.keys(files)) {
    if (/\.(?:node|dll|exe)$/i.test(relative)) await assertWindowsBinary(path.join(nativeDir, relative))
  }
  return files
}

/** A conservative input identity: changed dependency resolution or Node ABI requires a new Windows asset export. */
export async function windowsNativeAssetInputs(sourceDir, { projectRoot = PROJECT_ROOT } = {}) {
  const root = path.resolve(sourceDir)
  const inputFiles = [
    ['harness/package.json', path.join(root, 'package.json')],
    ['harness/pnpm-lock.yaml', path.join(root, 'pnpm-lock.yaml')],
    ['product/package.json', path.join(projectRoot, 'package.json')],
    ['product/pnpm-lock.yaml', path.join(projectRoot, 'pnpm-lock.yaml')],
  ]
  const missing = inputFiles.filter(([, target]) => !existsSync(target)).map(([relative]) => relative)
  if (missing.length > 0) throw new Error(`Built Harness product is missing native asset inputs: ${missing.join(', ')}`)
  const files = {}
  // Git checkout line-ending settings differ between Windows and macOS. These
  // are text inputs, so hash their normalized source form rather than forcing
  // an unnecessary Windows export after a CRLF-only checkout difference.
  for (const [relative, target] of inputFiles) {
    const contents = await readFile(target, 'utf8')
    files[relative] = sha256(contents.replace(/\r\n?/g, '\n'))
  }
  return {
    fingerprint: sha256(JSON.stringify({ files, nodeAbi: process.versions.modules, nodeRequirement: WINDOWS_NODE_REQUIREMENT_LABEL, layout: NATIVE_ASSET_LAYOUT })),
    files,
    nodeAbi: process.versions.modules,
    nodeRequirement: WINDOWS_NODE_REQUIREMENT_LABEL,
    layout: NATIVE_ASSET_LAYOUT,
  }
}

/** Create an immutable-style Windows x64 native input directory. This is the only Windows-only build step. */
export async function materializeWindowsNativeAssets({ sourceDir, outputDir, projectRoot = PROJECT_ROOT, platform = process.platform, arch = process.arch } = {}) {
  assertWindowsBuildHost({ platform, arch })
  if (!sourceDir) throw new Error('Windows native asset materialization requires --source <built Harness product>.')
  if (!outputDir) throw new Error('Windows native asset materialization requires --out <directory>.')
  const sourceRoot = path.resolve(sourceDir)
  const destination = path.resolve(outputDir)
  const staging = `${destination}.staging`
  const inputs = await windowsNativeAssetInputs(sourceRoot, { projectRoot })
  await resetDirectory(staging)
  try {
    const nativeDir = path.join(staging, 'native')
    await copyWindowsNativeAssets(sourceRoot, nativeDir)
    const files = await assertNativeLayout(nativeDir)
    const marker = {
      format: WINDOWS_NATIVE_ASSETS_FORMAT,
      platform: 'win32',
      arch: 'x64',
      inputs,
      files,
    }
    await writeFile(path.join(staging, WINDOWS_NATIVE_ASSETS_MARKER), `${JSON.stringify(marker, null, 2)}\n`)
    await rm(destination, { recursive: true, force: true })
    await cp(staging, destination, { recursive: true, dereference: true })
    return { outputDir: destination, marker }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Rejects missing, tampered, stale, or non-Windows assets before a Mac can package them. */
export async function validateWindowsNativeAssets({ nativeAssetsDir, sourceDir, projectRoot = PROJECT_ROOT } = {}) {
  if (!nativeAssetsDir) throw new Error('Missing Windows native assets. Pass --native-assets <Windows x64 asset directory>.')
  if (!sourceDir) throw new Error('Windows native asset validation requires the current built Harness product.')
  const root = path.resolve(nativeAssetsDir)
  const markerPath = path.join(root, WINDOWS_NATIVE_ASSETS_MARKER)
  if (!existsSync(markerPath)) throw new Error(`Windows native assets are missing ${WINDOWS_NATIVE_ASSETS_MARKER}; export them on Windows x64 first.`)
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  const expectedInputs = await windowsNativeAssetInputs(sourceDir, { projectRoot })
  const markerErrors = []
  if (marker.format !== WINDOWS_NATIVE_ASSETS_FORMAT) markerErrors.push('format')
  if (marker.platform !== 'win32') markerErrors.push('platform')
  if (marker.arch !== 'x64') markerErrors.push('arch')
  if (JSON.stringify(marker.inputs?.layout) !== JSON.stringify(NATIVE_ASSET_LAYOUT)) markerErrors.push('layout')
  if (marker.inputs?.nodeRequirement !== WINDOWS_NODE_REQUIREMENT_LABEL) markerErrors.push('nodeRequirement')
  if (marker.inputs?.nodeAbi !== expectedInputs.nodeAbi) markerErrors.push('nodeAbi')
  if (marker.inputs?.fingerprint !== expectedInputs.fingerprint) markerErrors.push('inputs')
  if (markerErrors.length > 0) throw new Error(`Windows native assets are incompatible with this build: ${markerErrors.join(', ')}. Re-export them on Windows x64.`)
  const files = await assertNativeLayout(path.join(root, 'native'))
  if (JSON.stringify(marker.files) !== JSON.stringify(files)) throw new Error('Windows native assets failed integrity verification. Re-export them on Windows x64.')
  return { root, nativeDir: path.join(root, 'native'), marker }
}

/** Cheap preflight for the Mac command; complete compatibility follows the fresh Harness build. */
export async function assertWindowsNativeAssetsAvailable(nativeAssetsDir) {
  if (!nativeAssetsDir) throw new Error('Missing Windows native assets. Pass --native-assets <Windows x64 asset directory>.')
  const markerPath = path.join(path.resolve(nativeAssetsDir), WINDOWS_NATIVE_ASSETS_MARKER)
  if (!existsSync(markerPath)) throw new Error(`Windows native assets are missing ${WINDOWS_NATIVE_ASSETS_MARKER}; export them on Windows x64 first.`)
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  if (marker.format !== WINDOWS_NATIVE_ASSETS_FORMAT || marker.platform !== 'win32' || marker.arch !== 'x64') {
    throw new Error('Windows native assets have an invalid Windows x64 marker. Re-export them on Windows x64.')
  }
  return path.resolve(nativeAssetsDir)
}

export function parseWindowsNativeAssetsArgs(argv) {
  const options = {}
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!['--source', '--out'].includes(argument)) throw new Error(`Unknown argument: ${argument}`)
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${argument}`)
    options[{ '--source': 'sourceDir', '--out': 'outputDir' }[argument]] = value
    index += 1
  }
  if (!options.sourceDir || !options.outputDir) throw new Error('Missing required options: --source and --out.')
  return options
}
