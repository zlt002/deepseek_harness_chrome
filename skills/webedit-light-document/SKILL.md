---
name: webedit-light-document
description: "在已绑定的美的 Team Knowledge / WebEdit 轻文档中写入或改写正文：标题、段落、列表、表格、Mermaid 流程图/时序图/饼图，以及当前选区替换。用户提到轻文档、流程图、饼图、更多区块、选中内容改写时使用。"
---

# 轻文档 Verified Write

只用 `mcp__chrome__office_document`。先 `office_get_context` 确认 `documentIdentity.kind` 是 `webedit_light_document`。

## 契约

1. `inspect_write` 必须带最终 `operation` + `payload`，不能裸调。
2. `write` 复用同一对 `operation`/`payload`，加上一次性 `challenge` 和新的 `idempotencyIdentity`。
3. challenge 只用一次；payload 必须字节级相同。
4. 空文档 `blockCount=0` 时禁止 `replace` / `blocks_replace` / `blocks_batch_edit`。

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

- 改当前选中内容：`selection` → `selection_replace`（非折叠选区 + 同一指纹）。折叠光标只能 `selection_insert`。
- 改已读到的稳定块：`replace` / `blocks_replace` / `blocks_batch_edit`，用公开 `id`。
- 只改标题：`set_title`。

## 不要做

- 不要把流程图写成普通段落或静态图。
- 不要对空文档猜隐藏段落 id。
- 不要复用 challenge，也不要 inspect 一份 payload、write 另一份。
- 不要调用未开放的图片/导出/高亮操作。
