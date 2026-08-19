/**
 * Product-owned PPT / Excel / Word / PDF skills.
 *
 * These four names are the deployment's primary office catalog. They are
 * discovered from the packaged product skill root and published at rank 1 so
 * project, Claude, and other user-side catalogs cannot replace them.
 *
 * This file is loaded by absolute path from the generated Native Host patch, so
 * it must stay self-contained: a packaged host copies it beside the bundled
 * runtime and must not import sibling Native Server modules.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const name = 'accrui-product-office-skills'
export const inject = ['skills']

/** Stable product-owned office skill names. Order is display-stable. */
export const PRODUCT_OFFICE_SKILL_NAMES = Object.freeze(['docx', 'pdf', 'pptx', 'xlsx'])

/** Lower than every filesystem root so user-side duplicates cannot win. */
export const PRODUCT_OFFICE_SKILL_RANK = 1

export const PRODUCT_OFFICE_SKILL_PROVIDER = 'accrui-product-office'
export const PRODUCT_OFFICE_SKILL_SOURCE = 'accrui-product-office'

/**
 * Parse the YAML frontmatter used by the shipped office SKILL.md files.
 * @param {string} raw
 * @returns {{ name: string, description: string, content: string } | undefined}
 */
export function parseProductOfficeSkillMarkdown(raw) {
  if (!raw.startsWith('---')) return undefined
  const newline = raw.indexOf('\n')
  if (newline < 0) return undefined
  const closing = raw.indexOf('\n---', newline + 1)
  if (closing < 0) return undefined
  const yaml = raw.slice(newline + 1, closing).replace(/\r/g, '')
  const bodyStart = raw.indexOf('\n', closing + 1)
  const content = (bodyStart < 0 ? '' : raw.slice(bodyStart + 1)).trim()
  const name = unquoteYamlScalar(matchYamlField(yaml, 'name'))
  const description = unquoteYamlScalar(matchYamlField(yaml, 'description'))
  if (!name || !description) return undefined
  return { name, description, content }
}

/**
 * Load one product office skill from disk.
 * @param {string} skillDir
 * @param {string} expectedName
 * @returns {Promise<{ name: string, description: string, content: string, path: string, directory: string }>}
 */
export async function loadProductOfficeSkill(skillDir, expectedName) {
  const path = join(skillDir, 'SKILL.md')
  const parsed = parseProductOfficeSkillMarkdown(await readFile(path, 'utf8'))
  if (parsed === undefined) throw new Error(`Product office skill is unreadable: ${path}`)
  if (parsed.name !== expectedName) {
    throw new Error(`Product office skill at ${path} declared name "${parsed.name}" instead of "${expectedName}"`)
  }
  return { ...parsed, path, directory: skillDir }
}

/**
 * Register the four product office skills so user-side catalogs cannot replace them.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ skillsRoot?: string }} [config]
 */
export async function apply(ctx, config = {}) {
  const root = resolveProductOfficeSkillsRoot(config)
  const skills = await loadProductOfficeSkills(root)
  ctx.skills.registerProvider(() => new ProductOfficeSkillProvider(skills))
}

function resolveProductOfficeSkillsRoot(config) {
  const explicit = typeof config.skillsRoot === 'string' ? config.skillsRoot.trim() : ''
  if (!explicit) throw new Error('Product office skills require config.skillsRoot')
  return resolve(explicit)
}

async function loadProductOfficeSkills(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    throw new Error(`Product office skill root is missing: ${root}`, { cause: error })
  }
  const present = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  const missing = PRODUCT_OFFICE_SKILL_NAMES.filter((skillName) => !present.has(skillName))
  if (missing.length > 0) {
    throw new Error(`Product office skills are missing from ${root}: ${missing.join(', ')}`)
  }
  const loaded = {}
  for (const skillName of PRODUCT_OFFICE_SKILL_NAMES) {
    loaded[skillName] = await loadProductOfficeSkill(join(root, skillName), skillName)
  }
  return loaded
}

class ProductOfficeSkillProvider {
  constructor(skills) {
    this.name = PRODUCT_OFFICE_SKILL_PROVIDER
    this.skills = skills
  }

  list() {
    return PRODUCT_OFFICE_SKILL_NAMES.map((skillName) => candidateFromLoaded(this.skills[skillName]))
  }

  async get(candidate) {
    const loaded = this.skills[candidate.name]
    if (loaded === undefined) return undefined
    const current = await loadProductOfficeSkill(loaded.directory, loaded.name)
    return definitionFromLoaded(current)
  }
}

function candidateFromLoaded(loaded) {
  return {
    ...definitionFromLoaded(loaded),
    rank: PRODUCT_OFFICE_SKILL_RANK,
    locator: { path: loaded.path, directory: loaded.directory },
  }
}

function definitionFromLoaded(loaded) {
  return {
    name: loaded.name,
    description: loaded.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: PRODUCT_OFFICE_SKILL_SOURCE,
    provider: PRODUCT_OFFICE_SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: loaded.directory },
    path: loaded.path,
    content: loaded.content,
  }
}

function matchYamlField(yaml, key) {
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(yaml)
  return match?.[1]?.trim()
}

function unquoteYamlScalar(value) {
  if (value === undefined || value.length === 0) return undefined
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  }
  return value
}
