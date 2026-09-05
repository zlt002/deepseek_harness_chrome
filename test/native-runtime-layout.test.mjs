import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import * as runtime from '../apps/native-server/src/runtime/harness-process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Native runtime directory preserves checkout workspace and product resource locations', () => {
  assert.equal(runtime.resolveHarnessCwd({}), root)
  assert.equal(runtime.resolveHarnessRuntimePlugin({}), join(root, 'packages/harness-runtime/src/index.mjs'))
  assert.equal(runtime.resolveProductSkillsRoot({}), join(root, 'skills'))
  assert.equal(runtime.resolveProductOfficeSkillsPlugin({}), join(root, 'apps/native-server/src/product-office-skills.mjs'))
})

test('Native runtime directory preserves source-based installed plugin and skill locations', async () => {
  const install = await mkdtemp(join(tmpdir(), 'native-layout-'))
  try {
    const host = join(install, 'native-server')
    await cp(join(root, 'apps/native-server/src'), join(host, 'src'), { recursive: true })
    await mkdir(join(install, 'skills'))
    await writeFile(join(host, 'harness-runtime.mjs'), 'export {}\n')
    const installed = await import(pathToFileURL(join(host, 'src/runtime/harness-process.mjs')).href)
    assert.equal(installed.resolveHarnessRuntimePlugin({}), join(host, 'harness-runtime.mjs'))
    assert.equal(installed.resolveProductSkillsRoot({}), join(install, 'skills'))
    assert.equal(installed.resolveProductOfficeSkillsPlugin({}), join(host, 'src/product-office-skills.mjs'))
    const explicitWorkspace = join(install, 'user-workspace')
    assert.equal(installed.resolveHarnessCwd({ DSH_CWD: explicitWorkspace }), explicitWorkspace)
  } finally {
    await rm(install, { recursive: true, force: true })
  }
})
