#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ACCRUI_INSTALL_DIRECTORY, ACCRUI_CONNECTOR_TMP_PREFIX } from '../apps/native-server/src/product-runtime-identity.mjs'

const plugin = '@accrui/harness-ui-message-annotations'
const installRoot = join(homedir(), 'Library/Application Support', ACCRUI_INSTALL_DIRECTORY)
const packageDir = join(installRoot, 'native-server/product-plugins/harness-ui-message-annotations')
const profileLink = join(installRoot, 'profile/profiles/web/node_modules', ...plugin.split('/'))

function runningWebCommand() {
  const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return output.split('\n').find(line => line.includes(ACCRUI_CONNECTOR_TMP_PREFIX) && line.includes('apps/cli/lib/bin.js') && line.includes('--profile web'))
}

const command = runningWebCommand()
const patchPath = command === undefined ? undefined : /--patch\s+(\S+)/.exec(command)?.[1]
const patch = patchPath === undefined || !existsSync(patchPath) ? undefined : await readFile(patchPath, 'utf8')
const activeChecks = [
  ['active web process', command !== undefined],
  ['active patch registers plugin', patch?.includes(`name: '${plugin}'`) === true],
]
const checks = process.argv.includes('--active-patch-only') ? activeChecks : [
  ['installed package', existsSync(join(packageDir, 'package.json'))],
  ['profile package link', existsSync(profileLink)],
  ...activeChecks,
]
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
if (existsSync(profileLink)) console.log(`INFO profile target=${await readlink(profileLink).catch(() => '<not-a-link>')}`)
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1
