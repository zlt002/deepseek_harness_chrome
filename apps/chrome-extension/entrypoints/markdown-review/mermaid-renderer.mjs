import mermaid from 'mermaid'

let sequence = 0

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  flowchart: { htmlLabels: false },
})

/**
 * Mermaid treats a pasted `\\n` in a label as ordinary text in several
 * diagrams. Remove that display-only escape without touching the Markdown
 * stored by the editor. A space is valid in state names and transition labels;
 * injecting HTML here would also leak into Mermaid's generated state IDs.
 */
export function normalizeMermaidSource(source) {
  return source
    .replace(/\\n/g, ' ')
    // Mermaid 11 rejects the otherwise harmless space between an unquoted
    // node ID and its square-bracket label (`C [label]`). This temporary
    // rendering copy leaves the document's stored Markdown untouched.
    .replace(/\b([A-Za-z_][A-Za-z0-9_-]*)[ \t]+\[/g, '$1[')
}

/** Mermaid puts HTML labels in foreignObject but emits HTML `<br>` tags. */
function repairMermaidForeignObjectMarkup(svg) {
  return svg.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, (foreignObject) => (
    foreignObject.replace(/<br\s*\/?>/gi, '<br />')
  ))
}

function hasUnsafeStyle(value) {
  if (/expression\s*\(|@import|javascript\s*:/i.test(value)) return true
  return [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)]
    .some((match) => !match[2].trim().startsWith('#'))
}

/** Mermaid returns SVG markup; retain only SVG drawing primitives and local references. */
export function sanitizeMermaidSvg(svg) {
  const document = new DOMParser().parseFromString(repairMermaidForeignObjectMarkup(svg), 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || document.querySelector('parsererror') !== null) throw new Error('Mermaid did not return valid SVG')

  // stateDiagram-v2 places state labels in foreignObject elements. Keep those
  // local text containers, while the attribute pass below strips executable and
  // external references from both SVG and XHTML descendants.
  for (const element of document.querySelectorAll('script, iframe, object, embed')) element.remove()
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on') || name === 'src' || ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) || (name === 'style' && hasUnsafeStyle(value))) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return root.outerHTML
}

export async function renderMermaidSvg(source, prefix = 'markdown-review') {
  const id = `${prefix}-${++sequence}`
  const { svg } = await mermaid.render(id, normalizeMermaidSource(source))
  return sanitizeMermaidSvg(svg)
}
