import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`Missing ${name}`)
  return path.resolve(value)
}

function quotePwsh(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function runRunner(node, runner, workspace, temp, mode, command) {
  return spawnSync(node, [
    runner,
    '--workspace', workspace,
    '--temp', temp,
    '--mode', mode,
    '--', 'pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8', timeout: 30_000 })
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function assertDenied(result, target, label) {
  assert.equal(result.status, 13, `${label} must preserve Pwsh's denial exit code: ${combinedOutput(result)}`)
  assert.match(combinedOutput(result), /ACL-PWSH-DENIED:/, `${label} must retain the child failure diagnostic`)
  assert.equal(existsSync(target), false, `${label} unexpectedly wrote ${target}`)
}

const node = argument('--node')
const runner = argument('--runner')
const workspace = argument('--workspace')
const outside = argument('--outside')
const temp = path.join(path.dirname(outside), 'acl-runner-temp')

if (!existsSync(runner)) throw new Error(`Installed Windows ACL runner is missing: ${runner}`)
mkdirSync(workspace, { recursive: true })
mkdirSync(outside, { recursive: true })
mkdirSync(temp, { recursive: true })

const workspaceWrite = path.join(workspace, 'acl-workspace-write.txt')
const outsideWrite = path.join(outside, 'acl-outside-write.txt')
const readonlyWrite = path.join(workspace, 'acl-readonly-write.txt')

try {
  const workspaceResult = runRunner(
    node,
    runner,
    workspace,
    temp,
    'workspace-write',
    `$ErrorActionPreference='Stop'; Set-Content -LiteralPath ${quotePwsh(workspaceWrite)} -Value 'ok'; Write-Output 'ACL-PWSH-WORKSPACE: OK'`,
  )
  assert.equal(workspaceResult.status, 0, `workspace-write Pwsh failed: ${combinedOutput(workspaceResult)}`)
  assert.match(combinedOutput(workspaceResult), /ACL-PWSH-WORKSPACE: OK/)
  assert.equal(existsSync(workspaceWrite), true, 'workspace-write did not write the installed workspace')

  const outsideResult = runRunner(
    node,
    runner,
    workspace,
    temp,
    'workspace-write',
    `$ErrorActionPreference='Stop'; try { Set-Content -LiteralPath ${quotePwsh(outsideWrite)} -Value 'escape'; Write-Output 'ACL-PWSH-ESCAPE: UNEXPECTED'; exit 12 } catch { [Console]::Error.WriteLine('ACL-PWSH-DENIED: ' + $_.Exception.Message); exit 13 }`,
  )
  assertDenied(outsideResult, outsideWrite, 'workspace-write outside workspace')

  const readonlyResult = runRunner(
    node,
    runner,
    workspace,
    temp,
    'read-only',
    `$ErrorActionPreference='Stop'; try { Set-Content -LiteralPath ${quotePwsh(readonlyWrite)} -Value 'escape'; Write-Output 'ACL-PWSH-READONLY: UNEXPECTED'; exit 12 } catch { [Console]::Error.WriteLine('ACL-PWSH-DENIED: ' + $_.Exception.Message); exit 13 }`,
  )
  assertDenied(readonlyResult, readonlyWrite, 'read-only workspace')

  const runnerFailure = spawnSync(node, [
    runner,
    '--workspace', workspace,
    '--temp', temp,
    '--mode', 'invalid',
    '--', 'pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0',
  ], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(runnerFailure.status, 127, `invalid ACL runner mode must fail closed: ${combinedOutput(runnerFailure)}`)
  assert.match(combinedOutput(runnerFailure), /windows-acl-run: unknown mode: invalid/, 'ACL runner failure detail was not transparent')
  console.log('Installed Windows ACL runner Pwsh smoke passed.')
} finally {
  rmSync(temp, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
