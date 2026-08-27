import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeSkillsPatch, defaultWorkspacePatch, effectiveSessionTrackingPatch, harnessArgs, loaderModuleSpecifier, prepareProductUiPackages, productUiPatch, PRODUCT_OFFICE_SKILL_NAMES, resolveDefaultWorkspacePlugin, resolveHarnessCwd, resolveHarnessCli, resolveHarnessRuntimePlugin, resolveHarnessTrackingPlugin, resolveProductOfficeSkillsPlugin, resolveProductSkillsRoot, resolveUserHome } from '../apps/native-server/src/harness-process.mjs'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink } from 'node:fs/promises'
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

test('mounts the Harness-native pmd-prd skill with its template contract', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const template = await readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8')
  const pointer = await readFile(new URL('../skills/pmd-prd/templates.md', import.meta.url), 'utf8')
  const capabilityMatrix = await readFile(new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url), 'utf8')
  assert.match(skill, /name: pmd-prd/)
  assert.match(skill, /disable-model-invocation: true/)
  for (const tool of ['mcp__chrome__team_knowledge_batch_preview', 'mcp__chrome__team_knowledge_batch_create']) assert.match(skill, new RegExp(tool))
  assert.doesNotMatch(skill, /mcp__chrome__team_knowledge_batch_status/)
  assert.doesNotMatch(skill, /pmd_prd_delivery/)
  assert.doesNotMatch(capabilityMatrix, /pmd_prd_delivery/)
  assert.doesNotMatch(capabilityMatrix, /deliveryRunId/)
  assert.match(skill, /documents_confirmed/)
  assert.match(skill, /partial_delivery/)
  assert.match(skill, /父会话不得直调这两个检索 MCP 工具/)
  assert.match(skill, /search_selected_remote_code/)
  assert.match(skill, /search_selected_knowledge/)
  assert.match(skill, /参数只有 `description` 和 `prompt`/)
  assert.match(skill, /这两个包装工具不接受 `question`/)
  assert.match(skill, /Q<n>/)
  assert.match(skill, /process\.md/)
  assert.match(skill, /domain-model\.md/)
  assert.match(skill, /references\/process-state\.md/)
  assert.match(skill, /Harness Workspace 是唯一用户界面/)
  assert.match(skill, /自动生成内部 `requirementId`/)
  assert.doesNotMatch(skill, /pmd-workspace/)
  assert.doesNotMatch(skill, /clarification\.md/)
  assert.match(pointer, /references\/templates\.md/)
  assert.doesNotMatch(capabilityMatrix, /一次 `knowledge_search`/)
  assert.match(capabilityMatrix, /search_selected_remote_code/)
  assert.match(capabilityMatrix, /search_selected_knowledge/)
  assert.match(capabilityMatrix, /`description`\+`prompt`/)
  assert.match(capabilityMatrix, /范围选择器本身就是查询授权/)
  assert.match(capabilityMatrix, /有已选名称就以 continuable background 启动一个对应侧的聚焦包装工具子代理/)
  assert.match(capabilityMatrix, /未选侧禁止 `search_selected_remote_code`、`search_selected_knowledge`、`subagent` 和底层检索 MCP/)
  assert.match(template, /PRD: \{编号\} - \{主题\}/)
  assert.match(template, /单 PRD 模板/)
  for (const heading of [
    '# 一、术语与缩写', '# 二、背景与目标', '# 三、整体流程', '# 四、功能性需求',
    '# 五、角色权限', '# 六、非功能性需求', '# 七、配置与开关', '# 八、测试关注点',
    '# 九、参考文档',
  ]) assert.match(template, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const rule of ['最终只生成一份 PRD', '功能内容必须写清', 'PRD 只写最终业务结论']) assert.match(template, new RegExp(rule))
  for (const rule of ['问题基线/规模', '目标值', '业务收益', '度量口径', '用户已确认', '标注“估算”', '不得猜测']) assert.match(skill + template, new RegExp(rule))
  assert.match(template, /没有依据的数字、目标、成本或收益写 `\[待确认\]`/)
  assert.match(skill, /主动核对“问题基线\/规模、目标值、业务收益、度量口径”四项/)
  assert.match(skill, /最多提出 3 个最小业务确认问题/)
  assert.match(template, /量化维度 \| 现状\/基线 \| 目标值 \| 业务收益 \| 度量口径/)
  for (const heading of ['现状', '调整方式', '调整后效果', '验收清单']) assert.match(template, new RegExp(heading))
  for (const category of ['正常情况', '异常情况', '边界情况', '权限情况', '兼容情况']) assert.match(template, new RegExp(category))
  assert.doesNotMatch(template, /AccrUI 需求交接附录|Evidence ID|Impact ID|测试 seam|验收合同/)
  assert.match(capabilityMatrix, /初始理解与纠正循环/)
  assert.match(capabilityMatrix, /单 PRD/)
})

