import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = resolve(projectRoot, '.github/workflows/build-windows-lite.yml')
const officialRevision = '47f943859bef60e4160492346772ded9b24f765a'

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
  assert.match(workflow, new RegExp(`--revision ${officialRevision}`))
  const install = workflow.indexOf('run: pnpm install --frozen-lockfile')
  const buildProduct = workflow.indexOf('run: pnpm build:harness-product')
  const materializeRuntime = workflow.indexOf('pnpm materialize:windows-harness-runtime --')
  assert.ok(install < buildProduct && buildProduct < materializeRuntime)
  const editRelease = workflow.indexOf('gh release edit $env:RELEASE_TAG')
  const releaseTarget = workflow.indexOf("--target '${{ github.sha }}'", editRelease)
  const uploadRelease = workflow.indexOf('gh release upload $env:RELEASE_TAG')
  assert.ok(editRelease >= 0 && editRelease < releaseTarget && releaseTarget < uploadRelease)
  await assert.rejects(access(resolve(projectRoot, 'release/windows-lite/harness-ui.patch')))
})
