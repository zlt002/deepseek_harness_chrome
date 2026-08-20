# AccrUI → Harness 能力矩阵

| AccrUI 阶段/约束 | Harness-native 契约 | 可检查完成条件 |
|---|---|---|
| 1 输入需求 | `input` | 已提取目标、使用者、范围、约束与待确认项 |
| 2 参考资料选择 | 父会话先 `mcp__chrome__selected_source_scope` 回显名称并确认；只查询回显已选侧；未选侧禁止 `search_selected_remote_code`、`search_selected_knowledge`、`subagent` 和底层检索 MCP。已选侧父会话用 `description`+`prompt` 走对应包装工具 | 每一侧都是已查询/明确不使用/确认未选，且未选侧无子代理调用 |
| 3 初始理解与纠正循环 | 每轮保存 AI 原理解、产品纠正、最终理解与影响 | 产品已确认范围和业务规则；无静默假设 |
| 4 代码定位、修改建议与验收 | 只用已选远程资料形成代码计划和五类验收清单 | 代码位置含仓库/文件/函数/已确认时行号；未知项标 `[待确认]`；验收覆盖正常、异常、边界、权限、兼容 |
| 5 双文档 | 六部分研发交接包 + 完整公司 PRD + 双正文快照 | 第一份恰有六部分；公司 PRD 九个主章节和原标签、顺序不变；无编造事实或无依据数字 |
| 6 双文档预览与父节点确认 | `mcp__chrome__team_knowledge_batch_preview` | 稳定 `batchId = pmd:${requirementId}` 已持久化在 Run state；恰好两项冻结 `items` 按需求分析、PRD 顺序提交；同一 Browser Target、父 fingerprint 和两项 contentHash 已冻结，用户只确认一次 |
| 7 创建交付 | `mcp__chrome__team_knowledge_batch_create` + 每份页面确认卡 | `create` 只传 `batchId`+`challenge` 且不重传正文；每份写入后停留页面，用户逐项确认后才离页并开始下一份；停止/超时不切父级且不处理下一项；以 create 返回的 batch 状态为准；两项均有 catalogId/stages/持久化 readback，batch 状态为 completed |
| 8 生成不对时选中再改 | `list_work_tabs` + `light_document_selection_read` + `light_document_selection_replace_preview/commit` | 用户先看页面有没有生成、对不对；不对就选中那段再改。不整篇重写，不再走批量创建；换页或没选中则停止 |
| 模板完整性 | 六部分研发交接包、公司 PRD 九个主章节和填写标记 | 任一交接包部分、PRD heading、顺序或标签缺失即停止 |
| 部分交付 | body-free batch record | 一项成功一项失败时为 partial，恢复列表只含未完成项 |
