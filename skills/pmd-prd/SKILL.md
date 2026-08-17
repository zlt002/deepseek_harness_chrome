---
name: pmd-prd
description: "从原始需求经过澄清、资料查询、分析确认和双文档预览，安全交付一个需求分析 Doc 与一个完整 PRD Doc。"
disable-model-invocation: true
user-invocable: true
---

# `/pmd-prd` Harness-native workflow

Harness Workspace 是唯一用户界面；本 Skill 不复制 AccrUI sidepanel，也不要求用户填写内部 ID、Cookie 或工具 payload。最终只允许创建两份美的 Team Knowledge 轻文档：

1. `{需求标识}_{主题}_01_需求分析与研发交付`
2. `{需求标识}_{主题}_02_PRD`

## 状态机与确认门

`input → reference_selection → research → analysis_interview → analysis_confirmed → preview → documents_confirmed → parent_inspect → parent_confirmed → creating → partial/paused/failed → completed`

阶段对照和可检查完成条件见 [`references/capability-matrix.md`](references/capability-matrix.md)。
仅当本条消息已包含业务需求而启动新 Run、确认资料范围、记录访谈/查询/状态，或用户明确要求恢复暂停/部分交付时，读取 [`references/process-state.md`](references/process-state.md)；它是本 Skill 的运行绑定、持久过程文件和恢复合同。

### 项目目录与精简执行

本 Skill 可在任意工作目录中使用。当前工作目录不是业务代码库，也不是远程仓库的本地镜像；它只用于绑定本 Run、放置过程状态、PRD/分析草稿和用户明确放入的本地资料。目录为空或只有过程文件是正常情况，不得据此判断“没有项目”“没有现有功能代码”，不得询问代码在本地哪里，也不得改去新建本地工程。业务实现、现有功能和待优化对象以会话顶部已选远程代码库/知识库为准，与当前工作目录分离。不得要求切换到固定仓库或固定目录。

每次只规划当前阶段到下一阶段的转换，不得重新推演已完成阶段或预先展开后续阶段。用户回答一轮问题后，只持久化本轮新增事实、受影响的术语和状态增量，再重算下一轮 frontier；保留多轮确认，但不重复复述完整工作流、稳定事实或已确认答案。读取每个相关状态文件至多一次，批量写入受影响文件；不要为同一轮拆出重复探测，也不要生成同时覆盖未来阶段的巨型脚本。

工具调用必须严格匹配当前会话里该工具的 live schema。父会话确认当前已选范围时，调用无参数的 `mcp__chrome__selected_source_scope`；这是只读回显，不是检索，也不得改成请用户读两个范围按钮。父会话查询已选远程代码库或知识库时，只调用 `search_selected_remote_code` / `search_selected_knowledge`，参数只有 `description` 和 `prompt`；下一阶段依赖这次结果时设 `run_in_background: false`。这两个包装工具不接受 `question`。`question` 只属于子 Agent 内部的 `mcp__chrome__code_search` / `mcp__chrome__knowledge_search`。父会话不得直调这两个检索 MCP 工具，也不得用 `subagent`、`subagent_fork`、本地 `bash`/`glob`/`read`/`grep`/`git` 代替已选远程范围。若收到参数校验错误或“only inside the continuable … subagent”，先改走包装工具并补齐字段，再重试一次；不得使用相同参数重复调用。若当前会话只有 `run_code`，才在程序内按 SDK 调用上述包装工具；每次顶层 `run_code` 调用都必须同时提供 `code` 和 `description`。工具成功后直接进入当前阶段的用户输出，不为已完成的机械步骤追加长篇自我分析。

### 空调用与恢复判定

只输入 `/pmd-prd` 时，第一响应只能请用户直接描述业务需求。不得扫描目录、读取旧 manifest 或创建任何状态；也不得读取 `process-state.md`、模板或其他本地资料来猜测旧 Run。只有本条消息已包含业务需求后，才生成运行绑定并进入阶段 1；只有用户明确表示恢复或继续旧 Run 时，才读取 manifest 和恢复状态。空调用、普通的新需求或仅出现业务编号都不是恢复请求。

### 阶段 1：输入需求

本条消息包含业务需求时，Harness 才自动生成内部 `requirementId`，并绑定当前 `runId/sessionId`；用户只提供业务需求，不填写内部 ID。若用户文本出现类似 `req_...` 的业务编号，将其作为业务事实保留，不把它当作内部绑定。随后从同一条用户消息提取用户、场景、问题、目标、范围、约束和验收要求；缺失项标记 `[待确认]`。先用不超过 200 字复述根理解，建立依赖设计树。若根理解无歧义，直接进入阶段 2；不得先询问 Agent 可自行查明的代码事实。完成条件：内部需求绑定已建立，根理解已确认/无歧义，设计树根和当前 frontier 已建立。

### 阶段 2：选择参考资料

