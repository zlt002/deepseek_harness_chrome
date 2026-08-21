import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('origin filtering limits the visible bulk target and clears selection when it changes', async () => {
  const [section, locale] = await Promise.all([
    readFile(new URL('../src/client/section.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(section, /type OriginFilter = 'all' \| Origin/)
  assert.match(section, /useState<OriginFilter>\('all'\)/)
  assert.match(section, /const visibleSkills = originFilter === 'all' \? view\.skills : view\.skills\.filter\(skill => skill\.origin === originFilter\)/)
  assert.match(section, /visibleSkills\.filter\(skill => skill\.stateEditable && selected\.has\(skill\.name\)\)/)
  assert.match(section, /modesForSelection\(visibleSkills, selected, mode\)/)
  assert.match(section, /const changeOriginFilter = \(value: string\): void => \{[\s\S]*?setOriginFilter\(value\)[\s\S]*?setSelected\(new Set\(\)\)/)
  assert.match(section, /setOriginMenuOpen\(false\)/)
  assert.match(section, /menuOpen === undefined && !originMenuOpen/)
  assert.match(section, /closest\('\[data-skill-menu\], \[data-origin-filter-menu\]'\)/)
  assert.match(section, /event\.key === 'Escape'[\s\S]*?setMenuOpen\(undefined\); setOriginMenuOpen\(false\)/)
  assert.match(section, /setMenuOpen\(undefined\); setOriginMenuOpen\(open => !open\)/)
  assert.match(section, /setOriginMenuOpen\(false\); setMenuOpen\(open => open === skill\.name/)
  assert.doesNotMatch(section, /<select|<option/)
  assert.match(section, /aria-haspopup="listbox"/)
  assert.match(section, /role="listbox"/)
  assert.match(section, /role="option" aria-selected=/)
  assert.match(section, /t\(view\.skills\.length === 0 \? 'empty' : 'emptyFiltered'\)/)
  assert.match(locale, /emptyFiltered: '此来源下没有技能。'/)
  assert.match(locale, /allSkills: '全部技能'/)
  assert.match(locale, /enableAll: '启用', disableAll: '停用', manualAll: '仅手动'/)
  assert.doesNotMatch(locale, /enableAll: '批量|disableAll: '批量|manualAll: '批量/)
})
