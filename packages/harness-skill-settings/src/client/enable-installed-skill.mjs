/** Persist the safe default after Host discovery and retry one stale Settings revision. */
export async function enableInstalledSkill(api, namespace, name, initialRevision) {
  let revision = initialRevision
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await api.settings.update({ ns: namespace, patch: { modes: { [name]: 'enabled' } }, expectedRevision: revision })
    if (result.result.ok) return
    if (result.result.error.code !== 'settings-conflict' || attempt === 1) throw new Error(result.result.error.message)
    const described = await api.settings.describe({})
    const section = described.result.ok ? described.result.value.namespaces.find(item => item.ns === namespace) : undefined
    if (section === undefined) throw new Error('技能设置在重试时不可用')
    revision = section.revision
  }
}
