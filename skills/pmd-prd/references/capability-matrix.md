# AccrUI → Harness 能力矩阵

| AccrUI 阶段/约束 | Harness-native 契约 | 可检查完成条件 |
|---|---|---|
| 1 输入需求、设计树 | `input` 与 frontier | 根理解已确认或无歧义，当前 frontier 已建立 |
| 2 参考资料选择 | 父会话先 `mcp__chrome__selected_source_scope` 回显名称并确认；只查询回显已选侧；未选侧禁止 `search_selected_remote_code`、`search_selected_knowledge`、`subagent` 和底层检索 MCP。已选侧父会话用 `description`+`prompt` 走对应包装工具 | 每一侧都是已查询/明确不使用/确认未选，且未选侧无子代理调用 |
| 3 需求分析与规模门 | 内置设计树/frontier、领域术语/边界/不变量、tracer-bullet、测试 seam、复杂需求地图和按需原型；评估规模信号 | 所有分支已访问；两个普通信号或一个高风险信号时，已确认拆分选择、覆盖关系和依赖；`decomposition_decided` 成立 |
| 3/4 证据、影响、任务与验收 | 证据分类、代码影响地图、纵向任务、验收合同均按固定模板填写 | 每个 Impact 映射 Evidence；每个 Task 映射 Impact 和至少一个 AC；每个 AC 映射需求和 Task；任务均可独立演示或验证 |
| 4 双文档预览 | 固定 `analysis.md` + 完整 PRD 模板 + 双正文快照 | 文件名、章节顺序、待确认项、任务/AC 映射均冻结，用户确认内容 |
| 5 父节点确认 | `pmd_prd_delivery.inspect_parent` + 双文档 `preview` | 同一 Browser Target、父 fingerprint 和两项 contentHash 已冻结，用户确认父节点 |
| 6 创建交付 | `pmd_prd_delivery.create` + `status` | 两项均有 catalogId/stages/readback，delivery 状态为 completed |
| 模板完整性 | 九个主章节、填写标记、A–D 附录 | 任一 heading 或顺序缺失即停止 |
| 部分交付 | body-free delivery record | 一项成功一项失败时为 partial，恢复列表只含未完成项 |
