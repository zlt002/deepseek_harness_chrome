---
name: webedit-light-document
description: "在已绑定的美的 Team Knowledge / WebEdit 轻文档中写入或改写正文：标题、段落、列表、表格、Mermaid 与当前选区优化。用户提到轻文档、流程图、饼图、区块或选中内容改写时使用。"
---

# 轻文档 Verified Write

先 `list_work_tabs` 确认工作标签和 `documentIdentity.kind`。要读勾选名单里某一页的正文，用 `mcp__chrome__read_work_tab({ tab })`，`tab` 是该列表 `pages` 的序号（从 1 开始），不能传 tabId。写仍然只写主目标。

主目标轻文档先用 `mcp__chrome__light_document_read({})` 了解正文、`blockCount` 和公开的稳定块 ID；它是只读，不会改文档。

## 按文档状态选写入路径

只在已读到的目标上选一条路径：

- **空白文档（`blockCount=0`）**：结构化正文用 `blocks_insert`，payload `{ position: "end", blocks: [...] }`；每次 preview 只能传 1–50 个受支持块。超过 50 个时按正文顺序分批，每一批都完整执行 `preview → 用户确认 → commit → 同一 Browser Target 回读` 后才能开始下一批；不得并行提交，也不得靠逐个类型探测来试错。Mermaid 用 `insert_drawing`，payload `{ mermaid, position: "end" }`。`xychart-beta` 未经当前 WebEdit 验证，改用 flowchart 或 pie；其他既有 Mermaid 类型保持原契约。只在光标处写纯正文时，先读取当前选区（下方 `selection_read`），再用 `selection_insert`，payload 为恰好一个 `text`、`markdown` 或 `html`，并带该次读取的 `expectedSelectionFingerprint`。
- **已有正文的小范围更新**：只改已读到的稳定旧块。单块使用 `replace` / `blocks_replace`，多块使用 `blocks_batch_replace`；后者 payload 只能是 `{ replacements: [{ id, ... }] }`，最多 50 个 replacement，`id` 必须来自这次读取的旧块；它不能接受 `{ blocks: [...] }`，也不能用来重建整篇文档。删除完整稳定块用 `blocks_delete` 的公开 payload `{ blocks: [{ id }] }`；只接受本次读取的 id，不接受 index。只改标题用 `set_title`。
- **已有正文的全文重写**：先读取正文，再用选区读取确认用户选中了精确、稳定、非折叠的全文，且 `replaceStrategy` 支持替换；只走下方的选区 preview/commit 路线。不能形成受支持的精确全文选区，或返回 `editor not ready` 时，停止并请用户刷新页面、重新绑定 Browser Target 后再读取；此全文/选区替换分支不得猜测 `blocks_delete`、`blocks_insert` 或其他补救 payload。

每条写入路径都必须是 `preview → 用户确认 → commit → 同一 Browser Target 回读`。只有 commit 返回 verified write 且回读符合预期，才能说已完成。

用户要求“在选中地方后面加入流程图”时，先按下方“选区优化”第 1 步读取当前选区。只有稳定的非折叠选区且返回 `selectedTagIds` 后，调用 `light_document_write_preview`：`{ operation: "insert_drawing", payload: { mermaid, position: "after_selection", expectedSelectionFingerprint } }`。`expectedSelectionFingerprint` 必须来自刚才的读取；不要改成 `position: "end"`，也不要猜 `id` 或 XML 偏移。提交会重新核验该选区，并证明 Mermaid 紧跟所选块。

## 选区优化

选区改写只走一次清晰序列：

1. `mcp__chrome__light_document_selection_read({})`：检查 `hasSelection`、`hasCaret`、`isCollapsed` 和 `replaceStrategy`。
2. 任意稳定的非折叠选区（`hasSelection=true`、`isCollapsed=false`）都调用 `mcp__chrome__light_document_selection_replace_preview({ blocks })`；段落内部分文字、跨段落和任意层级列表均可。只删除选区时传 `{ blocks: [] }`，不要把删除改成文末插入或换一种写工具。
3. 获得用户确认后，调用 `mcp__chrome__light_document_selection_replace_commit({ challenge })`。

表格多单元格选区可能定位到所属整张表。若 preview 返回 `action=selection_table_replace_preview` 或 `replacementScope.kind=containing_table`，明确告诉用户“将替换所属整张表（行数 × 列数）”后再等待确认；commit 会原子替换该表，不会在原表下方追加新表。`replaceStrategy=unavailable` 时不发起 preview，请用户选中更完整或更容易唯一定位的表格范围。

选区未变化时不要重复 `selection_read`；只有 `fingerprint_mismatch` 或用户重新选择后才重新读取。`hasCaret=true` 且 `isCollapsed=true` 是光标，不是选区。完整块优先使用结构化 CanvasPatch；字符级或跨块局部选区使用 WebEdit 公开 selection API，并要求选区外正文不变的回读证据。

`preview` 只读且不变更文档；`commit` 不传正文、区块、operation 或 idempotency identity。失败时返回实际错误并停止；`fingerprint_mismatch` 代表写入前文档或选区已变化，重新读取、重新 preview 并再次确认后可安全继续。收到 `invalid_range` 或 `uncertain` 时，先在同一 Browser Target 调用 `light_document_read`：确认当前 id，或确认写入是否已生效；不要直接重复同一 payload 的 preview 或 commit。超时或回读不确定时不得自动重试。不得把编辑器 range 猜成 XML 偏移；局部替换只走公开 selection API。

## 契约

非选区变更走 `mcp__chrome__light_document_write_preview({ operation, payload })`，用户确认后再把 challenge 交给 `mcp__chrome__light_document_write_commit({ challenge })`。空文档按上面的三条受支持路线写正文。

## 不要做

- 不要把流程图写成普通段落或静态图。
- 不要对空文档猜隐藏段落 id。
- 不要复用 challenge，也不要 inspect 一份 payload、write 另一份。
- 全文或选区替换失败后，不要猜 `blocks_delete`、`blocks_insert` 或其他补救 payload；`editor not ready` 时停止，刷新并重新绑定 Browser Target 后再读取。
- 不要把批量子文档创建的暂态失败改成手工写正文或反复选区替换；保留同一批次和幂等标识，等待 Connector 返回可恢复结果。
- 不要调用未开放的图片/导出/高亮操作。
