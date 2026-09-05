# Harness Skill settings

This is the product-owned deep module for Skill modes. Its small interface is:

- `SkillSettingsController`: load, update, and project one durable mode map;
- `projectSkillCatalog()`: retain every source Skill for settings inspection while calculating effective permissions;
- `mountHostSkillSettings()`: connect the policy once a Host exposes two generic seams;
- `claudeSkillRoots()`: supplies `~/.claude/skills` to the existing official `skill-filesystem.customSkillDirs` configuration.

Modes are `enabled`, `manual-only`, and `disabled`. They are always intersected with the original `SKILL.md` frontmatter: local settings cannot re-enable an author-disabled model or manual entry point. The module never writes `SKILL.md`.

## What is external

The policy, normalization, durable update serialization, source-catalog projection, Claude-root configuration, Host plugin, and Settings page are external and tested. The compatibility overlay no longer mounts the old built-in `dsh-skill-settings` packages; the Native Host mounts this product package instead. Claude discovery requires no upstream source change: the official filesystem provider already accepts `customSkillDirs`.

## Required generic Harness seams

The clean upstream at `47f943859b` is missing four generic capabilities introduced by the sibling product fork:

1. A registry `registerInvocationPolicy()` hook plus cache invalidation, and a source-catalog inspection method. This lets a settings plugin reduce permissions without changing providers.
2. `skill.list({ includeUnavailable: true })`, returning effective plus authored invocation controls. The settings page must see disabled Skills in order to re-enable them.
3. Exposure of a plugin-owned registered settings namespace through the existing settings RPC. The current Host allow-list excludes unknown plugin namespaces.
4. Wire schema fields for the extra Skill controls above.

The browser `settings.section` slot itself is already public and sufficient. The four small generic seams live as ordered patches in `upstream-contributions/` while the product runs against the compatibility overlay; they are deliberately written without AccrUI names so they can be upstreamed independently.

## Product integration

1. Load this package as a Host plugin adapter and call `mountHostSkillSettings()` with the official registry/settings adapters.
2. Add `claudeSkillRoots(homedir())` to `dsh-skill-filesystem.customSkillDirs` in the product Host profile.
3. Add this package to `scripts/build/build-harness-client-plugins.mjs`, then add a client settings section using the public `settings.section` slot and the extended `skill.list` wire.
4. Add real-Harness tests for model catalog, `/skill`, disabled Skill re-enable, and cache refresh.
