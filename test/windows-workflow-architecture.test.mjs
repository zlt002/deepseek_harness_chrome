import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = resolve(projectRoot, '.github/workflows/build-windows-lite.yml')
test('Windows CI builds from the recursive upstream submodule and materialized product tree', async () => {
  const workflow = await readFile(workflowPath, 'utf8')

  assert.match(workflow, /uses:\s*actions\/checkout@v4[\s\S]*?submodules:\s*recursive/)
  assert.equal(workflow.match(/uses:\s*actions\/checkout@v4/g)?.length, 1)
  assert.doesNotMatch(workflow, /repository:\s*deepseek-ai\/deepseek-harness/)
  assert.doesNotMatch(workflow, /harness-ui\.patch/)
  assert.doesNotMatch(workflow, /git\s+-C\s+deepseek-harness\s+apply/)

  assert.match(workflow, /working-directory:\s*deepseek_harness_chrome[\s\S]*?run:\s*pnpm install --frozen-lockfile/)
  assert.match(workflow, /run:\s*pnpm verify:upstream/)
  assert.match(workflow, /run:\s*pnpm build:harness-product/)
  assert.match(workflow, /--source \.generated\/harness-product/)
  assert.match(workflow, /--revision \$\{\{ steps\.upstream-hash\.outputs\.sha \}\}/)
  assert.match(workflow, /pnpm materialize:windows-harness-static-runtime --/)
  assert.doesNotMatch(workflow, /pnpm materialize:windows-harness-runtime --/)
  assert.doesNotMatch(workflow, /harness-runtime-win32-x64/)
  assert.match(workflow, /harness-static-win32-x64/)
  assert.match(workflow, /Restore cached Harness product dependencies for static bundling/)
  assert.match(workflow, /cache-harness-product\.outputs\.cache-hit == 'true' && steps\.cache-harness-static-runtime\.outputs\.cache-hit != 'true'/)
  assert.match(workflow, /working-directory: deepseek_harness_chrome\/\.generated\/harness-product[\s\S]*?run: pnpm install --frozen-lockfile --force/)
  const install = workflow.indexOf('run: pnpm install --frozen-lockfile')
  const buildProduct = workflow.indexOf('run: pnpm build:harness-product')
  const materializeRuntime = workflow.indexOf('pnpm materialize:windows-harness-static-runtime --')
  const buildRelease = workflow.indexOf('pnpm release:windows-lite --')
  const acceptRelease = workflow.indexOf('./release/windows-lite/acceptance-windows.ps1')
  const checksum = workflow.indexOf("$zip = 'release/accr-ui-windows-lite-x64.zip'")
  assert.ok(install < buildProduct && buildProduct < materializeRuntime && materializeRuntime < buildRelease)
  assert.ok(buildRelease < acceptRelease && acceptRelease < checksum)
  assert.match(workflow, /-ExpectedVersion "\$\{\{ inputs\.version \|\| '1\.1\.63' \}\}"/)
  const editRelease = workflow.indexOf('gh release edit $env:RELEASE_TAG')
  const releaseTarget = workflow.indexOf("--target '${{ github.sha }}'", editRelease)
  const uploadRelease = workflow.indexOf('gh release upload $env:RELEASE_TAG')
  assert.ok(editRelease >= 0 && editRelease < releaseTarget && releaseTarget < uploadRelease)
  assert.match(workflow, /Windows runner verified install, Chrome\/Edge Native Messaging registration, ping\/pong, upgrade, rollback, and user-data retention/)
  assert.match(workflow, /Visual Chrome\/Edge sidepanel UAT on a target Windows machine remains required/)
  assert.doesNotMatch(workflow, /Real Windows installation, Native Messaging, upgrade, and rollback acceptance are still required/)
  await assert.rejects(access(resolve(projectRoot, 'release/windows-lite/harness-ui.patch')))
})