输入框上方的范围选择是授权来源；模型看不到按钮上的名称，不得根据用户消息里有没有仓库名推断未选，也不得请用户读两个范围按钮并回报名称。本阶段没有单独的 Run 级选库工具，也不要扫描本地工作区来猜测仓库。进入本阶段后，父会话先调用一次无参数的 `mcp__chrome__selected_source_scope`，用回显名称向用户确认当前范围：代码库一侧报 `repositories`，知识一侧报 `knowledge`；某一侧数组为空 = 该侧未选。确认文案必须写出识别到的具体名称。用户确认后，只查询已选侧：代码库已选才调用 `search_selected_remote_code`，知识库已选才调用 `search_selected_knowledge`。未选的那一侧禁止调用对应包装工具，也禁止用 `subagent`、`subagent_fork` 或底层检索 MCP 去试探。两侧回显都未选时，停在本阶段请用户选择或明确不使用远程资料，不得先做 RAG 检索再问。回显失败时报告工具错误，仍不得改让用户读按钮。确认只代表授权，不代表查询已发生。每次父会话检索只传：短 `description`，以及一条具体、聚焦、含业务对象/目标流程/待查证据的 `prompt`；需要立刻写分析时设 `run_in_background: false`。`prompt` 是给子 Agent 的完整任务，由子 Agent 转成一次 MCP `question`；父会话不得自己传 `question`，也不得直调 `mcp__chrome__code_search` / `mcp__chrome__knowledge_search`。取消停留在本阶段；已选侧查询失败不阻断草稿，但必须把失败影响写入过程状态并标 `[待确认]`。后续阶段 3–6 必须使用这次包装工具回执里的远程证据，不得改用本地 cwd 文件重做调研。完成条件：每一侧都已是「已查询 / 明确不使用 / 确认未选」，且未选侧没有子代理调用。

### 阶段 3：需求分析与确认

使用 `grill-with-docs` 的设计树/frontier 逐轮澄清，校准领域术语、边界和不变量。每轮完整询问当前 frontier，不任意截断；问题编号全程连续，严格使用：`❓ **Q<n>** - **<决策标题>**：<具体场景与互斥选项>`，下一行使用 `➡️ <具体推荐、价值、代价或风险>`。问题只问产品真实取舍，不问可由 Agent 查明的事实；“全部按推荐”只确认当前轮推荐并立即重算下一轮。每轮回答后按过程状态合同记录访谈、已确认术语、实际资料来源、必要 ADR 和状态；分析必须包含需求理解、证据、范围、主/异常流程、权限、数据影响、研发计划、验收用例、风险和待确认项。用户明确确认需求理解、范围、计划和验收方向后，才进入阶段 4；确认前禁止写线上文档。完成条件：所有设计树分支已访问，术语/范围/计划/验收确认，无未解释的静默假设，且过程状态已持久化。

### 阶段 4：双文档预览与确认

读取本目录 `templates.md`（再按其指针读取完整正文）。生成分析 Doc 和完整 PRD Doc；PRD 必须保留模板所有章节、顺序、标题及必填/选填标记，并区分用户事实、知识依据、`[AI 推断]` 和 `[待确认]`。展示两个规范文件名、章节摘要和待确认数量，请求用户确认两个文档内容。阶段 4 用户确认的两份正文快照是唯一交付正文；不得从 `process.md`、`domain-model.md`、`knowledge-sources.md`、trace 或其他本地 Markdown 重新拼接。内容变化必须重新预览并重新确认。此阶段不绑定父节点、不写远程。完成条件：两份正文快照、规范文件名和模板完整性校验均冻结，用户第二次确认有效。

### 阶段 5：父节点确认

请用户在 Chrome 手动打开目标目录或可创建子项的轻文档父级。调用 `mcp__chrome__pmd_prd_delivery` 的 `inspect_parent`，回显知识库、父节点、URL、类型、权限和 fingerprint。再调用一次 `preview`，传入阶段 4 冻结的 `analysis`/`prd` 两份正文；工具会把两份 content hash、父节点和 Browser Target 冻结到同一 delivery run。此阶段只检查父目录、冻结预览并请求用户确认，不创建或修改线上文档。然后只询问一次是否在该父节点下创建以上两份 Doc。父节点不一致、权限不足或检查失败时停止。完成条件：双文档 preview 成功，且用户明确确认父节点。

### 阶段 6：创建与回读

使用 `mcp__chrome__pmd_prd_delivery` 执行：

`inspect_parent → preview → user confirmation → create → status`

`create` 必须使用 preview 返回的一次性 challenge、相同的 `requirementId`、`deliveryRunId` 和两份正文。工具内部为两项生成独立幂等身份，成功项不得重复创建；失败项返回 `partial_delivery`，重新 preview 并确认后只恢复未完成项。两项都在同一父节点下、名称和正文回读通过后才报告完成。完成条件：delivery record 为 `completed`，两项均 `created`，均有 catalogId、完整 stages 和同目标回读证据。

## 安全约束

- 不调用本地 midea-knowledge auth，不暴露凭据。
- 不把 HTTP 200、创建响应或 build 当作成功；必须验证业务状态、资源身份、父节点和同目标正文回读。
- 轻文档和表格是不同能力；本流程只创建轻文档，表格使用 `kind=spreadsheet` 的独立 Connector 流程。
- 不从本地 `process.md`、`prd.md` 或其他文件重建已确认正文；唯一正文来源是阶段 4 快照。
- 模板完整性校验失败时停止，不删除或压缩章节。
