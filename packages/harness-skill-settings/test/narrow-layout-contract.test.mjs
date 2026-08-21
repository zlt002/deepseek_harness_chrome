import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('narrow skill rows keep the complete policy control fixed at the right while copy wraps', async () => {
  const css = await readFile(new URL('../src/client/section.module.css', import.meta.url), 'utf8')

  assert.match(css, /\.row > div:first-child \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/)
  assert.match(css, /\.modeControl \{[\s\S]*?flex: 0 0 auto;[\s\S]*?grid-template-columns: repeat\(3, max-content\);/)
  assert.match(css, /\.modeButton \{[\s\S]*?white-space: nowrap;/)
  assert.match(css, /\.modeButton \{[\s\S]*?padding: 4px 6px;/)
  assert.doesNotMatch(css, /@media \(max-width: 640px\) \{[\s\S]*?\.row \{ flex-direction: column;/)
  assert.doesNotMatch(css, /@media \(max-width: 640px\) \{[\s\S]*?\.modeControl \{ width: 100%;/)
})
