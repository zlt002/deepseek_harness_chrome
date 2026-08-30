/**
 * Product-owned Harness packages. This is the single source of truth for
 * product package build, installation, injection, typecheck, and test
 * orchestration. Keep UI entries in the existing runtime load order.
 */
export const PRODUCT_PLUGINS = Object.freeze([
  { directory: 'harness-ui-agent-preset', packageName: '@accrui/harness-ui-agent-preset', client: true, typecheck: true, injectionOrder: 1 },
  { directory: 'harness-ui-browser-target', packageName: '@accrui/harness-ui-browser-target', client: true, typecheck: true, injectionOrder: 2 },
  { directory: 'harness-ui-conversation-shell', packageName: '@accrui/harness-ui-conversation-shell', client: true, typecheck: true, injectionOrder: 3 },
  { directory: 'harness-ui-message-annotations', packageName: '@accrui/harness-ui-message-annotations', client: true, typecheck: true, injectionOrder: 4 },
  { directory: 'harness-ui-responsive-sidebar', packageName: '@accrui/harness-ui-responsive-sidebar', client: true, typecheck: true, injectionOrder: 5 },
  { directory: 'harness-ui-workspace-picker', packageName: '@accrui/harness-ui-workspace-picker', client: true, typecheck: true, injectionOrder: 6 },
  { directory: 'harness-ui-account-access', packageName: '@accrui/harness-ui-account-access', client: true, typecheck: true, injectionOrder: 7 },
  { directory: 'harness-ui-knowledge-scope', packageName: '@accrui/harness-ui-knowledge-scope', client: true, typecheck: true, injectionOrder: 11 },
  { directory: 'harness-ui-subagent-compact', packageName: '@accrui/harness-ui-subagent-compact', client: true, typecheck: true, injectionOrder: 8 },
  { directory: 'harness-ui-session-log-copy', packageName: '@accrui/harness-ui-session-log-copy', client: true, typecheck: true, injectionOrder: 9 },
  { directory: 'harness-ui-settings-shell', packageName: '@accrui/harness-ui-settings-shell', client: true, typecheck: true, injectionOrder: 10 },
  { directory: 'harness-ui-document-intake', packageName: '@accrui/harness-ui-document-intake', client: true, typecheck: true, injectionOrder: 12 },
  { directory: 'harness-ui-workspace-review', packageName: '@accrui/harness-ui-workspace-review', client: true, typecheck: true, injectionOrder: 13 },
  { directory: 'harness-ui-prototype-studio', packageName: '@accrui/harness-ui-prototype-studio', client: true, typecheck: true, injectionOrder: 14 },
  { directory: 'harness-skill-settings', packageName: '@accrui/harness-skill-settings', client: true, typecheck: true, injectionOrder: 15 },
  { directory: 'harness-ui-file-url-paste', packageName: '@accrui/harness-ui-file-url-paste', client: true, typecheck: true, injectionOrder: 16 },
  { directory: 'harness-ui-html-workbench', packageName: '@accrui/harness-ui-html-workbench', client: true, typecheck: true, injectionOrder: 17 },
  { directory: 'harness-ui-football-agent', packageName: '@accrui/harness-ui-football-agent', client: true, typecheck: true, injectionOrder: 18 },
  { directory: 'harness-runtime', packageName: '@accrui/harness-runtime-mcp-scopes', client: false, typecheck: false },
  { directory: 'harness-tracking', packageName: '@accrui/harness-tracking', client: false, typecheck: false },
  { directory: 'harness-default-workspace', packageName: '@accrui/harness-default-workspace', client: false, typecheck: false },
])

export const PRODUCT_UI_PLUGINS = Object.freeze(PRODUCT_PLUGINS.filter((plugin) => plugin.client))
export const PRODUCT_UI_PLUGIN_DIRECTORIES = Object.freeze(PRODUCT_UI_PLUGINS.map((plugin) => plugin.directory))
export const PRODUCT_UI_PLUGIN_PACKAGE_NAMES = Object.freeze([...PRODUCT_UI_PLUGINS]
  .sort((left, right) => left.injectionOrder - right.injectionOrder)
  .map((plugin) => plugin.packageName))
export const PRODUCT_PLUGIN_PACKAGE_NAMES = Object.freeze(PRODUCT_PLUGINS.map((plugin) => plugin.packageName))
export const PRODUCT_TYPECHECK_PLUGIN_PACKAGE_NAMES = Object.freeze(PRODUCT_PLUGINS
  .filter((plugin) => plugin.typecheck)
  .map((plugin) => plugin.packageName))
