import React, { useEffect, useId, useState } from 'react'

type MermaidApi = typeof import('mermaid')['default']
let mermaidPromise: Promise<MermaidApi> | undefined

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
    return mermaid
  })
  return mermaidPromise
}

function isolatedSvgDocument(svg: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><body>${svg}</body>`
}

/** Mermaid output is rendered in a scriptless, CSP-restricted iframe. */
export function MermaidDiagram({ source }: { source: string }): React.JSX.Element {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '-')
  const [svg, setSvg] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(undefined)
    setFailed(false)
    void loadMermaid().then(mermaid => mermaid.render(`markdown-review-${id}`, source))
      .then(({ svg: nextSvg }) => { if (!cancelled) setSvg(nextSvg) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [id, source])

  if (failed) return <pre className="mermaid-fallback" role="note">Mermaid 图表无法安全渲染，已显示源码。<code>{source}</code></pre>
  if (svg === undefined) return <div className="mermaid-loading" aria-live="polite">正在安全渲染 Mermaid 图表…</div>
  return <iframe className="mermaid-diagram" title="Mermaid 图表" sandbox="" srcDoc={isolatedSvgDocument(svg)} />
}
