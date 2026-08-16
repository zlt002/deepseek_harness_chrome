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

### 阶段 1：输入需求

从同一条用户消息提取用户、场景、问题、目标、范围、约束和验收要求；缺失项标记 `[待确认]`。先用不超过 200 字复述根理解，建立依赖设计树。若根理解无歧义，直接进入阶段 2；不得先询问 Agent 可自行查明的代码事实。完成条件：根理解已确认/无歧义，设计树根和当前 frontier 已建立。

### 阶段 2：选择参考资料

通过 Harness 可用的资料选择能力取得本轮独立 scope 授权（远程代码库、知识库、本地项目或不使用远程资料）。scope 确认只代表授权，不代表查询已发生。代码问题调用 `search_selected_remote_code`，知识问题调用 `search_selected_knowledge`；每次只传一个具体、聚焦且有业务对象/目标流程/待查证据的 bounded question。不得绕过这两个 continuable-child 入口直接调用底层搜索工具；取消停留在本阶段；查询失败不阻断草稿，但必须记录影响并标 `[待确认]`。完成条件：scope 已确认/明确不使用，查询结果或失败影响已记录。

### 阶段 3：需求分析与确认

使用 `grill-with-docs` 的设计树/frontier 逐轮澄清，校准领域术语、边界和不变量。每轮完整询问当前 frontier，不任意截断；问题编号全程连续，严格使用：`❓ **Q<n>** - **<决策标题>**：<具体场景与互斥选项>`，下一行使用 `➡️ <具体推荐、价值、代价或风险>`。问题只问产品真实取舍，不问可由 Agent 查明的事实；“全部按推荐”只确认当前轮推荐并立即重算下一轮。每轮回答后将决定摘要追加到 `process.md`；已确认术语立即写入 `domain-model.md`（标准术语、实现无关定义和 `_Avoid_`）。仅当决定难以逆转、缺少上下文会令人意外且存在真实取舍时，才记录简短 ADR 到 `decisions/`。分析必须包含需求理解、证据、范围、主/异常流程、权限、数据影响、研发计划、验收用例、风险和待确认项。用户明确确认需求理解、范围、计划和验收方向后，才进入阶段 4；确认前禁止写线上文档。完成条件：所有设计树分支已访问，术语/范围/计划/验收确认，无未解释的静默假设。

### 阶段 4：双文档预览与确认

读取本目录 `templates.md`（再按其指针读取完整正文）。生成分析 Doc 和完整 PRD Doc；PRD 必须保留模板所有章节、顺序、标题及必填/选填标记，并区分用户事实、知识依据、`[AI 推断]` 和 `[待确认]`。展示两个规范文件名、章节摘要和待确认数量，请求用户确认两个文档内容。内容变化必须重新预览并重新确认。此阶段不绑定父节点、不写远程。完成条件：两份正文快照、规范文件名和模板完整性校验均冻结，用户第二次确认有效。

### 阶段 5：父节点确认

请用户在 Chrome 手动打开目标目录或可创建子项的轻文档父级。调用 `mcp__chrome__pmd_prd_delivery` 的 `inspect_parent`，回显知识库、父节点、URL、类型、权限和 fingerprint。再调用一次 `preview`，传入固定 `analysis`/`prd` 两份正文；工具会把两份 content hash、父节点和 Browser Target 冻结到同一 delivery run。然后只询问一次是否在该父节点下创建以上两份 Doc。父节点不一致、权限不足或检查失败时停止。完成条件：双文档 preview 成功，且用户明确确认父节点。

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