test('declares pmd-prd run binding, isolated scope, persisted state, and stale-confirmation recovery contracts', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const processState = await readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8')

  assert.match(skill, /自动生成内部 `requirementId`/)
  assert.match(skill, /用户只提供业务需求，不填写内部 ID/)
  assert.match(skill, /references\/process-state\.md/)
  assert.match(processState, /mcp__chrome__selected_source_scope/)
  assert.match(processState, /当前工作目录只是本 Run 的过程\/草稿工作区，不是代码库/)
  assert.match(processState, /不要另造一套 Run 级选库/)
  assert.match(processState, /范围选择器本身就是查询授权/)
  assert.match(processState, /有已选名称就直接进入对应查询，不再要求用户聊天确认/)
  assert.match(processState, /用户勾选后收到任意继续消息，都必须先重新调用一次 `mcp__chrome__selected_source_scope`/)
  assert.match(processState, /未选侧禁止调用对应包装工具/)
  assert.match(processState, /也禁止用 `subagent`、`subagent_fork` 或底层检索 MCP 试探/)
  assert.match(processState, /父会话每次检索只传 `description` \+ 一条聚焦 `prompt`/)
  assert.match(processState, /包装工具没有 `question` 参数/)
  assert.match(processState, /生成新的内部标识/)
  assert.match(processState, /旧确认在恢复后失效/)
  assert.match(processState, /阶段 5 确认正文快照是唯一交付正文/)
  assert.match(processState, /阶段 6 的父目录确认与线上创建严格分离/)
  assert.match(processState, /稳定的 `batchId = pmd:\$\{requirementId\}`/)
  assert.match(processState, /`team_knowledge_batch_preview` 内部只检查父节点并冻结目标与正文/)
  for (const confirmation of ['understanding_confirmed', 'corrections_confirmed', 'business_rules_confirmed', 'code_plan_confirmed', 'acceptance_confirmed']) assert.match(processState, new RegExp(confirmation))
  assert.match(processState, /每行一个独立、合法 JSON 对象/)
  assert.match(processState, /同一轮更新受影响的过程文件/)
  assert.match(skill, /AI 原理解、产品纠正、最终理解、影响/)
  assert.match(skill, /提问、选项和推荐全部使用业务语言/)
  assert.match(skill, /不出现 URL 参数、本地缓存、数据库、接口方式、类名、函数名等实现术语/)
  assert.match(skill, /只集中确认代码与资料无法决定的产品范围、行为、验收、风险或不可逆取舍/)
  assert.match(skill, /每轮只问会改变业务范围、规则、验收或不可逆选择的问题，最多 3 题/)
  assert.match(skill, /每题的问题正文控制在 1–2 句，建议只用 1 句，更多问题放到下一轮/)
  assert.match(skill, /已查代码事实也要转述为已确认的当前产品表现/)
  assert.match(skill, /技术实现建议仅在阶段 4 基于实际代码证据提出/)
  assert.match(skill, /每题必须使用下面固定的块级 Markdown 结构/)
  assert.match(skill, /标题与三项内容之间均保留空行/)
  for (const label of ['### ❓ Q<n> - <决策标题>', '**需要确认：**', '**建议：**', '**影响：**']) assert.ok(skill.includes(label))
  assert.match(skill, /“影响”只说用户可见业务表现/)
  assert.match(skill, /关联改动、风险分析与验收/)
  assert.match(skill, /`pmd:\$\{requirementId\}`/)
  assert.match(skill, /生成并持久化稳定的 `batchId`/)
  assert.doesNotMatch(skill, /deliveryRunId/)
  assert.match(skill, /恰好一项 PRD/)
  assert.match(skill, /参数只能是 `\{ batchId, challenge \}`/)
  assert.match(skill, /以 `team_knowledge_batch_create` 返回的 batch 状态为准/)
  assert.match(skill, /challenge 过期、已消费或 ephemeral plan 缺失/)
  assert.match(skill, /重新 preview，取得新 challenge，并重新完成这一次用户确认/)
  assert.doesNotMatch(skill, /fresh preview/)

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
    assert.match(content, /mcp__chrome__code_search/)
    assert.match(content, /mcp__chrome__knowledge_search/)
    assert.match(content, /不从父会话直调这两个检索 MCP|父会话不得直调这两个检索 MCP 工具|不得直调 `mcp__chrome__code_search`/)
  }
})

