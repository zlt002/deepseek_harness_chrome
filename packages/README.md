# Product plugins

Out-of-tree Cordis and Web Client plugins owned by Harness Browser Workspace.
`harness-tracking` is the Host plugin that reports AccrUI effective sessions to
the same company tracking service.
Packages may depend on public DeepSeek Harness Service Definitions, but never on
files inside `upstream/deepseek-harness/packages/**/src`.

`apps/native-server/src/product-plugin-manifest.mjs` is the single source of
truth for product package build, Native Host installation, Harness injection,
typecheck, and test orchestration. Add a new product package there before
expecting it to reach a Harness runtime.

The upstream checkout is read-only product infrastructure. Product behavior
belongs here.
