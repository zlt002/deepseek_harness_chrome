#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')

export async function bundleHarnessRuntimePlugin({
  outfile,
  projectRoot = PROJECT_ROOT,
  harnessRoot = resolve(projectRoot, 'upstream/deepseek-harness'),
} = {}) {
  if (!outfile) throw new Error('bundleHarnessRuntimePlugin requires outfile')
  const entry = resolve(projectRoot, 'packages/harness-runtime/src/index.mjs')
  await mkdir(dirname(outfile), { recursive: true })
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' })
  return outfile
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2]
  await bundleHarnessRuntimePlugin({ outfile: outfile && resolve(outfile) })
  console.log(outfile)
}