test('keeps empty and new pmd-prd runs free of old workspace scans and manifest recovery', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const processState = await readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8')

  assert.match(skill, /只输入 `\/pmd-prd` 时，第一响应只能请用户直接描述业务需求/)
  assert.match(skill, /不得扫描目录、读取旧 manifest 或创建任何状态/)
  assert.match(skill, /不得 Glob\/List 需求工作区根目录/)
  assert.match(skill, /不得读取任何旧 manifest 来查重或判断是否恢复/)
  assert.match(skill, /只有用户明确表示恢复或继续旧 Run 时，才读取 manifest/)
  assert.match(processState, /空 `\/pmd-prd` 不是恢复请求/)
  assert.match(processState, /不枚举工作区、不读取其他需求目录或旧 manifest/)
})

test('keeps pmd-prd project-agnostic and bounds Code Mode execution', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /可在任意工作目录中使用/)
  assert.match(skill, /当前工作目录不是业务代码库/)
  assert.match(skill, /不得询问代码在本地哪里/)
  assert.match(skill, /不得要求切换到固定仓库或固定目录/)
  assert.match(skill, /只规划当前阶段到下一阶段的转换/)
  assert.match(skill, /不得重新推演已完成阶段或预先展开后续阶段/)
  assert.match(skill, /每次顶层 `run_code` 调用都必须同时提供 `code` 和 `description`/)
  assert.match(skill, /不得使用相同参数重复调用/)
  assert.match(skill, /也不得改成请用户读两个范围按钮/)
  assert.match(skill, /父会话先调用一次无参数的 `mcp__chrome__selected_source_scope`/)
  assert.match(skill, /有已选名称就直接进入对应查询，不再要求用户聊天确认/)
  assert.match(skill, /用户勾选后收到任意继续消息，都先重新调用一次 `mcp__chrome__selected_source_scope`/)
  assert.match(skill, /未选的那一侧禁止调用对应包装工具/)
  assert.match(skill, /两侧回显都未选时，停在本阶段/)
  assert.match(skill, /不得先做 RAG 检索再问/)
  assert.match(skill, /包装工具不接受 `question`/)
  assert.match(skill, /每个父会话轮次最多启动一个 selected-source 检索子代理/)
  assert.match(skill, /只有下一步确实依赖检索结果时，才显式设 `run_in_background: false` 前台等待/)
  assert.match(skill, /后续阶段 3–5 必须使用这次包装工具回执里的远程证据/)
})

