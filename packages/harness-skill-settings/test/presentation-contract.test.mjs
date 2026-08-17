import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Skill settings uses a dense three-state product control instead of a native select', async () => {
  const [section, css] = await Promise.all([
    readFile(new URL('../src/client/section.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/section.module.css', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(section, /<select|<option/)
  assert.match(section, /role="radiogroup"/)
  assert.match(section, /role="radio"/)
  assert.match(section, /aria-checked=/)
  assert.match(section, /'enabled'[\s\S]*'manual-only'[\s\S]*'disabled'/)
  assert.match(section, /className=\{css\.intro\}/)
  assert.match(css, /\.modeControl \{[\s\S]*?grid-template-columns: repeat\(3,/)
  assert.match(css, /\.modeButton\[aria-checked='true'\]/)
  assert.match(css, /\.row \{[\s\S]*?padding: 12px 14px;/)
})
