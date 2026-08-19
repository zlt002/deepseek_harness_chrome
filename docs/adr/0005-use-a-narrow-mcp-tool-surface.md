---
status: accepted
---

# Use a narrow MCP connector surface for the first milestone

The first milestone connects Harness to a Native Host-managed local MCP endpoint and exposes only six Connector Tools: `list_work_tabs` (formerly `office_get_context`), `office_read_range`, `office_write_range`, `knowledge_search`, `code_search`, and `team_doc_create`. Short operations remain synchronous; long knowledge or delivery work becomes cancellable Connector Jobs. Generic Harness tool cards are sufficient, and no deep Cordis UI plugin is required until a proven product need emerges.

The milestone excludes charts, pivot tables, batch document delivery, unrestricted knowledge domains, custom Harness UI, Edge, and Windows. Its Parity Gate is real macOS Chrome evidence for spreadsheet read/write/read-back, sourced knowledge and code queries, single-document creation and body read-back, cancellation, reconnect, and target isolation; automated tests and builds alone are insufficient.
