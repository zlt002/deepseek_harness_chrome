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
| Skill three-state settings | `packages/harness-skill-settings` and client plugin | Host/client product plugins wired. Generic Registry and `skill.list` seams live in ordered `upstream-contributions` patches; Claude roots use existing `customSkillDirs` |
| Agent preset labels | `packages/harness-ui-agent-preset` | External compact footer projection complete; existing `conversation.composer.dock` seam is sufficient |
| Subagent UI | official `ui-subagent` | The catalog/header action and read-only child flow are already upstream; the old duplicate compact-header entry is deliberately dropped |
| Session export | official `session-log-export` | The official Session Header utility and `/export` flow remain bundled; the old duplicate Settings quick action is deliberately dropped |
| Responsive shell and styling | official layout/sidebar/theme modules | Keep the official responsive shell; the old product-wide visual rewrite is deliberately dropped to preserve upgradeability |

## Legacy release patch removal

The former `release/windows-lite/harness-ui.patch` product snapshot has been
removed. Windows CI now checks out the official submodule recursively, runs
`pnpm build:harness-product`, and materializes its runtime from
`.generated/harness-product`. Product behavior lives in `packages/`; the small,
generic seams still needed from Harness live as ordered patches in
`upstream-contributions/`.

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
