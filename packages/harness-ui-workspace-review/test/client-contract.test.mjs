import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('opens from the three-dot quick-action menu and keeps the opaque extension bridge without a viewer registry', async () => {
  const [manifest, client, action, bridge, host] = await Promise.all([
    source('../package.json'), source('../src/client/index.ts'), source('../src/client/WorkspaceReviewAction.tsx'), source('../src/client/bridge.ts'), source('../src/index.ts'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-workspace-review/)
  assert.match(client, /settingsQuickActions/)
  assert.match(client, /id: 'workspace-markdown-files', label: '工作区'/)
  assert.match(client, /open\.set\(true\)/)
  assert.match(client, /sidebar\.compact\.action/)
  assert.match(client, /reviewFeedback/)
  assert.match(client, /importWorkspaceMarkdown\(feedback\.harnessSessionId, feedback\)/)
  assert.match(action, /requestOpenReview/)
  assert.match(action, /useSyncExternalStore/)
  assert.match(action, /hooks\.open\.set\(false\)/)
  assert.doesNotMatch(action, /className=\{css\.trigger\}/)
  assert.doesNotMatch(action, /🗂/)
  assert.match(action, /aria-label="刷新文件树"/)
  assert.match(action, /className=\{css\.tree\}/)
  assert.match(bridge, /markdown-review-open\/v1/)
  assert.match(bridge, /dshWorkspaceReviewNonce/)
  assert.match(client, /markdown-review-feedback-accepted\/v1/)
  assert.match(host, /WORKSPACE_REVIEW_SNAPSHOT_PATH/)
  assert.match(host, /isTrustedSessionRequest/)
  assert.match(host, /bearer\(req\)/)
  assert.doesNotMatch(`${client}\n${action}\n${bridge}`, /viewer registry|composerSubmissionTransforms|WorkspaceReviewStore|deepseek-harness\/packages\/.*\/src/i)
})

test('does not maintain a second local feedback store or a composer transform', async () => {
  const files = await Promise.all([
    source('../src/client/index.ts'), source('../src/client/bridge.ts'),
  ])
  assert.doesNotMatch(files.join('\n'), /setItem|localStorage|sessionStorage|composerSubmissionTransforms|WorkspaceReviewStore/)
})
