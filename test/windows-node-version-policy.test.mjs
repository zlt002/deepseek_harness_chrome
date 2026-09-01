import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  WINDOWS_NODE_REQUIREMENT_LABEL,
  isSupportedWindowsNodeVersion,
} from '../release/windows-lite/node-version-policy.mjs'

test('Windows Lite accepts exactly the Node versions supported by the materialized Harness', () => {
  assert.equal(WINDOWS_NODE_REQUIREMENT_LABEL, 'Node.js 22.19.x 或 24+')
  for (const version of ['v22.19.0', '22.22.1', 'v24.0.0', 'v25.3.0']) {
    assert.equal(isSupportedWindowsNodeVersion(version), true, `${version} should be supported`)
  }
  for (const version of ['v21.9.0', 'v22.18.9', 'v23.11.1', 'unknown']) {
    assert.equal(isSupportedWindowsNodeVersion(version), false, `${version} should be rejected`)
  }
})

test('every Windows install surface uses the same strict Node requirement', async () => {
  const [installer, installerUi, acceptance, release] = await Promise.all([
    readFile(new URL('../release/windows-lite/templates/install.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../release/windows-lite/templates/install-ui.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../release/windows-lite/acceptance-windows.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../release/windows-lite/windows-release.mjs', import.meta.url), 'utf8'),
  ])
  for (const source of [installer, installerUi, acceptance]) {
    assert.match(source, /22\.19/)
    assert.match(source, /24/)
  }
  assert.match(release, /node-version-policy\.mjs/)
  assert.match(release, /WINDOWS_NODE_REQUIREMENT_LABEL/)
  assert.match(release, /windowsNodePowerShellPredicate/)
  for (const source of [installer, installerUi, acceptance]) {
    assert.doesNotMatch(source, /Node\.js 22\+/)
  }
})
