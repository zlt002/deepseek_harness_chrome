# AccrUI compact Workspace picker

This out-of-tree product plugin fills the public `sidebar.workspaces.compact`
seat. It preserves the normal Workspace/session actions and adds one
**Import from Claude Code** flow.

The right picker pane has accessible `会话` and `目录` tabs. The picker owns
Workspace selection and renders the product child slot
`accrui.workspace-picker.directory` with only the selected Workspace, its
preferred session (current when it belongs to that Workspace, otherwise the
first), and a close callback. Its popover measures the trigger-to-viewport
space on resize and scroll, naturally sizes to content, and constrains only
the two independently scrollable panes.

The Host half exposes one loopback, same-origin route at
`/api/claude-code.import`. Project discovery reads directory entries and file
metadata only. Session previews read at most 64 KiB per selected project's
session in pages of at most 64 entries; the dialog reports the real loaded and
total counts. Hovering a session date exposes an accessible, on-demand detail
entry; it reads only that session and never changes the selected import source.
Full JSONL parsing happens only after the user opens details or selects one
session and confirms the explicit target Workspace. Selected JSONL is streamed
without a file-byte ceiling. It still has JSONL safety bounds of 20,000 lines
and 120,000 retained text characters; when the detail view reaches the text
bound, it explicitly says that it is showing only the most recent content.
Tool inputs and tool results are not expanded in the detail message list; the
detail summary reports their counts and migration limits, while their redacted,
bounded forms are written into the native history.
Known Claude-generated wrapper records such as `browser_context` and
`system-reminder` are excluded from titles and migrated text while ordinary
user text containing angle-bracket terms remains intact.

The source defaults to `~/.claude/projects`. The dialog can switch to another
absolute Claude `projects` directory and restore the default. The Host resolves
the real directory path before scanning; project and session paths remain
bounded beneath that canonical root. The canonical source root is part of the
duplicate identity, so a backup tree cannot collide with the default tree.

The Host imports a selected transcript as a balanced native Harness seed through
the public Session Store and Session Persistence APIs. Every source
record keeps its own timestamp; user/assistant text, safe thinking, tool calls,
and tool results become real Harness history. The Host applies the selected
Workspace path as `SessionHeader.cwd`, records the user's default agent preset,
marks the converted prefix with `SessionHeader.seedLength`, creates and appends
the validated cold session, and attaches it to that exact Workspace. It does
not create or dispose a temporary live Agent. Therefore
import itself never calls `session.prompt` and never starts a model request;
the Client refreshes the public session list before opening the cold session,
and continuing uses the normal Harness session lifecycle.

The Claude conversion is an independent, small adaptation of the algorithmic
approach in `Nwflower/dsh-chat-import` at commit
`73ea0122b533e43adb17e5b18f52025751826b99` (MIT). No third-party package or
runtime code is included. It accepts string or text-array users, assistant
text/thinking/tool_use, and out-of-order parallel tool_result blocks keyed by
`tool_use_id`. A missing result becomes an explicit unknown-outcome error, never
a success. Synthetic/meta wrappers are excluded. Images, attachments,
permissions, and subagents are intentionally not migrated and the detail pane
states that limitation.

Tool arguments/results are recursively serialized only after token/API-key/
password/authorization/cookie redaction and a 4,000-character-per-block bound. Detail
reports unsupported source blocks and the UI labels truncation. This is a
history projection, not a recovery of Claude Code process state.

Registry records are serialized and atomically replaced with mode `0600`. They
store source size/hash/mtime, imported source-event count, and Harness next seq.
An unchanged source opens the prior session. A strictly append-only source may
append only when the previous Harness session is dormant and has exactly the
recorded next seq; source shrink/rewrite, a live session, or local Harness
continuation returns a conflict and offers the existing explicit copy route.
The append uses public session persistence rather than `.dsh` files so source
timestamps remain intact.

Discovery and selected-file preparation are cancellable. Once native session
creation starts, the dialog disables cancellation because persistence cannot
be rolled back through the public API. The full prepare/persist/attach/commit
operation is serialized in the Host, and registry writes use unique
atomic-replacement temporary files, so concurrent tabs cannot create two
sessions for the same first import and unrelated records are retained.

Before the first persistence write, the Host stores a recoverable pending
record with the final session id and expected event cursor. If persistence,
Workspace attachment, the final registry replacement, or the HTTP connection
fails part-way through, the next import reuses that session id and completes
only the missing stage. An incremental retry likewise checks the pre/post
cursor before appending, so it cannot append the same Claude suffix twice. A
genuinely partial or divergent persistence log is never guessed or rewritten;
the UI instead requires an explicit import-as-copy.

Every Client request has an action-specific deadline (15 seconds for selected
session preparation, 120 seconds for the non-cancellable native write, and
shorter bounds for indexing). A deadline reports the exact failed action
instead of leaving the dialog pending forever. Caller cancellation is composed
with that deadline. The Host aborts selected-file reads when the HTTP request
is abandoned; if the connection is lost after persistence begins, the pending
record provides the reconnect recovery path.

The compact Workspace seat is a chain slot: its selector result arrives as the
framework `matched` prop, while owner props are supplied separately. Controller
resolution accepts the current direct matched value and the previous
HMR-registration wrapper while old entries drain. A missing controller disables
the import entry with a Chinese reconnect hint instead of throwing; a Host
transport exit is surfaced as an action-specific request error.

The import UI is a body-portaled, full-content surface matching the compact
settings shell: fixed 56px header, adaptive main region, and fixed action
footer. Its bounded two-column browser gives less width to projects and the
remaining width and height to sessions. At narrow side-panel widths the source
path occupies its own row and both source actions share the next row, avoiding
horizontal overflow without collapsing the session list.

## Known limitations and deferred work

- It does not restore running tools, approvals, subagents, caches, local files,
  images, or attachments from Claude Code.
