#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoot = resolve(projectRoot, '.generated')

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function run(command, args, cwd = projectRoot) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function runVisible(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}

function emitClientTypesAllowingPinnedFixtureConflicts(cwd, env) {
  const result = spawnSync('pnpm', ['exec', 'tsc', '-b', 'tsconfig.client.json', '--pretty', 'false'], {
    cwd,
    env,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status === 0) return

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const diagnostics = output.split('\n').filter(line => /error TS\d+:/.test(line))
  const expected = [
    [/^packages\/client\/ui-conversation\/tests\/chat-view\.client\.spec\.tsx\(.*error TS2322:/, 1],
    [/^packages\/client\/ui-conversation\/tests\/input-bar\.client\.spec\.tsx\(.*error TS2375:/, 1],
    [/^packages\/client\/web-react\/tests\/session-provider\.client\.spec\.tsx\(.*error TS2322:/, 2],
    [/^packages\/test-support\/client-runtime\/tests\/runtime\.client\.spec\.tsx\(.*error TS2322:/, 1],
  ]
  const pinnedOnly = diagnostics.length === 5 && expected.every(([pattern, count]) => (
    diagnostics.filter(line => pattern.test(line)).length === count
  ))
  if (!pinnedOnly) {
    process.stderr.write(output)
    throw new Error(`Client type emission failed with ${diagnostics.length} unexpected diagnostic(s)`)
  }
  console.warn('Client types emitted with the 5 pinned upstream React fixture conflicts; continuing with production bundles.')
}

function assertGeneratedTarget(target) {
  const path = relative(generatedRoot, target)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw new Error(`Refusing to replace a Harness product tree outside ${generatedRoot}: ${target}`)
  }
}

const source = resolve(projectRoot, option('--source', 'upstream/deepseek-harness'))
const target = resolve(projectRoot, option('--out', '.generated/harness-product'))
const patchRoot = resolve(projectRoot, option('--patch-dir', 'upstream-contributions'))
const shouldInstall = process.argv.includes('--install') || process.argv.includes('--build')
const shouldBuild = process.argv.includes('--build')

assertGeneratedTarget(target)
if (!existsSync(resolve(source, '.git'))) throw new Error(`Harness source is not a Git checkout: ${source}`)

const revision = run('git', ['rev-parse', 'HEAD'], source)
const patchFiles = (await readdir(patchRoot, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.patch'))
  .map(entry => resolve(patchRoot, entry.name))
  .sort()

await mkdir(generatedRoot, { recursive: true })
const worktrees = run('git', ['worktree', 'list', '--porcelain'], source)
const registered = worktrees
  .split(/\n\n+/)
  .map(block => block.split('\n').find(line => line.startsWith('worktree '))?.slice(9))
  .filter(Boolean)
if (registered.includes(target)) {
  runVisible('git', ['worktree', 'remove', '--force', target], source)
} else if (existsSync(target)) {
  await rm(target, { recursive: true, force: true })
}
runVisible('git', ['worktree', 'prune'], source)
// A regular local clone has its own Git configuration. A linked worktree would
// share the submodule config and Harness' postinstall would reject installing
// worktree-local Lefthook settings. Keeping the clone under .generated still
// guarantees that the official submodule itself remains untouched.
runVisible('git', ['clone', '--no-hardlinks', '--no-checkout', source, target], projectRoot)
// GitHub Windows runners commonly enable core.autocrlf globally. Configure the
// generated clone before checkout so official sources retain their committed LF
// bytes and the portable contribution patches apply identically on every OS.
runVisible('git', ['config', 'core.autocrlf', 'false'], target)
runVisible('git', ['config', 'core.eol', 'lf'], target)
runVisible('git', ['checkout', '--detach', revision], target)

for (const patch of patchFiles) {
  runVisible('git', ['apply', '--check', patch], target)
  runVisible('git', ['apply', '--whitespace=error', patch], target)
}

const manifest = {
  source,
  revision,
  patches: await Promise.all(patchFiles.map(async path => ({
    path: relative(projectRoot, path),
    bytes: Buffer.byteLength(await readFile(path)),
  }))),
}
await writeFile(resolve(target, '.harness-product.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

if (shouldInstall) runVisible('pnpm', ['install', '--frozen-lockfile'], target)
if (shouldBuild) {
  // The pinned official revision currently has five pre-existing React 18/19
  // test-fixture type conflicts in `tsc -b tsconfig.client.json`. They do not
  // affect emitted Client bundles. Keep the production build honest by still
  // compiling the full Host graph, bundling the full Client graph, and building
  // the Web app, while the separate upstream typecheck remains a visible gate.
  const buildEnv = { ...process.env, DSH_BUILD_FACE: '' }
  runVisible('pnpm', ['run', 'build:lib:host'], target, buildEnv)
  // Client bundles consume `lib/types/*.js`. The pinned upstream emits those
  // files despite five React 18/19 test-fixture diagnostics; accept exactly
  // that known set and fail closed on any new production or fixture error.
  emitClientTypesAllowingPinnedFixtureConflicts(target, buildEnv)
  runVisible('pnpm', ['exec', 'tsdown', '--env.DSH_BUILD_FACE', 'client'], target, buildEnv)
  runVisible('pnpm', ['run', 'build:web'], target, buildEnv)
}

console.log(`Materialized Harness product tree at ${target}`)
console.log(`Official revision: ${revision}; generic patches: ${patchFiles.length}`)
