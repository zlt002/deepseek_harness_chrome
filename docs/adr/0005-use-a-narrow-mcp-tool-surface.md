---
status: accepted
---

# Use a narrow MCP connector surface for the first milestone

The first milestone connected Harness to a Native Host-managed local MCP endpoint with a narrow Connector surface. The current PRD surface is `list_work_tabs`, `read_work_tab`, light-document read/search/selection/write, `team_knowledge_batch_preview`/`create`, plus knowledge/code search. Spreadsheet mutation tools, `browser_open_tab`, and `team_doc_create` are removed. Short operations remain synchronous; long knowledge or delivery work becomes cancellable Connector Jobs. Generic Harness tool cards are sufficient, and no deep Cordis UI plugin is required until a proven product need emerges.

The milestone excludes charts, pivot tables, batch document delivery, unrestricted knowledge domains, custom Harness UI, Edge, and Windows. Its Parity Gate is real macOS Chrome evidence for spreadsheet read/write/read-back, sourced knowledge and code queries, single-document creation and body read-back, cancellation, reconnect, and target isolation; automated tests and builds alone are insufficient.
