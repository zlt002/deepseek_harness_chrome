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
Tool inputs and tool results are not copied into the detail view or continuation
prompt.
Known Claude-generated wrapper records such as `browser_context` and
`system-reminder` are excluded from titles and migrated text while ordinary
user text containing angle-bracket terms remains intact.

The source defaults to `~/.claude/projects`. The dialog can switch to another
absolute Claude `projects` directory and restore the default. The Host resolves
the real directory path before scanning; project and session paths remain
bounded beneath that canonical root. The canonical source root is part of the
duplicate identity, so a backup tree cannot collide with the default tree.

The Client creates or reuses a normal blank session through the public
Workspace runtime, sends the converted context through `session.prompt`,
records the stable source key after Host admission, renames the session, and
opens it. It never writes Harness session logs directly. A repeated source key
opens the previous imported session when it is still available, or offers an
explicit import-as-copy action.

Discovery and selected-file preparation are cancellable. Once normal session
creation starts, the dialog disables cancellation and states that the admitted
prompt cannot be rolled back. Registry mutations are serialized in the Host
and use unique atomic-replacement temporary files, so concurrent tabs retain
both records.

Every Client request has an action-specific deadline (15 seconds for selected
session preparation; shorter bounds for indexing). A deadline reports the
exact failed action instead of leaving the dialog pending forever. Caller
cancellation is composed with that deadline. The Host aborts selected-file
reads when the HTTP request is abandoned. The public Client surface currently
has no reliable connection-generation reset hook for this global dialog, so
the request deadline remains the generation-change safety net.

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

- Importing is a new user turn and therefore starts a model response; it is not
  a byte-for-byte replay of Claude Code's internal event state.
- Running tools, approvals, subagents, caches, and non-text blocks are not
  resumable across runtimes.
