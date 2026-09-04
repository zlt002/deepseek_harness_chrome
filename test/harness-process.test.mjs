import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessWebProcess, claudeSkillsPatch, defaultWorkspacePatch, effectiveSessionTrackingPatch, harnessArgs, loaderModuleSpecifier, prepareProductUiPackages, productUiPatch, PRODUCT_OFFICE_SKILL_NAMES, resolveDefaultWorkspacePlugin, resolveHarnessCwd, resolveHarnessCli, resolveHarnessRuntimePlugin, resolveHarnessTrackingPlugin, resolvePermissionMode, resolveProductOfficeSkillsPlugin, resolveProductSkillsRoot, resolveUserHome, withProductNodeOnPath } from '../apps/native-server/src/harness-process.mjs'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { Context } from '../.generated/harness-product/vendor/cordis/lib/index.js'
import { entryListSchema } from '../.generated/harness-product/vendor/include/lib/index.js'
import SystemPrompt, { renderPrompt } from '../.generated/harness-product/packages/core/system-prompt/lib/index.js'
import { createScope } from '../.generated/harness-product/packages/core/scope/lib/index.js'
import * as Persona from '../.generated/harness-product/packages/preset/persona/lib/index.js'
import * as SelectedSourceRoutingPrompt from '../apps/native-server/src/selected-source-routing-prompt.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('uses an explicit DSH_CWD before the Harness root', () => {
  const harnessRoot = '/opt/deepseek-harness'
  const workspace = '/tmp/workspace'
  assert.equal(
    resolveHarnessCwd({ DSH_ROOT: harnessRoot, DSH_CWD: workspace }),
    resolve(workspace),
  )
})

test('uses DSH_ROOT as the default Harness working directory', () => {
  const harnessRoot = '/opt/deepseek-harness'
  assert.equal(
    resolveHarnessCwd({ DSH_ROOT: harnessRoot }),
    resolve(harnessRoot),
  )
})

test('puts the Native Host Node runtime first while preserving an existing PATH', () => {
  assert.deepEqual(
    withProductNodeOnPath({ PATH: '/usr/bin:/opt/tools', KEEP: 'value' }, '/product/runtime/bin/node', 'linux'),
    { PATH: '/product/runtime/bin:/usr/bin:/opt/tools', KEEP: 'value' },
  )
})

test('creates a PATH from the Native Host Node runtime when Chrome supplies none', () => {
  assert.deepEqual(
    withProductNodeOnPath({ KEEP: 'value' }, '/product/runtime/bin/node', 'linux'),
    { KEEP: 'value', PATH: '/product/runtime/bin' },
  )
})

test('defaults fresh Harness launches to full access while preserving explicit permission mode', () => {
  assert.equal(resolvePermissionMode({}), 'danger-full-access')
  assert.equal(resolvePermissionMode({ DSH_PERMISSION_MODE: 'workspace-write' }), 'workspace-write')
})

test('keeps one product Node directory and normalizes Windows Path casing', () => {
  assert.deepEqual(
    withProductNodeOnPath(
      { Path: 'C:\\Windows\\System32;C:\\PRODUCT\\Runtime\\Bin;C:\\Tools', PATH: 'ignored-on-windows', KEEP: 'value' },
      'C:\\Product\\Runtime\\Bin\\node.exe',
      'win32',
    ),
    { Path: 'C:\\Product\\Runtime\\Bin;C:\\Windows\\System32;C:\\Tools', KEEP: 'value' },
  )
})

