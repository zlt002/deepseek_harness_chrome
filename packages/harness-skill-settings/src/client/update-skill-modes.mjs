/** Write one or many Skill modes atomically through the existing settings namespace. */
export async function updateSkillModes(api, namespace, modes, initialRevision) {
  let revision = initialRevision
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await api.settings.update({ ns: namespace, patch: { modes }, expectedRevision: revision })
    if (result.result.ok) return result.result.value
    if (result.result.error.code !== 'settings-conflict' || attempt === 1) throw new Error(result.result.error.message)
    const described = await api.settings.describe({})
    const section = described.result.ok ? described.result.value.namespaces.find(item => item.ns === namespace) : undefined
    if (section === undefined) throw new Error('技能设置在重试时不可用')
    revision = section.revision
  }
}

/** Clear a deleted Skill's stale local disablement and notify the slash-menu cache. */
export async function refreshAfterDeletedSkill(api, namespace, name, revision) {
  return await updateSkillModes(api, namespace, { [name]: 'enabled' }, revision)
}

/** Project one selected subset into the single settings patch for a bulk action. */
export function modesForSelection(skills, selected, mode) {
  const modes = {}
  for (const skill of skills) if (selected.has(skill.name)) modes[skill.name] = mode
  return modes
}