test('keeps pending research internal while limiting each parent turn to one selected-source child', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const processState = await readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8')
  const capabilityMatrix = await readFile(new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url), 'utf8')
  const source = await readFile(new URL('../apps/native-server/src/harness-process.mjs', import.meta.url), 'utf8')

  assert.match(source, /toolName: search_selected_remote_code[\s\S]*backgroundMode: continuable/)
  assert.match(source, /toolName: search_selected_knowledge[\s\S]*backgroundMode: continuable/)
  assert.match(skill, /research\(pending\) ∥ internal_requirement_normalization/)
  assert.match(skill, /research_settled → correction_loop/)
  assert.match(skill, /代码正在后台查询，您无需等待；结果回来后我会先核对现状，只集中确认仍需产品决策的问题/)
  assert.match(skill, /远程查询一律以 continuable background 启动，不等待结果/)
  assert.match(skill, /每个父会话轮次最多启动一个 selected-source 检索子代理/)
  assert.match(skill, /pending 期间仅内部整理/)
  assert.match(skill, /提取、去重用户已给事实，映射已知与待查，并准备候选问题但不向用户展示/)
  assert.match(skill, /用户自愿补充则记录，但不主动追问/)
  assert.match(skill, /最多 3 题/)
  assert.match(skill, /先用代码\/知识证据删除可自行查明的问题/)
  assert.match(skill, /只有存在时，才在后续父会话轮次追加一个聚焦检索/)
  assert.match(skill, /不得确认当前实现、代码位置、技术建议、关联改动、风险或最终验收影响/)
  assert.match(skill, /不得完成代码计划、冻结文档或交付/)
  assert.match(skill, /检索完成、明确失败或用户明确跳过/)
  assert.match(processState, /子代理结算通知自动唤醒父会话/)
  assert.match(processState, /`pending` 期间与 `internal_requirement_normalization` 并行/)
  assert.match(processState, /不得启动第二个检索/)
  assert.match(processState, /pending 期间不得主动向用户提问/)
  assert.match(processState, /`correction_loop` 必须在 `research_settled` 后启动/)
  assert.match(processState, /完成、明确失败或用户明确跳过后解除自己的门/)
  assert.match(processState, /不得轮询、另造 UI，或让用户再次确认是否继续等待/)
  assert.match(capabilityMatrix, /结算结果存在独立证据缺口时，才在后续父会话轮次追加一个检索/)
  assert.match(capabilityMatrix, /`research\(pending\)` 与 `internal_requirement_normalization` 并行/)
  assert.match(capabilityMatrix, /结算后先用代码\/知识证据排除可自行查明的问题/)
  assert.match(capabilityMatrix, /所有查询已结算\/明确失败\/明确跳过且影响分析 settled 后才可冻结/)
})

