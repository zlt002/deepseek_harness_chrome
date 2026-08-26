#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')

async function bundleProductHostPlugin({
  outfile,
  projectRoot = PROJECT_ROOT,
  entry,
  label,
} = {}) {
  if (!outfile) throw new Error(`${label} requires outfile`)
  await mkdir(dirname(outfile), { recursive: true })
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' })
  return outfile
}

export async function bundleHarnessRuntimePlugin({
  outfile,
  projectRoot = PROJECT_ROOT,
} = {}) {
  return bundleProductHostPlugin({
    outfile,
    projectRoot,
    entry: resolve(projectRoot, 'packages/harness-runtime/src/index.mjs'),
    label: 'bundleHarnessRuntimePlugin',
  })
}

export async function bundleHarnessTrackingPlugin({
  outfile,
  projectRoot = PROJECT_ROOT,
} = {}) {
  return bundleProductHostPlugin({
    outfile,
    projectRoot,
    entry: resolve(projectRoot, 'packages/harness-tracking/src/index.mjs'),
    label: 'bundleHarnessTrackingPlugin',
  })
}

export async function bundleHarnessDefaultWorkspacePlugin({
  outfile,
  projectRoot = PROJECT_ROOT,
} = {}) {
  return bundleProductHostPlugin({
    outfile,
    projectRoot,
    entry: resolve(projectRoot, 'packages/harness-default-workspace/src/index.mjs'),
    label: 'bundleHarnessDefaultWorkspacePlugin',
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2]
  await bundleHarnessRuntimePlugin({ outfile: outfile && resolve(outfile) })
  console.log(outfile)
}
