---
name: webedit-light-document
description: "在已绑定的美的 Team Knowledge / WebEdit 轻文档中写入或改写正文：标题、段落、列表、表格、Mermaid 与当前选区优化。用户提到轻文档、流程图、饼图、区块或选中内容改写时使用。"
---

# 轻文档 Verified Write

先 `list_work_tabs` 确认工作标签和 `documentIdentity.kind`。要读勾选名单里某一页的正文，用 `mcp__chrome__read_work_tab({ tab })`，`tab` 是该列表 `pages` 的序号（从 1 开始），不能传 tabId。写仍然只写主目标。

主目标轻文档也可用 `mcp__chrome__light_document_read({})` 了解正文和稳定块；它是只读，不会改文档。

## 选区优化

选区改写只走一次清晰序列：

1. `mcp__chrome__light_document_selection_read({})`：检查 `hasSelection`、`hasCaret`、`isCollapsed` 和 `replaceStrategy`。
2. 任意稳定的非折叠选区（`hasSelection=true`、`isCollapsed=false`）都调用 `mcp__chrome__light_document_selection_replace_preview({ blocks })`；段落内部分文字、跨段落和任意层级列表均可。
3. 获得用户确认后，调用 `mcp__chrome__light_document_selection_replace_commit({ challenge })`。

选区未变化时不要重复 `selection_read`；只有 `fingerprint_mismatch` 或用户重新选择后才重新读取。`hasCaret=true` 且 `isCollapsed=true` 是光标，不是选区；只需补写时改用 `office_document` 的 `selection_insert`。完整块优先使用结构化 CanvasPatch；字符级或跨块局部选区使用 WebEdit 公开 selection API，并要求选区外正文不变的回读证据。

`preview` 只读且不变更文档；`commit` 不传正文、区块、operation 或 idempotency identity。失败时返回实际错误并停止；`fingerprint_mismatch` 后重新读取并再次确认。不得把编辑器 range 猜成 XML 偏移；局部替换只走公开 selection API。

## 契约

非选区变更使用 `mcp__chrome__office_document`：`inspect_write` 带最终 `operation` + `payload`，随后 `write` 复用同一 payload、一次性 `challenge` 和新的 `idempotencyIdentity`。空文档 `blockCount=0` 时禁止 `replace` / `blocks_replace` / `blocks_batch_edit`。

## 空文档写正文

优先结构化插入，不要把整篇 PRD 压成一段 markdown。

- 流程图 / 时序图 / 饼图：`insert_drawing`，payload `{ mermaid, position: "end" }`。源码用 `flowchart TD`、`sequenceDiagram` 或 `pie`，不要先渲成图片。
- 标题、段落、列表、表格、代码块：`blocks_insert`，payload `{ position: "end", blocks: [...] }`。
- 只在光标处补一段纯文本/markdown 时：先 `selection`，再 `selection_insert`，payload 必须带 `expectedSelectionFingerprint`。

`blocks` 项：

- `{ type: "h1"|"h2"|"h3"|"p"|"blockquote", text }`
- `{ type: "ul"|"ol", items: ["…"] }`
- `{ type: "table", rows: [["表头"], ["单元格"]] }`
- `{ type: "codeblock", language: "mermaid"|"javascript"|…, text }`

## 已有正文

- 改当前选中内容：使用上方三步选区优化流程。
- 改已读到的稳定块：`replace` / `blocks_replace` / `blocks_batch_edit`，用公开 `id`。
- 只改标题：`set_title`。

## 不要做

- 不要把流程图写成普通段落或静态图。
- 不要对空文档猜隐藏段落 id。
- 不要复用 challenge，也不要 inspect 一份 payload、write 另一份。
- 不要在选区优化失败后改走旧选区 payload、`office_document` 或 `blocks_batch_edit`。
- 不要把批量子文档创建的暂态失败改成逐个 `browser_open_tab`、手工写正文或反复选区替换；保留同一批次和幂等标识，等待 Connector 返回可恢复结果。
- 不要调用未开放的图片/导出/高亮操作。
