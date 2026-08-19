import test from 'node:test'
import assert from 'node:assert/strict'
import { extensionIdsFromManifest, extensionIdsFromManifests, harnessBuildSteps, isGracefulProcessTermination, processTree } from '../scripts/restart-dev.mjs'

test('builds the Harness Web app when restart finds its dist missing', () => {
  assert.deepEqual(harnessBuildSteps({ skipHarnessBuild: false, webDistExists: false }), [
    'build:lib:host',
    'build:web',
  ])
  assert.deepEqual(harnessBuildSteps({ skipHarnessBuild: false, webDistExists: true }), [
    'build:lib:host',
  ])
  assert.deepEqual(harnessBuildSteps({ skipHarnessBuild: true, webDistExists: false }), [])
})

test('treats an intentional dev-server signal stop as a successful lifecycle', () => {
  assert.equal(isGracefulProcessTermination(null, 'SIGTERM'), true)
  assert.equal(isGracefulProcessTermination(null, 'SIGINT'), true)
  assert.equal(isGracefulProcessTermination(143, null, { allowSignalExitCode: true }), true)
  assert.equal(isGracefulProcessTermination(143, null), false)
  assert.equal(isGracefulProcessTermination(1, null), false)
})

test('reuses all valid Chrome extension ids from the installed manifest', () => {
  assert.deepEqual(extensionIdsFromManifest({ allowed_origins: [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    'https://example.com/',
    'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  ] }), [
    'abcdefghijklmnopabcdefghijklmnop',
    'ponmlkjihgfedcbaponmlkjihgfedcba',
  ])
})

test('deduplicates extension ids collected from Chrome and Edge manifests', () => {
  assert.deepEqual(extensionIdsFromManifests([
    { allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'] },
    { allowed_origins: [
      'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    ] },
  ]), [
    'abcdefghijklmnopabcdefghijklmnop',
    'ponmlkjihgfedcbaponmlkjihgfedcba',
  ])
})

test('selects only the installed Native Host and its descendants', () => {
  const processes = [
    { pid: 10, ppid: 1, command: 'node /Application Support/DeepSeekHarness/native-server/bin.mjs' },
    { pid: 11, ppid: 10, command: 'node deepseek-harness/apps/cli/lib/bin.js' },
    { pid: 12, ppid: 11, command: 'helper' },
    { pid: 20, ppid: 1, command: 'node unrelated-server.mjs' },
  ]
  assert.deepEqual(
    processTree(processes, '/Application Support/DeepSeekHarness/native-server/bin.mjs').map(({ pid }) => pid),
    [11, 12, 10],
  )
})
