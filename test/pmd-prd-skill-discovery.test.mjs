import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(projectRoot, '../deepseek-harness')

test('the real Harness skill provider discovers /pmd-prd as user-only', async () => {
  const { Context } = await import(pathToFileURL(resolve(harnessRoot, 'vendor/cordis/lib/index.js')))
  const SkillRegistry = (await import(pathToFileURL(resolve(harnessRoot, 'packages/skill/skill/lib/index.js')))).default
  const SkillFileSystem = await import(pathToFileURL(resolve(harnessRoot, 'packages/skill/skill-filesystem/lib/index.js')))
  const home = await mkdtemp(join(tmpdir(), 'dsh-pmd-skill-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false,
      includeDefaultRoots: false, customSkillDirs: [resolve(projectRoot, 'skills')],
    })
    const skill = (await ctx.skills.list({ cwd: projectRoot })).find((candidate) => candidate.name === 'pmd-prd')
    assert.equal(skill?.source, 'custom')
    assert.deepEqual(skill?.invocation, { modelInvocable: false, userInvocable: true })
  } finally { await ctx.dispose?.() }
})
