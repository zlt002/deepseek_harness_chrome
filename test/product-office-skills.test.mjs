import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { claudeSkillsPatch, PRODUCT_OFFICE_SKILL_NAMES, resolveProductSkillsRoot } from '../apps/native-server/src/harness-process.mjs'
import {
  loadProductOfficeSkill,
  parseProductOfficeSkillMarkdown,
  PRODUCT_OFFICE_SKILL_PROVIDER,
  PRODUCT_OFFICE_SKILL_SOURCE,
} from '../apps/native-server/src/product-office-skills.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(projectRoot, '.generated/harness-product')

test('ships the four product office skills with invocable catalog frontmatter', async () => {
  const root = resolveProductSkillsRoot({})
  assert.equal(root, resolve(projectRoot, 'skills'))
  for (const name of PRODUCT_OFFICE_SKILL_NAMES) {
    const loaded = await loadProductOfficeSkill(join(root, name), name)
    assert.equal(loaded.name, name)
    assert.ok(loaded.description.length > 0)
    assert.match(loaded.content, /# /)
    const raw = await readFile(loaded.path, 'utf8')
    const parsed = parseProductOfficeSkillMarkdown(raw)
    assert.equal(parsed?.name, name)
  }
})

test('the real Harness registry keeps product office skills ahead of user and project duplicates', async () => {
  const { Context } = await import(pathToFileURL(resolve(harnessRoot, 'vendor/cordis/lib/index.js')))
  const SkillRegistry = (await import(pathToFileURL(resolve(harnessRoot, 'packages/skill/skill/lib/index.js')))).default
  const SkillFileSystem = await import(pathToFileURL(resolve(harnessRoot, 'packages/skill/skill-filesystem/lib/index.js')))
  const ProductOfficeSkills = await import(pathToFileURL(resolve(projectRoot, 'apps/native-server/src/product-office-skills.mjs')))
  const home = await mkdtemp(join(tmpdir(), 'dsh-office-skill-'))
  const project = join(home, 'workspace')
  const claudeSkills = join(home, '.claude/skills')
  const ctx = new Context()
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    for (const name of PRODUCT_OFFICE_SKILL_NAMES) {
      await mkdir(join(project, '.dsh/skills', name), { recursive: true })
      await mkdir(join(claudeSkills, name), { recursive: true })
      await writeFile(join(project, '.dsh/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Project override\n---\nProject ${name} body.\n`)
      await writeFile(join(claudeSkills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Claude override\n---\nClaude ${name} body.\n`)
    }
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ProductOfficeSkills, { skillsRoot: resolve(projectRoot, 'skills') })
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: false,
      includeDefaultRoots: true,
      customSkillDirs: [resolve(projectRoot, 'skills'), claudeSkills],
    })
    const listed = await ctx.skills.list({ cwd: project })
    for (const name of PRODUCT_OFFICE_SKILL_NAMES) {
      const matches = listed.filter((candidate) => candidate.name === name)
      assert.equal(matches.length, 1, name)
      assert.equal(matches[0]?.source, PRODUCT_OFFICE_SKILL_SOURCE)
      assert.equal(matches[0]?.provider, PRODUCT_OFFICE_SKILL_PROVIDER)
      const skill = await ctx.skills.get(name, { cwd: project })
      assert.equal(skill?.path, join(projectRoot, 'skills', name, 'SKILL.md'))
      assert.doesNotMatch(skill?.content ?? '', /Project |Claude /)
      assert.match(skill?.content ?? '', /# /)
    }
  } finally {
    await ctx.dispose?.()
    await rm(home, { recursive: true, force: true })
  }
})

test('the generated Native Host patch points the office provider at the product skill root', async () => {
  const patch = claudeSkillsPatch({ HOME: '/tmp/office-skill-home', DSH_PRODUCT_SKILLS_ROOT: '/opt/runtime/skills' })
  const productSkillsRoot = resolve('/opt/runtime/skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(patch, /id: deepseek-harness-chrome-product-office-skills/)
  assert.match(patch, new RegExp(`skillsRoot: '${productSkillsRoot}'`))
  assert.match(patch, /product-office-skills\.mjs/)
  assert.ok(patch.indexOf('deepseek-harness-chrome-product-office-skills') < patch.indexOf('deepseek-harness-chrome-claude-skills'))
  const macBuilder = await readFile(new URL('../release/mac-lite/build-mac-production.mjs', import.meta.url), 'utf8')
  assert.match(macBuilder, /DSH_PRODUCT_SKILLS_ROOT="\$PACKAGE_DIR\/skills"/)
  assert.match(macBuilder, /product-office-skills\.mjs/)
  assert.match(macBuilder, /copyWithoutSourceMaps\(path\.join\(PROJECT_ROOT, 'skills'\)/)
})
