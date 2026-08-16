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
  const capabilityMatrix = await readFile(new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url), 'utf8')
  assert.match(skill, /name: pmd-prd/)
  assert.match(skill, /disable-model-invocation: true/)
  assert.match(skill, /pmd_prd_delivery/)
  assert.match(skill, /documents_confirmed/)
  assert.match(skill, /partial_delivery/)
  assert.doesNotMatch(skill, /mcp__chrome__knowledge_search/)
  assert.match(skill, /search_selected_remote_code/)
  assert.match(skill, /search_selected_knowledge/)
  assert.match(skill, /Q<n>/)
  assert.match(skill, /process\.md/)
  assert.match(skill, /domain-model\.md/)
  assert.match(skill, /references\/process-state\.md/)
  assert.match(pointer, /references\/templates\.md/)
  assert.doesNotMatch(capabilityMatrix, /一次 `knowledge_search`/)
  assert.match(capabilityMatrix, /search_selected_remote_code/)
  assert.match(capabilityMatrix, /search_selected_knowledge/)
  assert.match(template, /PRD: \{编号\} - \{主题\}/)
  for (const heading of [
    '# 一、术语与缩写', '# 二、背景与目标', '# 三、整体流程', '# 四、功能性需求',
    '# 五、角色权限', '# 六、非功能性需求', '# 七、配置与开关', '# 八、测试关注点',
    '# 九、参考文档', '## AccrUI 需求交接附录',
  ]) assert.match(template, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const rule of ['必填项无事实时写', '选填项不适用时写', '每个功能至少包含正常场景', 'PRD 只写结论和索引']) assert.match(template, new RegExp(rule))
})

test('declares pmd-prd run binding, isolated scope, persisted state, and stale-confirmation recovery contracts', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const processState = await readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8')

  assert.match(skill, /自动生成内部 `requirementId`/)
  assert.match(skill, /用户只提供业务需求，不填写内部 ID/)
  assert.match(skill, /references\/process-state\.md/)
  assert.match(processState, /本 Run 独立 scope/)
  assert.match(processState, /确认只代表授权，不代表已查询/)
  assert.match(processState, /生成新的内部标识/)
  assert.match(processState, /旧确认在恢复后失效/)
  assert.match(processState, /阶段 4 确认正文快照是唯一交付正文/)
  assert.match(processState, /阶段 5 的父目录确认与线上创建严格分离/)

  for (const artifact of [
    'manifest\\.json',
    'process\\.md',
    'domain-model\\.md',
    'knowledge-sources\\.md',
    'trace-events\\.jsonl',
    'decisions/',
  ]) assert.match(processState, new RegExp(artifact))

  assert.match(processState, /search_selected_remote_code/)
  assert.match(processState, /search_selected_knowledge/)
  for (const content of [skill, processState]) {
    assert.doesNotMatch(content, /mcp__chrome__code_search/)
    assert.doesNotMatch(content, /mcp__chrome__knowledge_search/)
  }
})

test('advertises distinct selected-source routes with isolated MCP tools', async () => {
  const source = await readFile(new URL('../native-server/src/harness-process.mjs', import.meta.url), 'utf8')
  assert.match(source, /When a request clearly concerns enterprise code or knowledge, prefer the corresponding selected-source tool/)
  assert.match(source, /If that search reports no selected or enabled range, report that limitation instead of falling back to local files, shell, or git/)
  assert.match(source, /toolScopes:/)
  assert.match(source, /default: global/)
  assert.match(source, /code_search: continuable-child/)
  assert.match(source, /knowledge_search: continuable-child/)
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
