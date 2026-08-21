import { join, resolve } from 'node:path'

export const PRODUCT_OFFICE_SKILL_SOURCE = 'accrui-product-office'

/** A Host-only classification derived from Registry metadata and product ownership. */
export function skillOrigin(skill, productRoot, installedNames) {
  if (isManagedProductSkill(skill, productRoot, installedNames)) return 'installed'
  if (isProductRootSkill(skill, productRoot) || skill.source === PRODUCT_OFFICE_SKILL_SOURCE || skill.source === 'bundled') return 'system'
  if (skill.source === 'project-dsh' || skill.source === 'project-agents') return 'project'
  return 'user'
}

export function isManagedProductSkill(skill, productRoot, installedNames) {
  return installedNames.has(skill.name) && isProductRootSkill(skill, productRoot)
}

function isProductRootSkill(skill, productRoot) {
  const resourceBase = skill.resourceBase
  return skill.source === 'custom'
    && resourceBase?.kind === 'directory'
    && resolve(resourceBase.path) === join(resolve(productRoot), skill.name)
}

export function installConflictMessage(name, origin) {
  if (origin === 'system' || origin === PRODUCT_OFFICE_SKILL_SOURCE || origin === 'bundled') return `技能 /${name} 与系统内置技能冲突，不能覆盖`
  return `技能 /${name} 与已发现技能冲突，不能覆盖`
}

/** Reject direct settings writes for system Skills while retaining legacy values unchanged. */
export function assertStateModes(modes, systemNames, legacyModes = {}) {
  for (const [name, mode] of Object.entries(modes)) {
    if (systemNames.has(name) && legacyModes[name] !== mode) {
      throw new Error(`系统内置技能 /${name} 不能修改调用状态`)
    }
  }
}

export function statePermissions(origin) { return { stateEditable: origin !== 'system', deletable: origin === 'installed' } }
