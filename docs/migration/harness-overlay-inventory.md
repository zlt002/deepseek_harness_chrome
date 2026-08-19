# Harness overlay migration inventory (completed)

Baseline: `e327898` compared with official `47f943859b`.

The raw commit changes 548 files. After excluding generated `.js`, `.d.ts`,
`.map`, the accidental `node_modules` link, notes, and reports, 163 hand-written
files remain. Excluding tests and package/config metadata leaves roughly 99
product source files.

| Product area | Migration destination | Current seam status |
|---|---|---|
| MCP scope and session lineage | `packages/harness-runtime` | Public runtime seams are sufficient |
| AccrUI effective-session tracking | `packages/harness-tracking` | Host plugin posts to the same company `/api/tracking/effective-sessions` service; first root `step/start` is the execution-start signal |
| Browser Target controls | `packages/harness-ui-browser-target` | Public composer slots are sufficient; reconnect uses the existing `sidebar.footer.action` seat instead of a compact-shell fork |
| Knowledge/code scope | `packages/harness-ui-knowledge-scope` | Product plugin and bundle are complete. Clean upstream already provides the card-wide overlay; only the generic composer-above slot remains in `upstream-contributions/0001-*` |
| Skill three-state settings | `packages/harness-skill-settings` and client plugin | Product plugin mounts by default. Generic Registry, settings/RPC, and catalog-cache seams live in ordered `upstream-contributions` patches; Claude roots use existing `customSkillDirs` |
| Composer document attach | `packages/harness-ui-document-intake` | Product plugin writes PPTX/XLSX/DOCX/PDF/MD/TXT into the session workspace and asks the model to parse them with the product office skills. Generic paste/drop remainder lives in `upstream-contributions/0015-*` |
| Agent preset labels | `packages/harness-ui-agent-preset` | Product presentation mounts through the generic Composer and preset presentation seams |
| Subagent UI | `packages/harness-ui-subagent-compact` plus official `ui-subagent` | Compact child navigation and trajectory actions are externalized; the official package keeps the catalog/header action and read-only child flow |
| Session export | official `session-log-export` + `packages/harness-ui-session-log-copy` | The official Session Header utility and `/export` flow remain bundled; AccrUI's Settings “复制日志” action is externalized and copies only the current Session raw log |
| Responsive shell and styling | `packages/harness-ui-responsive-sidebar` and `packages/harness-ui-conversation-shell` | Product presentation mounts through generic layout and conversation seams |

## Historical overlay retired

The former Windows UI patch and the compressed `e327898` full-source overlay
are no longer used. Their accepted behavior now lives in product-owned packages.
`scripts/materialize-harness-product.mjs` always clones the clean official
revision and applies the ordered generic seams in `upstream-contributions/`.
There is no legacy overlay environment switch or fallback build mode.

## Final architecture

The runtime now has one composition path:

1. Clean `upstream/deepseek-harness` at the pinned revision.
2. Product-neutral extension seams from `upstream-contributions/`.
3. Eleven product UI packages mounted from `packages/`:
   `harness-ui-agent-preset`, `harness-ui-browser-target`,
   `harness-ui-conversation-shell`, `harness-ui-document-intake`,
   `harness-ui-knowledge-scope`, `harness-ui-responsive-sidebar`,
   `harness-ui-session-log-copy`, `harness-ui-settings-shell`,
   `harness-ui-subagent-compact`, `harness-ui-workspace-picker`,
   and `harness-skill-settings`.

The official checkout owns stores, controllers, and default fallbacks. Product
packages own AccrUI presentation and behavior; they attach only through the
generic seams.

## Acceptance status

Real macOS Chrome acceptance has passed from the extension through Native
Messaging into the Harness UI. The accepted surface visibly includes the top
compact shell, knowledge/code scope above the composer, model and permission
controls, Browser Target, and Session Log.

This evidence does **not** yet claim real-browser acceptance for Settings,
trajectory, subagent presentation, or the Windows package. Their focused tests
and builds are useful gates, but they are not substitutes for those pending
acceptance runs.

Startup regression gates:

- Before opening Chrome, verify the exact loaded extension identity with
  `DEEPSEEK_HARNESS_EXTENSION_ID=<extension-id> node scripts/register-native-host.mjs --check`.
  It must find the exact `chrome-extension://<extension-id>/` origin in the
  installed Chrome and Edge Native Messaging manifests.
- Chain-slot product presentations must register through `slots.inject(...)`
  and provide `select` so the matched owner is passed into the product
  presentation. The product package contract tests lock down both parts and
  prevent a silent fallback or an empty shell after startup.

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
