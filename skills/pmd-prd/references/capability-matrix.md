# AccrUI → Harness 能力矩阵

| AccrUI 阶段/约束 | Harness-native 契约 | 可检查完成条件 |
|---|---|---|
| 1 输入需求 | `input` | 已提取目标、使用者、范围、约束与待确认项 |
| 2 参考资料选择 | 范围选择器本身就是查询授权；父会话先调用无参数 `mcp__chrome__selected_source_scope`，有已选名称就以 continuable background 直接查询对应侧，不再要求聊天确认或复述名称；用户勾选后任意继续消息都先重新回显；两侧为空时只提示去顶部勾选代码库/知识库或明确不使用远程资料，不提供数字聊天选项；未选侧禁止 `search_selected_remote_code`、`search_selected_knowledge`、`subagent` 和底层检索 MCP。已选侧父会话用 `description`+`prompt` 走对应包装工具 | 每一侧都是已查询/明确失败/用户明确不使用/确认未选，且未选侧无子代理调用；选择不等于已查询 |
| 3 初始理解与纠正循环 | `research(pending)` 与 `internal_requirement_normalization` 并行；pending 期间仅内部提取/去重用户已给事实、映射已知与待查、准备候选问题，不主动询问业务痛点、范围、规则或验收；结算后先用代码/知识证据排除可自行查明的问题，再进入 `correction_loop`，只问仍需产品决策的问题，最多 3 题 | 产品已确认范围和业务规则；无静默假设；不让用户等待或轮询 |
| 4 代码定位、修改建议与验收 | 只在每个远程查询完成、明确失败或用户明确跳过后，用已选远程资料形成代码计划和五类验收清单 | 查询 `pending` 时不得主动询问业务痛点、范围、规则或验收，也不得确认当前实现、代码位置、技术建议或最终验收影响；解除后代码位置含仓库/文件/函数/已确认时行号；未知项标 `[待确认]`；验收覆盖正常、异常、边界、权限、兼容 |
| 5 双文档 | 六部分研发交接包 + 完整公司 PRD + 双正文快照 | 所有查询已结算/明确失败/明确跳过后才可冻结；第一份恰有六部分；公司 PRD 九个主章节和原标签、顺序不变；无编造事实或无依据数字 |
| 6 双文档预览与父节点确认 | `mcp__chrome__team_knowledge_batch_preview` | 稳定 `batchId = pmd:${requirementId}` 已持久化在 Run state；恰好两项冻结 `items` 按需求分析、PRD 顺序提交；同一 Browser Target、父 fingerprint 和两项 contentHash 已冻结，用户只确认一次 |
| 7 创建交付 | `mcp__chrome__team_knowledge_batch_create` + 每份页面确认卡 | `create` 只传 `batchId`+`challenge` 且不重传正文；每份写入后停留页面，用户逐项确认后才离页并开始下一份；停止/超时不切父级且不处理下一项；以 create 返回的 batch 状态为准；两项均有 catalogId/stages/持久化 readback，batch 状态为 completed |
| 8 生成不对时选中再改 | `list_work_tabs` + `light_document_selection_read` + `light_document_selection_replace_preview/commit` | 用户先看页面有没有生成、对不对；不对就选中那段再改。不整篇重写，不再走批量创建；换页或没选中则停止 |
| 模板完整性 | 六部分研发交接包、公司 PRD 九个主章节和填写标记 | 任一交接包部分、PRD heading、顺序或标签缺失即停止 |
| 部分交付 | body-free batch record | 一项成功一项失败时为 partial，恢复列表只含未完成项 |