test('spawns Harness with its Node runtime available despite Chrome-like PATH', {
  // Windows PATH semantics are covered by the helper contract above. A Node
  // child hosting an HTTP server cannot be terminated portably from this test
  // on GitHub's Windows runner and would keep the whole test process alive.
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'harness-node-path-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cliPath = join(root, 'fake-harness-cli.mjs')
  const resultPath = join(root, 'bash-result.json')
  await writeFile(cliPath, `
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' })
writeFileSync(process.env.PATH_RESULT_PATH, JSON.stringify({ path: process.env.PATH, status: node.status, stdout: node.stdout, stderr: node.stderr }))
const server = createServer((_request, response) => response.end('ok'))
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log(\`dsh web: http://127.0.0.1:\${address.port}\`)
})
process.once('SIGTERM', () => server.close(() => process.exit(0)))
`)
  const harness = new HarnessWebProcess({
    cliPath,
    cwd: root,
    env: { DSH_HOME: join(root, 'dsh-home'), PATH: '/bin', PATH_RESULT_PATH: resultPath },
  })
  t.after(() => harness.stop())
  await harness.start()
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.equal(result.status, 0)
  assert.equal(resolve(result.stdout.trim()), resolve(process.execPath))
  assert.equal(result.path.split(process.platform === 'win32' ? ';' : ':')[0], dirname(process.execPath))
})

test('resolves the CLI from DSH_ROOT when no explicit CLI path is set', () => {
  const harnessRoot = '/opt/deepseek-harness'
  assert.equal(
    resolveHarnessCli({ DSH_ROOT: harnessRoot }),
    join(resolve(harnessRoot), 'apps', 'cli', 'lib', 'bin.js'),
  )
})

test('resolves an explicit DSH_CLI_PATH without consulting the product tree', () => {
  const cliPath = '/opt/custom-dsh.mjs'
  assert.equal(resolveHarnessCli({ DSH_CLI_PATH: cliPath }), resolve(cliPath))
})

test('defaults to the generated product Harness CLI', () => {
  assert.equal(
    resolveHarnessCli({}),
    resolve(projectRoot, '.generated/harness-product/apps/cli/lib/bin.js'),
  )
})

test('resolves the product-owned Harness runtime plugin outside the upstream checkout', () => {
  assert.equal(
    resolveHarnessRuntimePlugin({}),
    resolve(projectRoot, 'packages/harness-runtime/src/index.mjs'),
  )
})

test('resolves the product-owned AccrUI tracking plugin outside the upstream checkout', () => {
  assert.equal(
    resolveHarnessTrackingPlugin({}),
    resolve(projectRoot, 'packages/harness-tracking/src/index.mjs'),
  )
  assert.equal(
    resolveDefaultWorkspacePlugin({}),
    resolve(projectRoot, 'packages/harness-default-workspace/src/index.mjs'),
  )
})

test('mounts AccrUI effective-session tracking on every Harness Web launch', () => {
  const patch = effectiveSessionTrackingPatch({})
  assert.match(patch, /id: deepseek-harness-effective-session-tracking/)
  assert.match(patch, /name: 'file:\/\/.+packages\/harness-tracking\/src\/index\.mjs'/)
  assert.match(defaultWorkspacePatch({}), /name: 'file:\/\/.+packages\/harness-default-workspace\/src\/index\.mjs'/)
})

test('converts Windows absolute loader paths to valid file URLs', () => {
  assert.equal(
    loaderModuleSpecifier('C:\\Harness Runtime\\harness-tracking.mjs', 'win32'),
    'file:///C:/Harness%20Runtime/harness-tracking.mjs',
  )
})

