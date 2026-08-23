#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { PRODUCT_PLUGIN_PACKAGE_NAMES, PRODUCT_TYPECHECK_PLUGIN_PACKAGE_NAMES } from '../apps/native-server/src/product-plugin-manifest.mjs'

const command = process.argv[2]
if (command !== 'test' && command !== 'typecheck') {
  throw new Error('Usage: node scripts/run-product-plugin-command.mjs <test|typecheck>')
}

const packageNames = command === 'typecheck'
  ? PRODUCT_TYPECHECK_PLUGIN_PACKAGE_NAMES
  : PRODUCT_PLUGIN_PACKAGE_NAMES
const invocation = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] }

for (const packageName of packageNames) {
  const result = spawnSync(invocation.command, [
    ...invocation.args,
    '--filter', packageName,
    'run', command,
  ], {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${packageName} ${command} failed with exit code ${String(result.status)}`)
  }
}
