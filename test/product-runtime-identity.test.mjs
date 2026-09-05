import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  ACCRUI_CONNECTOR_TMP_PREFIX,
  ACCRUI_INSTALL_DIRECTORY,
  ACCRUI_NATIVE_HOST_NAME,
  ACCRUI_PROFILE_DIRECTORY,
  nativeHostManifestFilename,
} from '../apps/native-server/src/runtime/product-runtime-identity.mjs'
import { listenerBelongsToProject, releaseOwnedListeners } from '../scripts/dev/prepare-dev-port.mjs'
import { resolveOfficeDocumentWriteStatePath } from '../apps/native-server/src/office/office-document-write-record-store.mjs'
import { resolveTeamDocStatePath } from '../apps/native-server/src/knowledge/team-doc-record-store.mjs'
import { resolveTeamKnowledgeBatchStatePath } from '../apps/native-server/src/knowledge/team-knowledge-batch-record-store.mjs'

test('AccrUI runtime identity is distinct from generic DeepSeek Harness identities', () => {
  assert.equal(ACCRUI_NATIVE_HOST_NAME, 'com.accrui.harness.chrome')
  assert.equal(nativeHostManifestFilename(), 'com.accrui.harness.chrome.json')
  assert.equal(ACCRUI_INSTALL_DIRECTORY, 'accr-ui-harness')
  assert.equal(ACCRUI_PROFILE_DIRECTORY, 'profile')
  assert.equal(ACCRUI_CONNECTOR_TMP_PREFIX, 'accrui-harness-connector-')
})

test('connector recovery fallbacks stay beneath the supplied AccrUI home', () => {
  const environment = { HOME: '/isolated-accrui-home', DSH_CONNECTOR_STATE_DIR: '/other-harness/state' }
  const root = join(environment.HOME, 'Library', 'Application Support', ACCRUI_INSTALL_DIRECTORY, 'connector-state')
  assert.equal(resolveOfficeDocumentWriteStatePath(environment), join(root, 'office-document-write-records.json'))
  assert.equal(resolveTeamDocStatePath(environment), join(root, 'team-doc-delivery-records.json'))
  assert.equal(resolveTeamKnowledgeBatchStatePath(environment), join(root, 'team-knowledge-batch-records.json'))
})

test('dev-port ownership requires the current checkout in command or cwd', () => {
  const root = join(process.cwd(), 'fixture-accrui')
  const extensionRoot = join(root, 'apps/chrome-extension')
  assert.equal(listenerBelongsToProject({ command: `node ${join(extensionRoot, 'node_modules/wxt/bin/wxt.mjs')}`, cwd: extensionRoot }, root), true)
  assert.equal(listenerBelongsToProject({ command: `node ${join(process.cwd(), 'unknown/server.mjs')}`, cwd: extensionRoot }, root), false)
  assert.equal(listenerBelongsToProject({ command: `node ${join(process.cwd(), 'other/harness.mjs')}`, cwd: join(process.cwd(), 'other') }, root), false)
})

test('dev-port protection never signals an external listener', async () => {
  const signals = []
  await assert.rejects(
    releaseOwnedListeners(['991'], {
      inspect: async () => ({ command: 'node /other/harness.mjs', cwd: '/other' }),
      signalProcess: async (...args) => signals.push(args),
      wait: async () => [],
      waitMs: 0,
      pollMs: 0,
    }),
    /not proven to belong to this repository; it was left running: 991 \(\/other\)/,
  )
  assert.deepEqual(signals, [])
})