test('passes the Native Host-owned MCP patch to the official Harness client', () => {
  assert.deepEqual(
    harnessArgs(0, '/private/tmp/connector.cordis.yml'),
    ['--patch', '/private/tmp/connector.cordis.yml', '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
  )
})

test('mounts Harness-native skills before Claude skills so duplicate names resolve to this project', () => {
  const harnessSkillsDir = resolve(projectRoot, 'skills')
  const officePlugin = resolve(projectRoot, 'apps/native-server/src/product-office-skills.mjs')
  const deployedSkillsDir = resolve('/opt/runtime/skills')
  assert.equal(resolveProductSkillsRoot({}), harnessSkillsDir)
  assert.equal(resolveProductSkillsRoot({ DSH_PRODUCT_SKILLS_ROOT: '/opt/runtime/skills' }), deployedSkillsDir)
  assert.equal(resolveProductOfficeSkillsPlugin({}), officePlugin)
  assert.deepEqual([...PRODUCT_OFFICE_SKILL_NAMES], ['docx', 'pdf', 'pptx', 'xlsx'])
  assert.equal(resolveUserHome({ USERPROFILE: 'C:\\Users\\alice' }), 'C:\\Users\\alice')
  const patch = claudeSkillsPatch({ HOME: '/Users/alice' })
  const patchEntries = yaml.load(patch)[0].insert
  assert.match(patch, /id: deepseek-harness-chrome-product-office-skills/)
  const officeLoader = patchEntries.find((entry) => entry.id === 'deepseek-harness-chrome-product-office-skills')
  assert.equal(officeLoader.name, loaderModuleSpecifier(officePlugin))
  assert.match(patch, /skillsRoot: '.*skills'/)
  assert.match(patch, /id: deepseek-harness-chrome-claude-skills/)
  assert.match(patch, /includeDefaultRoots: false/)
  const claudeLoader = patchEntries.find((entry) => entry.id === 'deepseek-harness-chrome-claude-skills')
  assert.deepEqual(claudeLoader.config.customSkillDirs, [harnessSkillsDir, resolve('/Users/alice/.claude/skills')])
  assert.ok(patch.indexOf('deepseek-harness-chrome-product-office-skills') < patch.indexOf('deepseek-harness-chrome-claude-skills'))
  assert.match(
    claudeSkillsPatch({ USERPROFILE: 'C:\\Users\\alice', DSH_PRODUCT_SKILLS_ROOT: 'C:\\AccrUI\\runtime\\skills' }),
    /C:\\AccrUI\\runtime\\skills/,
  )
  assert.match(
    claudeSkillsPatch({ USERPROFILE: 'C:\\Users\\alice', DSH_PRODUCT_SKILLS_ROOT: 'C:\\AccrUI\\runtime\\skills' }),
    /C:\\Users\\alice[/\\]\.claude[/\\]skills/,
  )
})

test('mounts every product UI package outside upstream by default', () => {
  assert.match(productUiPatch({}), /@accrui\/harness-ui-browser-target/)
  assert.equal(productUiPatch({}).match(/@accrui\/harness-ui-conversation-shell/g)?.length, 1)
  assert.equal(productUiPatch({}).match(/@accrui\/harness-ui-message-annotations/g)?.length, 1)
  assert.equal(productUiPatch({}).match(/@accrui\/harness-ui-responsive-sidebar/g)?.length, 1)
  assert.match(productUiPatch({}), /@accrui\/harness-ui-subagent-compact/)
  assert.match(productUiPatch({}), /@accrui\/harness-ui-session-log-copy/)
  assert.equal(productUiPatch({}).match(/@accrui\/harness-ui-knowledge-scope/g)?.length, 1)
  const patch = productUiPatch({})
  assert.equal(patch.match(/@accrui\/harness-ui-agent-preset/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-browser-target/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-conversation-shell/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-message-annotations/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-responsive-sidebar/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-subagent-compact/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-session-log-copy/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-settings-shell/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-knowledge-scope/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-document-intake/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-ui-workspace-review/g)?.length, 1)
  assert.equal(patch.match(/@accrui\/harness-skill-settings/g)?.length, 1)
})

test('installs a managed product UI link into an isolated Harness profile', async (t) => {
  const dshHome = await mkdtemp(resolve(tmpdir(), 'harness-product-ui-test-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  await prepareProductUiPackages({ DSH_HOME: dshHome })
  const link = resolve(dshHome, 'profiles/web/node_modules/@accrui/harness-ui-browser-target')
  assert.equal(
    resolve(dirname(link), await readlink(link)),
    resolve(projectRoot, 'packages/harness-ui-browser-target'),
  )
  const annotationsLink = resolve(dshHome, 'profiles/web/node_modules/@accrui/harness-ui-message-annotations')
  assert.equal(
    resolve(dirname(annotationsLink), await readlink(annotationsLink)),
    resolve(projectRoot, 'packages/harness-ui-message-annotations'),
  )
})

test('migrates a managed product UI symlink when the installed package root changes', async (t) => {
  const dshHome = await mkdtemp(resolve(tmpdir(), 'harness-product-ui-migrate-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const link = resolve(dshHome, 'profiles/web/node_modules/@accrui/harness-ui-agent-preset')
  await mkdir(dirname(link), { recursive: true })
  await symlink('/tmp/old-harness-ui-agent-preset', link, process.platform === 'win32' ? 'junction' : 'dir')

  await prepareProductUiPackages({ DSH_HOME: dshHome })

  assert.equal(
    resolve(dirname(link), await readlink(link)),
    resolve(projectRoot, 'packages/harness-ui-agent-preset'),
  )
})

test('backs up a legacy materialized product UI package before linking the current package', async (t) => {
  const dshHome = await mkdtemp(resolve(tmpdir(), 'harness-product-ui-legacy-package-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const link = resolve(dshHome, 'profiles/web/node_modules/@accrui/harness-ui-agent-preset')
  await mkdir(link, { recursive: true })
  await writeFile(resolve(link, 'package.json'), '{"name":"@accrui/harness-ui-agent-preset"}')
  await writeFile(resolve(link, 'legacy-state.txt'), 'preserve-me')

  await prepareProductUiPackages({ DSH_HOME: dshHome })
  await prepareProductUiPackages({ DSH_HOME: dshHome })

  assert.equal(
    resolve(dirname(link), await readlink(link)),
    resolve(projectRoot, 'packages/harness-ui-agent-preset'),
  )
  const backupNames = (await readdir(dirname(link))).filter((name) => name.startsWith('harness-ui-agent-preset.accrui-product-plugin-backup'))
  assert.deepEqual(backupNames, ['harness-ui-agent-preset.accrui-product-plugin-backup'])
  assert.equal(await readFile(resolve(dirname(link), backupNames[0], 'legacy-state.txt'), 'utf8'), 'preserve-me')
})

test('refuses to replace an unmanaged non-product package directory', async (t) => {
  const dshHome = await mkdtemp(resolve(tmpdir(), 'harness-product-ui-unmanaged-package-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const link = resolve(dshHome, 'profiles/web/node_modules/@accrui/harness-ui-agent-preset')
  await mkdir(link, { recursive: true })
  await writeFile(resolve(link, 'package.json'), '{"name":"unmanaged-user-package"}')

  await assert.rejects(
    prepareProductUiPackages({ DSH_HOME: dshHome }),
    new RegExp(`Refusing to replace unmanaged Harness plugin path: ${link.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`),
  )
  assert.equal(JSON.parse(await readFile(resolve(link, 'package.json'), 'utf8')).name, 'unmanaged-user-package')
})

test('mounts the focused pmd-prd workflow and its single template authority', async () => {
  const [skill, template] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8'),
  ])
  assert.match(skill, /name: pmd-prd/)
  assert.match(skill, /disable-model-invocation: true/)
  assert.doesNotMatch(skill, /## 写作要求/)
  assert.match(skill, /生成 PRD 前，完整读取 \[`references\/templates\.md`\]\(references\/templates\.md\)/)
  assert.doesNotMatch(skill, /references\/authoring\.md/)
  assert.match(template, /## 写作要求/)
  assert.match(template, /PRD: \{业务需求编号\} - \{业务需求名称\}/)
  for (const heading of ['# 二、背景与目标', '# 四、功能性需求', '# 五、角色权限', '# 八、测试关注点', '# 九、参考文档']) assert.match(template, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(template, /最终 PRD 删除填写注释，不保留占位符、空章节、空表或无依据数字/)
  assert.doesNotMatch(skill + template, /capability-matrix|process-state/)
})

test('keeps pmd-prd query, review, and online write guidance in the skill', async () => {
  const [skill, source, connector] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../apps/native-server/src/harness-process.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8'),
  ])
  for (const artifact of ['pmd-workspace/spec', '内部编号', 'issue-review-receipt\\.mjs']) assert.match(skill, new RegExp(artifact))
  assert.match(skill, /mcp__chrome__selected_source_scope/)
  assert.match(skill, /search_selected_remote_code/)
  assert.match(skill, /search_selected_knowledge/)
  assert.match(skill, /knowledgeSelected为 false，且codeSelected 为 true时[\s\S]*search_selected_remote_code/)
  assert.match(skill, /knowledgeSelected 为 true时 .*search_selected_knowledge/)
  assert.match(skill, /open_workspace_markdown_review/)
  assert.match(skill, /light_document_read[\s\S]*light_document_write_preview[\s\S]*light_document_write_commit[\s\S]*light_document_read/)
  assert.match(source, /toolName: search_selected_remote_code[\s\S]*backgroundMode: continuable/)
  assert.match(source, /toolName: search_selected_knowledge[\s\S]*backgroundMode: continuable/)
  for (const relativePath of ['../../../skills/pmd-prd', '../../skills/pmd-prd', '../skills/pmd-prd']) assert.match(connector, new RegExp(relativePath.replace(/[./]/g, '\\$&')))
})

test('keeps product questions in the skill and writing rules in the template authority', async () => {
  const [skill, template] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8'),
  ])
  assert.match(template, /模板标为必填的项必须取得真实信息并填写/)
  assert.match(template, /信息不足时先向用户澄清，不能用“无”代替/)
  assert.match(template, /只有确认不涉及的项才写“无”或“不涉及”/)
  assert.match(template, /需求基本信息只有选填字段未知时可以留空/)
  assert.match(skill, /分别上线、排期或验收/)
  assert.match(skill, /frontier\*\* = 前置已解决、现在就能问的决策/)
  assert.match(skill, /每轮问完整个 frontier：每个问题编号/)
  assert.match(skill, /每问格式：`❓ \*\*Q1\*\*/)
  assert.match(template, /不决定类名、接口或数据库实现/)
  assert.match(skill, /用户回答后重算下一轮 frontier/)
  assert.match(skill, /第四章「功能性需求」，必须写清修改或删除项改造前后对比及影响/)
  assert.match(skill, /研发定位必须经代码查询确认/)
  assert.match(skill, /验收清单逐个呼应第四章改动点，并写清验证操作和预期结果/)
  assert.match(template, /\| 对应需求点 \| 验证操作 \| 预期结果 \|/)
})

test('advertises distinct selected-source routes with isolated MCP tools', async () => {
  const source = await readFile(new URL('../apps/native-server/src/harness-process.mjs', import.meta.url), 'utf8')
  assert.match(source, /deepseek-harness-selected-source-routing/)
  assert.match(source, /selected-source-routing-prompt\.mjs/)
  assert.match(source, /toolScopes:/)
  assert.match(source, /default: global/)
  // The foreground wrapper route runs a one-shot child that never receives
  // continuable-setup contributions, so the search tools must ride the global
  // layer for that child to see them.
  assert.match(source, /code_search: global/)
  assert.match(source, /knowledge_search: global/)
  assert.doesNotMatch(source, /code_search: continuable-child/)
  assert.doesNotMatch(source, /knowledge_search: continuable-child/)
  assert.match(source, /toolName: search_selected_remote_code/)
  assert.match(source, /MCP "question" must equal the delegated wrapper prompt character-for-character/)
  assert.match(source, /toolName: search_selected_knowledge/)
  assert.match(source, /MCP "question" must equal the delegated wrapper prompt character-for-character/)
  const code = source.slice(source.indexOf('toolName: search_selected_remote_code'), source.indexOf('toolName: search_selected_knowledge'))
  const knowledge = source.slice(source.indexOf('toolName: search_selected_knowledge'))
  assert.match(code, /enableRunInBackground: false/)
  assert.match(knowledge, /enableRunInBackground: false/)
  assert.match(code, /allow: \['mcp__chrome__code_search'\]/)
  assert.match(code, /Preserve the end user's language in the MCP question/)
  assert.match(code, /when the user writes Chinese, user-visible narration must be Simplified Chinese/)
  assert.match(code, /first action must be exactly one[\s\S]*mcp__chrome__code_search call/)
  assert.match(code, /Do not rewrite, expand, translate, summarize, or add instructions or context to it/)
  assert.doesNotMatch(code, /keep that question to one file, one function, or one short topic/)
  assert.match(code, /never use "query", repeat the search, or split one delegation into exploratory searches/)
  assert.match(code, /successful MCP result[\s\S]*top-level answer string[\s\S]*character-for-character/)
  assert.match(code, /Do not summarize, rewrite, condense, or add commentary/)
  assert.match(code, /For a tool error[\s\S]*report the specific error verbatim[\s\S]*do not fabricate an answer/)
  assert.match(code, /only the top-level answer string/)
  assert.match(code, /character-for-character[\s\S]*Markdown[\s\S]*citations[\s\S]*line breaks[\s\S]*whitespace/)
  assert.match(code, /Do not translate/)
  assert.match(code, /nothing before or after/)
  assert.match(code, /overrides earlier language\/style and multi-file instructions/)
  assert.doesNotMatch(code, /Then answer from that one result/)
  assert.doesNotMatch(code, /mcp__chrome__knowledge_search/)
  assert.match(knowledge, /allow: \['mcp__chrome__knowledge_search'\]/)
  assert.match(knowledge, /MCP "question" must equal the delegated wrapper prompt character-for-character/)
  assert.match(knowledge, /Do not rewrite, expand, translate, summarize, or add instructions or context to it/)
  assert.doesNotMatch(knowledge, /keep that question to one document, one rule, or one short topic/)
  assert.match(knowledge, /successful MCP result[\s\S]*top-level answer string[\s\S]*character-for-character/)
  assert.match(knowledge, /Do not summarize, rewrite, condense, or add commentary/)
  assert.match(knowledge, /For a tool error[\s\S]*report the specific error verbatim[\s\S]*do not fabricate an answer/)
  assert.match(knowledge, /only the top-level answer string/)
  assert.match(knowledge, /character-for-character[\s\S]*Markdown[\s\S]*citations[\s\S]*line breaks[\s\S]*whitespace/)
  assert.match(knowledge, /Do not translate/)
  assert.match(knowledge, /nothing before or after/)
  assert.match(knowledge, /overrides earlier language\/style and multi-file instructions/)
  assert.doesNotMatch(knowledge, /Then answer from that one result/)
  assert.doesNotMatch(knowledge, /mcp__chrome__code_search/)
})

test('keeps selected-source routing in the final Code preset system prompt', async () => {
  const codePresetPath = resolve(projectRoot, 'upstream/deepseek-harness/apps/cli/config/agent-presets/code/agent.cordis.yml')
  const entries = yaml.load(await readFile(codePresetPath, 'utf8'), { schema: entryListSchema })
  assert.ok(Array.isArray(entries))
  const codePersona = entries.find((entry) => entry?.id === 'persona')
  assert.equal(codePersona?.name, '@deepseek-ai/dsh-persona')
  assert.equal(typeof codePersona?.config?.text, 'string')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'deployment persona that Code shadows' })
  ctx.systemPrompt.variable('model', () => 'test-model')
  ctx.systemPrompt.variable('cwd', () => '/workspace')
  const codeScope = { agent: 'code-preset' }
  await createScope(ctx, codeScope).ctx.plugin(Persona, codePersona.config)
  await ctx.plugin(SelectedSourceRoutingPrompt)

  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: codeScope }))
  assert.match(prompt, /You are a coding agent powered by the test-model model/)
  assert.doesNotMatch(prompt, /deployment persona that Code shadows/)
  assert.match(prompt, /你是 Harness Browser Workspace，一个面向企业用户的浏览器 AI 工作助手/)
  assert.match(prompt, /包括会话过程、进度说明和最终结果，都使用通俗、简洁、直接的表达/)
  assert.match(prompt, /让非开发用户能快速理解并做出决策/)
  assert.match(prompt, /浏览器操作必须绑定明确的 Browser Target/)
  assert.match(prompt, /先展示预览并获得授权；执行后从同一目标回读验证/)
  assert.match(prompt, /只有结果真实产生并验证后，才能报告成功/)
  assert.match(prompt, /多项任务部分成功时，保留已完成结果/)
  assert.match(prompt, /用户只需要解释或建议时，不擅自执行修改/)
  assert.match(prompt, /search_selected_remote_code/)
  assert.match(prompt, /search_selected_knowledge/)
  assert.match(prompt, /searching them is the default path for answering questions/)
  assert.match(prompt, /The selection itself is the instruction/)
  assert.match(prompt, /When the end user's message is Chinese, write every user-visible message from the parent in Simplified Chinese/)
  assert.match(prompt, /For an explicit \/pmd-prd invocation with business text or user-provided attachments, first reorganize the input around the user's own reasoning and emphasis/)
  assert.match(prompt, /Adapt the headings and depth to the actual content/)
  assert.match(prompt, /Do not force a fixed field list or add empty placeholder fields/)
  assert.match(prompt, /Before explicit confirmation, do not call mcp__chrome__selected_source_scope or either selected-source wrapper/)
  assert.match(prompt, /Only after confirmation may you create a source-oriented prompt and start Step2/)
  assert.match(prompt, /Selected-source progress is verified progress/)
  assert.match(prompt, /only after the matching wrapper call has successfully published its child/)
  assert.match(prompt, /This rule is the authoritative refinement of the initial-search wording above/)
  assert.match(prompt, /selected-source dispatch is allowed only after the assistant has shown the adaptive structured requirement understanding and the user has explicitly confirmed it/)
  assert.match(prompt, /before confirmation, show and confirm the structured understanding instead/)
  assert.match(prompt, /the internal first-search wrapper prompt must explicitly include all five runtime-required dimensions/)
  assert.match(prompt, /Unknown dimensions must be requests for source verification, not invented facts/)
  assert.match(prompt, /translate source evidence into concise non-technical product questions/)
  assert.match(prompt, /translate them back into a focused technical prompt and perform a later routed source search/)
  assert.match(prompt, /For every non-\/pmd-prd direct query, the wrapper prompt must equal the most recent user message character-for-character/)
  assert.match(prompt, /For a process follow-up search that the parent initiates to close an independent evidence gap/)
  assert.match(prompt, /only from facts explicitly provided by the user in the current conversation, the selected-source scope echo, and existing search results or citations/)
  assert.match(prompt, /Never introduce model knowledge, guesses, or business or code details absent from that evidence/)
  assert.match(prompt, /If that evidence is insufficient to compose a reliable follow-up, use the most relevant original user message unchanged and add nothing/)
  assert.match(prompt, /The wrapper description may be a short label/)
  assert.doesNotMatch(prompt, /Keep each selected-source wrapper prompt to one file, one function, or one short topic/)
  assert.match(prompt, /Never launch selected-source wrappers in parallel or queue another while the prior wrapper is still running/)
  assert.match(prompt, /the same parent turn may start a focused follow-up only for a concrete independent evidence gap/)
  assert.match(prompt, /hard limit of three selected-source wrappers/)
  assert.match(prompt, /current working directory is a session workspace for generated documents and process files, not the product codebase/)
  assert.match(prompt, /empty or docs-only cwd is expected/)
  assert.match(prompt, /never ask where the code is after seeing an empty listing/)
  assert.match(prompt, /must not wait for a matching subject keyword/)
  assert.match(prompt, /what the selected repositories contain/)
  assert.match(prompt, /directory tree, README, package manifest, build configuration, or architecture is a remote-code question/)
  assert.match(prompt, /Broad repository overviews still go through the matching selected-source wrapper with the original user message/)
  assert.match(prompt, /Never answer a question about the selection by listing local workspace files/)
  assert.match(prompt, /first tool call must be the matching selected-source wrapper/)
  assert.match(prompt, /For \/pmd-prd, this first-tool rule applies only after the structured requirement understanding has been shown to and explicitly confirmed by the user/)
  assert.match(prompt, /For \/pmd-prd, the structured understanding and ask_user_question confirmation are the only allowed preceding steps/)
  assert.match(prompt, /except mcp__chrome__selected_source_scope when you only need to confirm the current names/)
  assert.match(prompt, /Never delegate through generic subagent or subagent_fork/)
  assert.match(prompt, /does not receive or observe the live composer-strip labels/)
  assert.match(prompt, /never claim that a button currently says “选择代码库” or “选择知识范围”/)
  assert.match(prompt, /never infer selection state from the absence of a repository name in the user's message/)
  assert.match(prompt, /never ask the user to repeat a selected repository name/)
  assert.match(prompt, /call mcp__chrome__selected_source_scope from the parent with no arguments/)
  assert.match(prompt, /selected-source wrappers and Connector own the authoritative session selection/)
  assert.match(prompt, /For a code\/repository question, a request to optimize or change an existing feature, or a user statement that a repository is selected, call search_selected_remote_code after you know that side is selected/)
  assert.match(prompt, /For \/pmd-prd research, use search_selected_remote_code when only code repositories are selected/)
  assert.match(prompt, /When any knowledge range is selected, use search_selected_knowledge/)
  assert.match(prompt, /that unified retrieval submits both the knowledge scope and repository IDs to \/api\/rag\/retrieval/)
  assert.match(prompt, /If the relevant side is actually unselected, the echo or that wrapper will return the precise limitation/)
  assert.match(prompt, /Do not launch both search wrappers merely to discover selection state/)
  assert.match(prompt, /Those agents inherit a local working directory and may inspect the wrong repository/)
  assert.match(prompt, /If you are already a delegated child[\s\S]*call the matching mcp__chrome__code_search or mcp__chrome__knowledge_search tool first/)
  assert.match(prompt, /An empty cwd listing is not such a request/)
  assert.match(prompt, /Words such as “inspect”, “README”, “directory”, “package\.json”, “repository”, “optimize”, or a feature name do not make a remote-source request local/)
  assert.match(prompt, /From a parent session, confirm names with mcp__chrome__selected_source_scope and reach selected source contents only through search_selected_remote_code and search_selected_knowledge/)
  assert.match(prompt, /direct mcp__chrome__code_search or mcp__chrome__knowledge_search call from the parent is rejected/)
  assert.match(prompt, /Those wrappers take a short description and a prompt/)
  assert.match(prompt, /For \/pmd-prd, only after the user confirms the displayed requirement understanding, turn that confirmed structure into the source-oriented prompt/)
  assert.match(prompt, /For a normal direct search that is not \/pmd-prd, pass the current end user's message unchanged as prompt/)
  assert.match(prompt, /For a process follow-up, obey the evidence-only composition and fallback rule above/)
  assert.match(prompt, /overrides any earlier per-parent-turn limit/)
  assert.match(prompt, /Put that concrete gap in description/)
  assert.match(prompt, /Do not send the same prompt again/)
  assert.match(prompt, /hard limit of three selected-source wrappers/)
  assert.match(prompt, /they do not accept question/)
  assert.match(prompt, /question belongs only to the child's one mcp__chrome__code_search or mcp__chrome__knowledge_search call/)
  assert.match(prompt, /selected remote range as authoritative/)
  assert.match(prompt, /never substitute the local workspace, Bash, grep, or Git/)
  assert.match(prompt, /report that limitation instead of falling back to local files, shell, or git/)
})
