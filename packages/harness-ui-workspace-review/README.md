# Workspace Markdown Review

Out-of-tree Host and Client plugin for the read-only Markdown review surface.

## Host API

The Host derives the only workspace root from `session.header.cwd`, canonicalizes it, and rejects path traversal, symlinks, non-regular files, non-Markdown extensions, and files over 2 MiB.

- `POST /api/workspace-review/list` — same-origin session request; lazy directory entries.
- `POST /api/workspace-review/open` — same-origin session request; returns opaque `{ reviewId, resourceId, capability, displayPath }`.
- `POST /api/workspace-review/snapshot` — bearer-only background-proxy request; returns a 1 MiB-bounded read-only snapshot.
- `POST /api/workspace-review/rehydrate` — same-origin session request; rotates a capability only when its live record still matches the session, canonical root, and resource identity.

Capabilities exist only in this Host runtime and must stay in the Extension background's memory. They are not URL or storage data. Host restart invalidates every review record and requires reopening from the file tree.

## Client contract

The Client registers `工作区` in the compact header's three-dot quick-action menu. Selecting that menu item opens the lazy overlay drawer mounted through `sidebar.compact.action`. It sends the Host-created open record to a dedicated nonce/origin checked parent bridge:

```ts
{ type: 'markdown-review-open/v1', nonce, review }
```

The extension layer owns review-tab creation and snapshot proxying. It can return a verified, bounded feedback item through `markdown-review-feedback/v1`; the Client passes it to the shared `reviewFeedback.importWorkspaceMarkdown(harnessSessionId, feedback)` service. That service owns the single client-local strip, composer transform, and accepted-only cleanup shared with assistant-message annotations. No disk write route exists in M1.

## Model Experience

### Pending Markdown review feedback

#### What the model sees

Indirectly, through the shared review feedback service, the model sees a bounded JSON annotation containing resource identity, display path, revision, fingerprint, source range, quote context, and user comment. The document body is never attached by this package.

#### Token effect

Conditional and bounded by the number and field limits enforced by the extension feedback bridge.

#### KV Cache effect

Appending a pending annotation changes the current user submission only; it does not replace prior conversation context.

## Known Limitations and Deferred Work

- **Extension review surface is external to this package** — the background must register the tab lifecycle, capability proxy, and sender validation before the file button can open a tab.
- **M1 is read-only** — drafts may exist in the review Tab, but this package intentionally offers no write, approval, conflict, or readback endpoint.
