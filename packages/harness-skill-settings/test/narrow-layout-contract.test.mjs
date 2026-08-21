import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('narrow skill cards keep their compact header actions on the right while copy wraps', async () => {
  const css = await readFile(new URL('../src/client/section.module.css', import.meta.url), 'utf8')

  assert.match(css, /\.skillCopy \{ min-width: 0; overflow-wrap: anywhere; \}/)
  assert.match(css, /\.cardHeader \{[\s\S]*?display: flex;[\s\S]*?min-width: 0;/)
  assert.match(css, /\.cardActions \{[\s\S]*?flex: 0 0 auto;[\s\S]*?gap: 6px;/)
  assert.match(css, /\.secondaryButton \{[\s\S]*?height: 28px;[\s\S]*?padding: 0 10px;/)
  assert.match(css, /\.toolbar \{ display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; \}/)
})
