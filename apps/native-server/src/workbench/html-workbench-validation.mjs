import { validEdits } from './html-workbench.mjs'

function validHtmlWorkbenchPreviewArguments(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && validEdits(value.edits) }
function validHtmlWorkbenchCommitArguments(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256 }
function validHtmlWorkbenchDomFingerprint(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) }
function validHtmlWorkbenchStylesheetFingerprints(value) {
  return Array.isArray(value) && value.length <= 20 && value.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 2 && typeof item.url === 'string' && item.url.startsWith('file:') && /^[a-f0-9]{64}$/i.test(item.fingerprint))
}
function cssPropertyName(name) { return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase()) }
function cssDeclarationMultiset(content) {
  const declarations = new Map()
  for (const block of content.matchAll(/\{([^}]*)\}/g)) {
    for (const declaration of block[1].matchAll(/(?:^|;)\s*([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;{}]+?)\s*(?=;|$)/g)) {
      const property = cssPropertyName(declaration[1])
      const values = declarations.get(property) ?? []
      values.push(declaration[2].replace(/\s+/g, ' ').trim())
      declarations.set(property, values)
    }
  }
  for (const values of declarations.values()) values.sort()
  return declarations
}
function editedComputedProperties(edits, anchorStates) {
  const available = new Set(Array.isArray(anchorStates) ? anchorStates.flatMap(item => item?.computedStyle && typeof item.computedStyle === 'object' ? Object.keys(item.computedStyle) : []) : [])
  const properties = new Set()
  for (const edit of edits) {
    if (!edit.path.toLowerCase().endsWith('.css')) continue
    const before = cssDeclarationMultiset(edit.before)
    const after = cssDeclarationMultiset(edit.content)
    for (const property of new Set([...before.keys(), ...after.keys()])) {
      if (available.has(property) && JSON.stringify(before.get(property) ?? []) !== JSON.stringify(after.get(property) ?? [])) properties.add(property)
    }
  }
  return [...properties].sort()
}
function sameHtmlWorkbenchStylesheetFingerprints(actual, expected) {
  return validHtmlWorkbenchStylesheetFingerprints(actual) && actual.length === expected.length
    && actual.every((item, index) => item.url === expected[index].url && item.fingerprint === expected[index].fingerprint)
}
function validHtmlWorkbenchAnchorStates(value, expectedSelectors, expectedProperties = []) {
  return Array.isArray(value) && value.length === expectedSelectors.length && value.every((item, index) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 2 && item.selector === expectedSelectors[index]
    && item.computedStyle && typeof item.computedStyle === 'object' && !Array.isArray(item.computedStyle)
    && Object.keys(item.computedStyle).length > 0 && Object.values(item.computedStyle).every(field => typeof field === 'string')
    && expectedProperties.every(field => typeof item.computedStyle[field] === 'string'))
}
function sameHtmlWorkbenchAnchorStates(actual, expected, properties) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((item, index) => item.selector === expected[index].selector
    && properties.every(field => item.computedStyle[field] === expected[index].computedStyle[field]))
}
export { validHtmlWorkbenchPreviewArguments, validHtmlWorkbenchCommitArguments, validHtmlWorkbenchDomFingerprint, validHtmlWorkbenchStylesheetFingerprints, editedComputedProperties, sameHtmlWorkbenchStylesheetFingerprints, validHtmlWorkbenchAnchorStates, sameHtmlWorkbenchAnchorStates }
