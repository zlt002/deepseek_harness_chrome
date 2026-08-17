import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Agent preset projection stays out of upstream and uses the public composer dock', async () => {
  const [manifest, source, styles] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/PresetFooter.module.css', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-agent-preset/)
  assert.match(source, /conversation\.composer\.dock/)
  assert.match(source, /agentPresets\.list/)
  assert.match(styles, /background: var\(--dsw-alias-fill-tsp-secondary\)/)
  assert.match(styles, /@media \(max-width: 999px\)/)
  assert.doesNotMatch(source, /upstream\/deepseek-harness/)
})
