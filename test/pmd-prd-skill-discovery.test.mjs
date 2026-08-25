import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(projectRoot, '.generated/harness-product')

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

test('the real Harness skill registry resolves duplicate pmd-prd from the first generated-patch root', async () => {
  const { Context } = await import(pathToFileURL(resolve(harnessRoot, 'vendor/cordis/lib/index.js')))
  const SkillRegistry = (await import(pathToFileURL(resolve(harnessRoot, 'packages/skill/skill/lib/index.js')))).default
  const SkillFileSystem = await import(pathToFileURL(resolve(harnessRoot, 'packages/skill/skill-filesystem/lib/index.js')))
  const home = await mkdtemp(join(tmpdir(), 'dsh-pmd-conflict-'))
  const harnessSkills = join(home, 'harness-skills')
  const claudeSkills = join(home, 'claude-skills')
  const ctx = new Context()
  try {
    await Promise.all([
      mkdir(join(harnessSkills, 'pmd-prd'), { recursive: true }),
      mkdir(join(claudeSkills, 'pmd-prd'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(harnessSkills, 'pmd-prd/SKILL.md'), `---\nname: pmd-prd\ndescription: Harness-native\nuser-invocable: true\n---\nHarness-native run binding: automatically creates requirementId.\n`),
      writeFile(join(claudeSkills, 'pmd-prd/SKILL.md'), `---\nname: pmd-prd\ndescription: Legacy\nuser-invocable: true\n---\nLegacy pmd-workspace marker.\n`),
    ])
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false,
      includeDefaultRoots: false, customSkillDirs: [harnessSkills, claudeSkills],
    })
    const listed = (await ctx.skills.list({ cwd: home })).filter((candidate) => candidate.name === 'pmd-prd')
    const skill = await ctx.skills.get('pmd-prd', { cwd: home })
    assert.equal(listed.length, 1)
    assert.equal(skill?.path, join(harnessSkills, 'pmd-prd/SKILL.md'))
    assert.match(skill?.content ?? '', /Harness-native run binding/)
    assert.doesNotMatch(skill?.content ?? '', /pmd-workspace/)
  } finally {
    await ctx.dispose?.()
    await rm(home, { recursive: true, force: true })
  }
})
