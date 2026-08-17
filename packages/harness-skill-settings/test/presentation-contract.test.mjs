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
  assert.match(css, /\.section \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/)
  assert.match(css, /\.intro,[\s\S]*?\.row p,[\s\S]*?\.row span,[\s\S]*?\.status \{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 22px;/)
  assert.match(css, /\.row \{[\s\S]*?display: flex;[\s\S]*?justify-content: space-between;/)
  assert.match(section, /view\.skills\.length === 0/)
  assert.match(section, /t\('empty'\)/)
  assert.match(section, /t\('loadFailed'\)/)
  assert.match(section, /t\('saveFailed'\)/)
  assert.match(section, /t\('retry'\)/)
  assert.match(section, /tabIndex=\{mode === option\.value \? 0 : -1\}/)
  assert.doesNotMatch(section, /css\.skillCopy|css\.restrictions/)
  assert.doesNotMatch(css, /\.section h2 \{|\.skillCopy|\.restrictions/)
  assert.match(css, /\.row div \{ min-width: 0; \}/)
  assert.match(css, /\.row strong \{ font-size: 14px; line-height: 22px; \}/)
  assert.match(css, /\.row span \+ span \{ margin-left: 8px; \}/)
  assert.match(section, /ArrowRight/)
  assert.match(section, /ArrowLeft/)
  assert.match(section, /Home/)
  assert.match(section, /End/)
})
