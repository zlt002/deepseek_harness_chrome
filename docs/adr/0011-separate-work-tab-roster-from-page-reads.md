---
status: accepted
---

# Separate the work-tab roster from on-demand page reads

The model-facing roster tool is `list_work_tabs` (legacy alias `office_get_context`). It lists the checked Browser Targets for this Run: live title, URL, editor kind, primary write target, and closed tabs. It does not load page bodies.

Page content is a second, on-demand step. `read_work_tab` reads a bounded body from one still-checked work tab. The model passes the 1-based `pages` index from the latest `list_work_tabs` roster; it cannot invent a tabId. Light documents and spreadsheets are read from the WebEdit iframe; other pages return visible text immediately, without waiting for the page to go idle. Writes stay on the primary Browser Target. Office reads use a longer Native timeout than generic Connector calls so a cold WebEdit iframe probe can finish. The roster and page-read handlers do not share the Native start/stop queue, and a ready iframe that never answers the real operation times out instead of stalling later `list_work_tabs` calls.

The extension keeps a live roster by tabId. Same-tab navigation refreshes the saved URL on the next Connector turn. Closed tabs drop out of available reads. Content is never preloaded into the prompt on send.
