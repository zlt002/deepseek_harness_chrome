import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('origin filter keeps its chevron at the trigger edge', async () => {
  const [section, css] = await Promise.all([
    readFile(new URL('../src/client/section.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/section.module.css', import.meta.url), 'utf8'),
  ])

  assert.match(section, /className=\{css\.originFilterLabel\}/)
  assert.match(section, /className=\{css\.originFilterChevron\}/)

  const triggerRules = css.match(/\.originFilterTrigger\s*\{([^}]*)\}/)
  assert.ok(triggerRules, 'origin filter trigger styles must exist')
  assert.match(triggerRules[1], /justify-content:\s*space-between;/)

  const chevronRules = css.match(/\.originFilterChevron\s*\{([^}]*)\}/)
  assert.ok(chevronRules, 'origin filter chevron styles must exist')
  assert.match(chevronRules[1], /margin-left:\s*auto;/)
})
