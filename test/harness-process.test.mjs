import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeSkillsPatch, harnessArgs, resolveHarnessCwd, resolveHarnessCli } from '../native-server/src/harness-process.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('uses an explicit DSH_CWD before the Harness root', () => {
  assert.equal(
    resolveHarnessCwd({ DSH_ROOT: '/opt/deepseek-harness', DSH_CWD: '/tmp/workspace' }),
    '/tmp/workspace',
  )
})

test('uses DSH_ROOT as the default Harness working directory', () => {
  assert.equal(
    resolveHarnessCwd({ DSH_ROOT: '/opt/deepseek-harness' }),
    '/opt/deepseek-harness',
  )
})

test('resolves the CLI from DSH_ROOT when no explicit CLI path is set', () => {
  assert.equal(
    resolveHarnessCli({ DSH_ROOT: '/opt/deepseek-harness' }),
    '/opt/deepseek-harness/apps/cli/lib/bin.js',
  )
})

test('passes the Native Host-owned MCP patch to the official Harness client', () => {
  assert.deepEqual(
    harnessArgs(0, '/private/tmp/connector.cordis.yml'),
    ['--patch', '/private/tmp/connector.cordis.yml', '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
  )
})

test('adds Claude Code skills as a host-level catalog without replacing the preset roots', () => {
  const harnessSkillsDir = resolve(projectRoot, 'skills')
  assert.equal(
    claudeSkillsPatch({ HOME: '/Users/alice' }),
    `- insert:
    - id: deepseek-harness-chrome-claude-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        includeDefaultRoots: false
        customSkillDirs:
          - '/Users/alice/.claude/skills'
          - '${harnessSkillsDir}'
`,
  )
})

test('mounts the Harness-native pmd-prd skill with its template contract', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const template = await readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8')
  const pointer = await readFile(new URL('../skills/pmd-prd/templates.md', import.meta.url), 'utf8')
  assert.match(skill, /name: pmd-prd/)
  assert.match(skill, /pmd_prd_delivery/)
  assert.match(skill, /documents_confirmed/)
  assert.match(skill, /partial_delivery/)
  assert.match(pointer, /references\/templates\.md/)
  assert.match(template, /PRD: \{编号\} - \{主题\}/)
  for (const heading of [
    '# 一、术语与缩写', '# 二、背景与目标', '# 三、整体流程', '# 四、功能性需求',
    '# 五、角色权限', '# 六、非功能性需求', '# 七、配置与开关', '# 八、测试关注点',
    '# 九、参考文档', '## AccrUI 需求交接附录',
  ]) assert.match(template, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('advertises distinct selected-source routes with isolated MCP tools', async () => {
  const source = await readFile(new URL('../native-server/src/harness-process.mjs', import.meta.url), 'utf8')
  assert.match(source, /When a request clearly concerns enterprise code or knowledge, prefer the corresponding selected-source tool/)
  assert.match(source, /If that search reports no selected or enabled range, report that limitation instead of falling back to local files, shell, or git/)
  assert.match(source, /toolScope: global/)
  assert.match(source, /toolName: search_selected_remote_code/)
  assert.match(source, /mcp__chrome__code_search with exactly one non-empty "question" string before answering; never use "query"/)
  assert.match(source, /toolName: search_selected_knowledge/)
  assert.match(source, /mcp__chrome__knowledge_search with exactly one non-empty "question" string before answering; never use "query"/)
  const code = source.slice(source.indexOf('toolName: search_selected_remote_code'), source.indexOf('toolName: search_selected_knowledge'))
  const knowledge = source.slice(source.indexOf('toolName: search_selected_knowledge'))
  assert.match(code, /- mcp__chrome__code_search/)
  assert.doesNotMatch(code, /mcp__chrome__knowledge_search/)
  assert.match(knowledge, /- mcp__chrome__knowledge_search/)
  assert.doesNotMatch(knowledge, /mcp__chrome__code_search/)
})
