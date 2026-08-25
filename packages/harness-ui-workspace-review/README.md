# Workspace Markdown Review

Out-of-tree Host and Client plugin for the visual Markdown collaboration surface.

## Host API

The Host derives the only workspace root from `session.header.cwd`, canonicalizes it, and rejects path traversal, symlinks, non-regular files, non-Markdown extensions, and files over 2 MiB.

- `POST /api/workspace-review/list` — same-origin session request; lazy directory entries.
- `POST /api/workspace-review/open` — same-origin session request; returns opaque `{ reviewId, resourceId, capability, displayPath }`.
- `POST /api/workspace-review/snapshot` — bearer-only background-proxy request; returns a 1 MiB-bounded read-only snapshot.
- `POST /api/workspace-review/selection` — registers a bounded visual or source selection for the owning Harness session.
- `POST /api/workspace-review/proposals` — returns queued AI proposals for visual Diff review.
- `POST /api/workspace-review/prepare-write` — checks resource identity, revision, and fingerprint, then returns a short-lived content-bound approval.
- `POST /api/workspace-review/commit-write` — atomically writes an approved draft and performs same-resource readback verification.
- `POST /api/workspace-review/rehydrate` — same-origin session request; rotates a capability only when its live record still matches the session, canonical root, and resource identity.

Capabilities exist only in this Host runtime and must stay in the Extension background's memory. They are not URL or storage data. Host restart invalidates every review record and requires reopening from the file tree.

## Client contract

The Client registers a `目录` child beneath the compact Workspace picker. Its tabs keep normal sessions and Claude import controls in the session view, while the directory view resolves the selected Workspace to its current session when possible (otherwise its first session). At desktop column widths it also registers a `目录` header action that opens the same lazy tree in a drawer. The former three-dot `工作区` quick action is intentionally absent. It sends the Host-created open record to a dedicated nonce/origin checked parent bridge:

```ts
{ type: 'markdown-review-open/v1', nonce, review }
```

The extension layer owns review-tab creation and the capability-bearing proxy. The visual Milkdown surface supports local WYSIWYG drafts, structured and cross-block selections, and reviewable AI proposals. A verified, bounded feedback item travels through `markdown-review-feedback/v1`; the Client awaits `reviewFeedback.submitWorkspaceMarkdown(harnessSessionId, feedback)`. This imports the one annotation and directly creates an AI turn in that bound session — it never waits for a later manual composer send. Concurrent retries and late-ACK retries for the same feedback id share one turn; failures preserve the highlighted annotation and return the concrete bounded error for retry. The ordinary composer transform remains unchanged for assistant-message annotations.

The `propose_workspace_markdown_edit` tool queues a candidate for Milkdown's in-document Diff. It never writes the file. The user must accept the candidate into the local draft and separately complete prepare, explicit confirmation, commit, and same-resource readback before the UI reports a Verified Write.

## Model Experience

### Pending Markdown review feedback

#### What the model sees

Indirectly, through the shared review feedback service, the model sees a bounded JSON annotation containing resource identity, display path, revision, fingerprint, source range, quote context, and user comment. The document body is never attached by this package.

#### Token effect

Conditional and bounded by the number and field limits enforced by the extension feedback bridge.

#### KV Cache effect

Appending a pending annotation changes the current user submission only; it does not replace prior conversation context.

## Safety boundaries

- **Extension review surface is external to this package** — the background must register the tab lifecycle, capability proxy, and sender validation before the file button can open a tab.
- **AI proposals never write directly** — acceptance changes only the local visual draft.
- **Conflicts never overwrite** — prepare and commit compare the same resource identity and fingerprint; external changes return the latest snapshot.
- **Uncertain writes never auto-retry** — a failed readback requires an explicit re-read before any new save attempt.
