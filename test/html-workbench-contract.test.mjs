import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('HTML Workbench keeps file permission, DOM selection, approval, and same-target readback fail-closed', async () => {
  const [background, connector, catalog] = await Promise.all([
    readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../apps/native-server/src/connector-tool-catalog.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(background, /html-workbench-select\/v1/)
  assert.match(background, /file_access_permission_missing_or_page_unreadable/)
  assert.match(background, /event\.shiftKey/); assert.match(background, /event\.altKey/)
  assert.match(background, /发送给 AI/); assert.match(background, /选择父级/); assert.match(background, /cancel\.onclick = stop/)
  assert.match(background, /send\.onclick[\s\S]*html-workbench-selection/)
  assert.match(background, /html-workbench-selection\/v1/); assert.match(background, /picker\.nonce/)
  assert.match(background, /validHtmlWorkbenchAnchor/)
  assert.match(connector, /htmlWorkbenchChallenges/); assert.match(connector, /html_workbench_commit/)
  assert.match(connector, /fingerprint_mismatch/); assert.match(connector, /atomicWrite\(grant\.edits\)/)
  assert.match(connector, /persisted\.some\(item => item\.content !== item\.edit\.content\)/)
  assert.match(background, /crypto\.subtle\.digest\('SHA-256'/); assert.match(background, /domFingerprint/); assert.doesNotMatch(background, /expectedPageFingerprint/)
  assert.match(connector, /refresh_readback/); assert.match(connector, /htmlFingerprint\(disk\.html\)/); assert.match(connector, /sourceFingerprint !== expectedSourceFingerprint/); assert.doesNotMatch(connector, /htmlWorkbenchPageFingerprint/); assert.match(connector, /uncertain:/)
  assert.ok(connector.indexOf("await send('preflight')") < connector.indexOf('await atomicWrite(grant.edits)'), 'target preflight must precede file mutation')
  assert.match(catalog, /html_workbench_preview/); assert.match(catalog, /Supply only the one-time challenge/)
})
