# AccrUI → Harness 能力矩阵

| AccrUI 阶段/约束 | Harness-native 契约 | 可检查完成条件 |
|---|---|---|
| 1 输入需求 | `aggregation_preflight → input`；聚合预检在 Run/工作区初始化前执行，“优化需求/本次迭代/一起做/同一 PRD”只算打包偏好，不能替代共同业务目标 | 混装未决时未启动 Run、未读取状态合同、未持久化或研究；多个可独立上线/排期/验收的需求已完成拆分/保留决定，拆分时已选定本轮主需求且其余候选在 Run 初始化后写入 `process.md`，保留时已说明不可拆的共同目标；随后才提取目标、使用者、范围、约束与待确认项 |
| 2 参考资料选择 | 范围选择器本身就是查询授权；父会话先调用无参数 `mcp__chrome__selected_source_scope`，有已选名称就以 continuable background 启动一个对应侧的聚焦包装工具子代理，不再要求聊天确认或复述名称；结算结果存在独立证据缺口时，才在后续父会话轮次追加一个检索；用户勾选后任意继续消息都先重新回显；两侧为空时只提示去顶部勾选代码库/知识库或明确不使用远程资料，不提供数字聊天选项；未选侧禁止 `search_selected_remote_code`、`search_selected_knowledge`、`subagent` 和底层检索 MCP。已选侧父会话用 `description`+`prompt` 走对应包装工具 | 每一侧都是已查询/明确失败/用户明确不使用/确认未选，且每个父会话轮次至多一个 selected-source 子代理；选择不等于已查询 |
| 3 初始理解与纠正循环 | `research(pending)` 与 `internal_requirement_normalization` 并行，但不启动第二个检索；结算后先用代码/知识证据排除可自行查明的问题，并仅在仍有独立证据缺口时于后续父会话轮次追加一个聚焦检索；证据充分后进入 `correction_loop`，只问仍需产品决策的问题，最多 3 题 | 产品已确认范围和业务规则；无静默假设；不让用户等待或轮询 |
| 4 关联改动、风险分析与验收 | 只在每个远程查询完成、明确失败或用户明确跳过后，用已选远程资料形成代码计划、影响地图和五类验收清单 | 每个直接改动均映射代码证据、关联页面/流程/角色/数据/共用能力、风险、建议、回归范围和产品决策状态；代码能确定的不问产品；未知项标 `[待确认]`；验收覆盖正常、异常、边界、权限、兼容 |
| 5 单 PRD | 完整公司 PRD + 一份正文快照 + 左侧 Markdown Review | 所有查询已结算/明确失败/明确跳过且影响分析 settled 后才可冻结；PRD 九个主章节顺序不变；标题和正文没有字段标签；每个功能包含现状、调整方式、输入/输出规则、调整后效果；第八章包含关联改动与风险、回归范围、异常关注点和五类验收；无编造事实或无依据数字；冻结并校验通过后调用 `open_workspace_markdown_review`，只有左侧审核的采纳才可进入阶段 6，正文变化使旧采纳失效 |
| 6 PRD 预览与父节点确认 | `mcp__chrome__team_knowledge_batch_preview` | 稳定 `batchId = pmd:${requirementId}` 已持久化在 Run state；恰好一项冻结 PRD 提交；同一 Browser Target、父 fingerprint 和 contentHash 已冻结，用户只确认一次 |
| 7 创建交付 | `mcp__chrome__team_knowledge_batch_create` + 页面确认卡 | `create` 只传 `batchId`+`challenge` 且不重传正文；PRD 写入后停留页面，用户确认后才离页；停止/超时不切父级；以 create 返回的 batch 状态为准；PRD 有 catalogId/stages/持久化 readback，batch 状态为 completed |
| 8 生成不对时修改 | 读取并执行 [`webedit-light-document` Skill](../../webedit-light-document/SKILL.md) 的路径选择 | 用户先看页面有没有生成、对不对；局部更新选中该段，全文重写选中精确稳定的全文并通过选区能力检查。不再走批量创建；换页、编辑器未就绪或不能形成受支持选区则停止并刷新、重新绑定 Browser Target |
| 模板完整性 | 公司 PRD 九个主章节、功能四段、影响风险表和验收五类 | 任一 PRD heading、顺序、功能四段、影响风险字段、回归范围或验收类别缺失即停止 |
| 部分交付 | body-free batch record | PRD 未完成时为 partial，恢复时复用未完成项 |
