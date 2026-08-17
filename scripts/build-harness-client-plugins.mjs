#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedHarness = join(projectRoot, '.generated', 'harness-product')
const explicitHarnessRoot = process.env.DSH_ROOT?.trim()
const harnessRoot = resolve(explicitHarnessRoot || generatedHarness)
if (!explicitHarnessRoot && !existsSync(join(generatedHarness, '.harness-product.json'))) {
  throw new Error(`Generated product Harness is missing: ${generatedHarness}. Run pnpm build:harness-product first, or set DSH_ROOT explicitly for a different Harness checkout.`)
}
const packageNames = [
  'harness-ui-agent-preset',
  'harness-ui-browser-target',
  'harness-ui-knowledge-scope',
  'harness-ui-subagent-compact',
  'harness-skill-settings',
]
const selected = process.argv.slice(2)
const unknown = selected.filter(name => !packageNames.includes(name))
if (unknown.length > 0) throw new Error(`Unknown Harness client plugin: ${unknown.join(', ')}`)

const tsdown = join(harnessRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs')
if (!existsSync(tsdown)) {
  throw new Error(`Official Harness build dependency is missing: ${tsdown}. Run pnpm install in ${harnessRoot}.`)
}

for (const name of selected.length > 0 ? selected : packageNames) {
  const cwd = join(projectRoot, 'packages', name)
  // Execute the real JS entrypoint instead of a platform-specific .bin shim;
  // Node cannot spawn Windows .cmd shims directly without a command shell.
  const result = spawnSync(process.execPath, [tsdown, '--config', 'tsdown.config.ts'], {
    cwd,
    env: { ...process.env, DSH_BUILD_FACE: '', DSH_ROOT: harnessRoot },
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Building ${name} failed:\n${(result.stderr || result.stdout || '').trim()}`)
  }
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  for (const artifact of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(cwd, artifact))) throw new Error(`${name} did not emit ${artifact}`)
  }
}
