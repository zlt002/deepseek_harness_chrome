# AccrUI → Harness 能力矩阵

| AccrUI 阶段/约束 | Harness-native 契约 | 可检查完成条件 |
|---|---|---|
| 1 输入需求、设计树 | `input` 与 frontier | 根理解已确认或无歧义，当前 frontier 已建立 |
| 2 参考资料选择 | scope 授权后，代码走 `search_selected_remote_code`，知识走 `search_selected_knowledge`；禁止直接调用底层搜索 | scope 已确认/明确不使用，两路查询结果或失败影响已记录 |
| 3 grill-with-docs 分析 | Skill 内置设计树/frontier、连续 Q 编号、推荐格式、`process.md`/`domain-model.md`/ADR 协议 | 所有分支已访问，术语、范围、计划、验收已确认 |
| 4 双文档预览 | 完整模板 + 双正文快照 | 文件名、章节顺序、待确认项均冻结，用户确认内容 |
| 5 父节点确认 | `pmd_prd_delivery.inspect_parent` + 双文档 `preview` | 同一 Browser Target、父 fingerprint 和两项 contentHash 已冻结，用户确认父节点 |
| 6 创建交付 | `pmd_prd_delivery.create` + `status` | 两项均有 catalogId/stages/readback，delivery 状态为 completed |
| 模板完整性 | 九个主章节、填写标记、A–D 附录 | 任一 heading 或顺序缺失即停止 |
| 部分交付 | body-free delivery record | 一项成功一项失败时为 partial，恢复列表只含未完成项 |
