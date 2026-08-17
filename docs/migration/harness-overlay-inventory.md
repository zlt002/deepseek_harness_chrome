# Harness overlay migration inventory

Baseline: `e327898` compared with official `47f943859b`.

The raw commit changes 548 files. After excluding generated `.js`, `.d.ts`,
`.map`, the accidental `node_modules` link, notes, and reports, 163 hand-written
files remain. Excluding tests and package/config metadata leaves roughly 99
product source files.

| Product area | Migration destination | Current seam status |
|---|---|---|
| MCP scope and session lineage | `packages/harness-runtime` | Public runtime seams are sufficient |
| Browser Target controls | `packages/harness-ui-browser-target` | Public composer slots are sufficient; reconnect uses the existing `sidebar.footer.action` seat instead of a compact-shell fork |
| Knowledge/code scope | `packages/harness-ui-knowledge-scope` | Product plugin and bundle are complete. Clean upstream already provides the card-wide overlay; only the generic composer-above slot remains in `upstream-contributions/0001-*` |
| Skill three-state settings | `packages/harness-skill-settings` and client plugin | The e327 built-in Skill Settings package and bundle registrations are externalized. Generic Registry, settings/RPC, and catalog-cache seams live in ordered `upstream-contributions` patches; Claude roots use existing `customSkillDirs` |
| Agent preset labels | `packages/harness-ui-agent-preset` | Compact footer projection is externalized through `conversation.composer.dock`; the remaining hero/header/settings behavior stays in the accepted overlay until its shared Composer Overlay seam is externalized |
| Subagent UI | `packages/harness-ui-subagent-compact` plus official `ui-subagent` | Compact child navigation and trajectory actions are externalized; the official package keeps the catalog/header action and read-only child flow |
| Session export | official `session-log-export` + `packages/harness-ui-session-log-copy` | The official Session Header utility and `/export` flow remain bundled; AccrUI's Settings “复制日志” action is externalized and copies only the current Session raw log |
| Responsive shell and styling | `product-overlays` latest-source snapshot, then out-of-tree UI packages | The active snapshot is independent Harness `e327898`, not the historical Windows release patch. Preserve it until each replacement passes side-by-side browser acceptance; upgradeability alone is not a reason to drop product behavior |

## Historical release patch replaced

The former `release/windows-lite/harness-ui.patch` snapshot was an old UI and
is no longer used. `product-overlays/` now contains the full source difference
from official `47f943859b` to the independent Harness's accepted latest commit
`e327898`. It is applied only to the disposable `.generated/harness-product`
tree; the official submodule itself remains clean.

The four patches in `upstream-contributions/` are retained for a dedicated
rebase. They cannot be applied on top of `e327898` without conflicts, so the
materializer intentionally uses the complete latest-source overlay alone and
records that fact in `.harness-product.json`; it does not delete or modify
those patches.

Generated lockfiles, build output, historical notes, and test-only injection
changes are not migration targets.

Migration rules:

1. Do not copy generated Harness build output.
2. Do not import `upstream/deepseek-harness/**/src` from product packages.
3. Add product behavior through Cordis/client plugins.
4. Keep missing generic seams as upstream contributions, not business patches.
5. `pnpm verify:upstream` must stay green throughout the migration.

## Reproducible product Harness

`pnpm materialize:harness-product` creates `.generated/harness-product` as an
independent local clone at the submodule's exact revision and applies every
generic patch in `upstream-contributions/`. The independent clone is
intentional: Harness' postinstall owns repository-local Lefthook settings and
cannot install safely inside a linked Git worktree.

`pnpm build:harness-product` installs the complete dependency graph, builds the
Host libraries, emits all Client bundles, and builds Web. The pinned upstream
currently has five pre-existing React test-fixture type conflicts in its Client
TypeScript project; production Client bundling remains successful and the
upstream typecheck is tracked as a separate visible gate.
