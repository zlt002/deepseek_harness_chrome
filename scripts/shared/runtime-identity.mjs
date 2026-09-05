import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { RUNTIME_IDENTITY_FORMAT, validRuntimeIdentitySummary } from '../../apps/native-server/src/runtime/runtime-identity-contract.mjs'

export { RUNTIME_IDENTITY_FORMAT }

async function filesUnder(root, directory = root) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(root, path))
    else if (entry.isFile()) files.push({ path, relativePath: relative(root, path) })
  }
  return files
}

export async function hashRuntimeTrees(roots) {
  const hash = createHash('sha256')
  let fileCount = 0
  for (const root of roots) {
    for (const file of (await filesUnder(root)).sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
      if (file.relativePath === 'runtime-manifest.json') continue
      hash.update(`${relative(roots[0], root)}\0${file.relativePath}\0`)
      hash.update(await readFile(file.path))
      hash.update('\0')
      fileCount += 1
    }
  }
  return { sha256: hash.digest('hex'), fileCount }
}

export async function createRuntimeIdentity({ harnessRoot, assetRoots, pluginRoots = [], bootEntries, productBootEntries = bootEntries }) {
  const markerPath = join(harnessRoot, '.harness-product.json')
  if (!existsSync(markerPath)) throw new Error(`Harness product identity is missing: ${markerPath}`)
  const markerText = await readFile(markerPath, 'utf8')
  const marker = JSON.parse(markerText)
  if (typeof marker.revision !== 'string' || marker.revision.length === 0 || !Array.isArray(marker.patches)) {
    throw new Error('Harness product identity is invalid')
  }
  const productHash = createHash('sha256').update(markerText).digest('hex')
  const assets = await hashRuntimeTrees(assetRoots)
  const plugins = pluginRoots.length === 0 ? undefined : await hashRuntimeTrees(pluginRoots)
  return {
    format: RUNTIME_IDENTITY_FORMAT,
    upstreamRevision: marker.revision,
    productHash,
    assetHash: assets.sha256,
    assetFileCount: assets.fileCount,
    ...(plugins === undefined ? {} : { pluginHash: plugins.sha256, pluginFileCount: plugins.fileCount }),
    patches: marker.patches.map((patch) => patch.path),
    bootEntries: bootEntries.map((entry) => entry.id),
    productBootEntries: productBootEntries.map((entry) => typeof entry === 'string' ? entry : entry.id),
  }
}

export function validRuntimeIdentity(value) {
  return validRuntimeIdentitySummary(value)
    && Array.isArray(value.patches) && value.patches.every((item) => typeof item === 'string')
}