test('keeps pmd-prd user output decision-first while hiding internal process details', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')
  const processState = await readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8')

  assert.match(skill, /全流程.*决策优先|决策优先.*用户可见输出/)
  assert.match(skill, /## 需要您确认/)
  assert.match(skill, /\*\*请决定：\*\*/)
  assert.match(skill, /当前唯一需要决定的事/)
  assert.match(skill, /最多(?:给 )?3 个短选项/)
  assert.match(skill, /推荐/)
  assert.match(skill, /决策前.*阶段编号.*内部绑定.*requirementId.*runId.*sessionId/)
  assert.match(skill, /工作区创建.*文件读取\/写入.*状态字段.*过程文件清单.*工具调用.*长表格/)
  assert.match(skill, /阶段 1.*一句“我理解：…”/)
  assert.match(skill, /代码库\/知识库/)
  assert.match(skill, /明确本轮不使用远程资料/)
  assert.doesNotMatch(skill, /1\. \*\*选择代码库\*\*[\s\S]*2\. \*\*选择知识库\*\*/)
  assert.match(skill, /阶段 3[\s\S]*需要您确认[\s\S]*总标题/)
  assert.match(processState, /内部状态.*过程追踪.*只用于持久化与恢复.*不得.*用户可见进度播报/)
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
  assert.match(source, /mcp__chrome__code_search call with one focused non-empty "question" string/)
  assert.match(source, /toolName: search_selected_knowledge/)
  assert.match(source, /mcp__chrome__knowledge_search call with one focused non-empty "question" string/)
  const code = source.slice(source.indexOf('toolName: search_selected_remote_code'), source.indexOf('toolName: search_selected_knowledge'))
  const knowledge = source.slice(source.indexOf('toolName: search_selected_knowledge'))
  assert.match(code, /enableRunInBackground: false/)
  assert.match(knowledge, /enableRunInBackground: false/)
  assert.match(code, /allow: \['mcp__chrome__code_search'\]/)
  assert.match(code, /Preserve the end user's language in the MCP question/)
  assert.match(code, /when the user writes Chinese, user-visible narration must be Simplified Chinese/)
  assert.match(code, /first action must be exactly one[\s\S]*mcp__chrome__code_search call/)
  assert.match(code, /keep that question to one file, one function, or one short topic/)
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
  assert.match(prompt, /Keep each selected-source wrapper prompt to one file, one function, or one short topic/)
  assert.match(prompt, /call the same matching wrapper sequentially, once per file or function/)
  assert.match(prompt, /Each parent turn starts at most one selected-source wrapper child/)
  assert.match(prompt, /Only a later parent turn may start one additional focused wrapper/)
  assert.match(prompt, /current working directory is a session workspace for generated documents and process files, not the product codebase/)
  assert.match(prompt, /empty or docs-only cwd is expected/)
  assert.match(prompt, /never ask where the code is after seeing an empty listing/)
  assert.match(prompt, /must not wait for a matching subject keyword/)
  assert.match(prompt, /what the selected repositories contain/)
  assert.match(prompt, /directory tree, README, package manifest, build configuration, or architecture is a remote-code question/)
  assert.match(prompt, /Broad repository overviews still go through one focused selected-source question/)
  assert.match(prompt, /Never answer a question about the selection by listing local workspace files/)
  assert.match(prompt, /first tool call must be the matching selected-source wrapper/)
  assert.match(prompt, /except mcp__chrome__selected_source_scope when you only need to confirm the current names/)
  assert.match(prompt, /Never delegate through generic subagent or subagent_fork/)
  assert.match(prompt, /does not receive or observe the live composer-strip labels/)
  assert.match(prompt, /never claim that a button currently says “选择代码库” or “选择知识范围”/)
  assert.match(prompt, /never infer selection state from the absence of a repository name in the user's message/)
  assert.match(prompt, /never ask the user to repeat a selected repository name/)
  assert.match(prompt, /call mcp__chrome__selected_source_scope from the parent with no arguments/)
  assert.match(prompt, /selected-source wrappers and Connector own the authoritative session selection/)
  assert.match(prompt, /For a code\/repository question, a request to optimize or change an existing feature, or a user statement that a repository is selected, call search_selected_remote_code after you know that side is selected/)
  assert.match(prompt, /If the relevant side is actually unselected, the echo or that wrapper will return the precise limitation/)
  assert.match(prompt, /Do not launch both search wrappers merely to discover selection state/)
  assert.match(prompt, /Those agents inherit a local working directory and may inspect the wrong repository/)
  assert.match(prompt, /If you are already a delegated child[\s\S]*call the matching mcp__chrome__code_search or mcp__chrome__knowledge_search tool first/)
  assert.match(prompt, /An empty cwd listing is not such a request/)
  assert.match(prompt, /Words such as “inspect”, “README”, “directory”, “package\.json”, “repository”, “optimize”, or a feature name do not make a remote-source request local/)
  assert.match(prompt, /From a parent session, confirm names with mcp__chrome__selected_source_scope and reach selected source contents only through search_selected_remote_code and search_selected_knowledge/)
  assert.match(prompt, /direct mcp__chrome__code_search or mcp__chrome__knowledge_search call from the parent is rejected/)
  assert.match(prompt, /Those wrappers take a short description and one focused prompt/)
  assert.match(prompt, /they do not accept question/)
  assert.match(prompt, /question belongs only to the child's one mcp__chrome__code_search or mcp__chrome__knowledge_search call/)
  assert.match(prompt, /selected remote range as authoritative/)
  assert.match(prompt, /never substitute the local workspace, Bash, grep, or Git/)
  assert.match(prompt, /report that limitation instead of falling back to local files, shell, or git/)
})
