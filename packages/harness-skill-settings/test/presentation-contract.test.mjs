import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Skill settings keeps card actions in the header and safely exposes bulk and delete actions', async () => {
  const [section, css, enable, update, host, folderUpload] = await Promise.all([
    readFile(new URL('../src/client/section.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/section.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/enable-installed-skill.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/update-skill-modes.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/folder-upload.mjs', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(section, /<select|<option|radiogroup|role="radio"/)
  assert.match(section, /className=\{css\.cardHeader\}/)
  assert.match(section, /className=\{css\.cardActions\}/)
  assert.match(section, /\{t\('enabled'\)\}/)
  assert.match(section, /\{t\('disabled'\)\}/)
  assert.match(section, /\{t\('more'\)\}/)
  assert.match(section, /role="menu"/)
  assert.match(section, /role="menuitem"/)
  assert.match(section, /api\/settings\.skill\.delete/)
  assert.match(section, /refreshAfterDeletedSkill\(api, NS, skill\.name, view\.revision\)/)
  assert.match(section, /文件夹已删除，但菜单刷新失败/)
  assert.match(section, /pointerdown/)
  assert.match(section, /event\.key === 'Escape'/)
  assert.match(section, /\{t\('enableAll'\)\}/)
  assert.match(section, /\{t\('disableAll'\)\}/)
  assert.match(section, /type="checkbox"/)
  assert.match(section, /selectedCount === 0/)
  assert.match(section, /modesForSelection\(view\.skills, selected, mode\)/)
  assert.match(section, /\{t\('manualAll'\)\}/)
  assert.match(section, /setSelected\(new Set\(\)\)/)
  assert.match(section, /updateSkillModes\(api, NS, modes, view\.revision\)/)
  assert.match(update, /patch: \{ modes \}/)
  assert.match(update, /expectedRevision: revision/)
  assert.match(update, /settings-conflict/)
  assert.match(css, /\.cardHeader \{[\s\S]*?display: flex;[\s\S]*?justify-content: space-between;/)
  assert.match(css, /\.cardActions \{[\s\S]*?position: relative;[\s\S]*?flex: 0 0 auto;/)
  assert.match(css, /\.moreMenu \{[\s\S]*?position: absolute;/)
  assert.match(css, /\.moreMenu \.deleteButton \{ color: var\(--dsw-alias-label-danger\); \}/)
  assert.match(css, /\.secondaryButton \{[\s\S]*?height: 28px;[\s\S]*?border-radius: 14px;/)
  assert.match(css, /\.toolbar \{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; \}/)
  assert.match(css, /\.skillTitle \{[\s\S]*?display: flex;[\s\S]*?min-width: 0;/)
  assert.match(css, /\.selectionControl input \{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/)
  assert.match(section, /className=\{css\.intro\}/)
  assert.match(section, /api\/settings\.skill\.install/)
  assert.match(section, /getAsFileSystemHandle/)
  assert.doesNotMatch(section, /showDirectoryPicker/)
  assert.match(section, /webkitdirectory/)
  assert.match(folderUpload, /webkitRelativePath/)
  assert.match(enable, /expectedRevision: revision/)
  assert.match(enable, /settings-conflict/)
  assert.match(host, /path: '\/api\/settings\.skill\.delete'/)
  assert.match(host, /deleteInstalledSkill[\s\S]*?invalidateInvocationPolicy\(\)[\s\S]*?waitForRemovedSkill/)
  assert.match(host, /它可能来自其他来源/)
  assert.match(host, /技能删除仅允许本机同源请求/)
})
