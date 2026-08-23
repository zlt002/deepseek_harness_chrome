import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = () => readFile(new URL('./sandbox-preview.ts', import.meta.url), 'utf8')

test('isolated preview validates its full bundle before making an opaque-origin, no-network srcdoc', async () => {
  const value = await source()
  assert.match(value, /validatePrototypeBundle\(\{ document, designSpec, evidence: \[\.\.\.evidence\] \}\)/)
  assert.match(value, /default-src 'none'/)
  assert.match(value, /connect-src 'none'/)
  assert.match(value, /script-src 'nonce-\$\{nonce\}'/)
  assert.match(value, /sandbox="allow-scripts"|allow-scripts/)
  assert.match(value, /role','tablist/)
  assert.match(value, /aria-modal/)
  assert.doesNotMatch(value, /chrome\.|new Function|\beval\s*\(/)
})

test('selection bridge requires exact envelope and selection keys, bounded ids, known node types, and nonce', async () => {
  const value = await source()
  assert.match(value, /ownKeys\(value, \['v', 'type', 'schema', 'nonce', 'selection'\]\)/)
  assert.match(value, /ownKeys\(value\.selection, \['elementId', 'type', 'label'\]\)/)
  assert.match(value, /nodeTypes\.has/)
  assert.match(value, /value\.selection\.label\.length <= 2_000/)
  assert.match(value, /value\.nonce !== nonce/)
})
