#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedHarness = join(projectRoot, '.generated', 'harness-product')
const harnessRoot = resolve(process.env.DSH_ROOT?.trim() || (
  existsSync(join(generatedHarness, '.harness-product.json'))
    ? generatedHarness
    : join(projectRoot, 'upstream', 'deepseek-harness')
))
const packageNames = [
  'harness-ui-agent-preset',
  'harness-ui-browser-target',
  'harness-ui-knowledge-scope',
  'harness-skill-settings',
]
const selected = process.argv.slice(2)
const unknown = selected.filter(name => !packageNames.includes(name))
if (unknown.length > 0) throw new Error(`Unknown Harness client plugin: ${unknown.join(', ')}`)

const executable = process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown'
const tsdown = join(harnessRoot, 'node_modules', '.bin', executable)
if (!existsSync(tsdown)) {
  throw new Error(`Official Harness build dependency is missing: ${tsdown}. Run pnpm install in ${harnessRoot}.`)
}

for (const name of selected.length > 0 ? selected : packageNames) {
  const cwd = join(projectRoot, 'packages', name)
  const result = spawnSync(tsdown, ['--config', 'tsdown.config.ts'], {
    cwd,
    env: { ...process.env, DSH_BUILD_FACE: '' },
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
