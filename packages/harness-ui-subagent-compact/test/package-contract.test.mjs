import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

test('keeps the accepted compact subagent controls in an out-of-tree plugin', async () => {
  const [client, action, header, trajectory, actionCss, headerCss] = await Promise.all([
    read('src/client/index.ts'),
    read('src/client/CompactSubagentAction.tsx'),
    read('src/client/CompactSubagentHeaderActions.tsx'),
    read('src/client/CompactTrajectoryHeaderActions.tsx'),
    read('src/client/CompactSubagentAction.module.css'),
    read('src/client/CompactSubagentHeaderActions.module.css'),
  ])
  assert.match(client, /sidebar\.compact\.action/)
  assert.match(client, /sidebar\.compact\.subagent\.action/)
  assert.match(client, /sidebar\.compact\.trajectory\.action/)
  assert.match(action, /openChild\(\{ parentSessionId: currentSessionId, childSessionId: entry\.id, mode: entry\.mode \}\)/)
  assert.match(action, /projectionValues\?\.tokenUsage/)
  assert.match(header, /copy-session-log/)
  assert.match(header, /compact-detail-trajectory-icon/)
  assert.doesNotMatch(header, /close\(parentSessionId\)/)
  assert.doesNotMatch(header, /IconCloseOutline16/)
  assert.match(trajectory, /view !== 'trajectory'/)
  assert.doesNotMatch(trajectory, /returnConversation|compact\.detail\.conversation/)
  assert.match(actionCss, /width: min\(328px, calc\(100vw - 20px\)\)/)
  assert.match(actionCss, /--dsh-scrollbar-thumb:/)
  assert.doesNotMatch(headerCss, /\.returnConversation/)
})
