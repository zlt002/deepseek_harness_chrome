import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Cross-layer contract: every spreadsheet/document action the MCP surface
 * advertises (native connector.mjs tool schema + background validation) must
 * be accepted by the content-script dispatcher allowlist. A stale allowlist
 * silently rejects advertised actions — `office_spreadsheet view` once died
 * as "Extension peer returned no Connector result" exactly this way, while
 * the runtime itself fully supported the action.
 */
function arrayOnFirstMatchingLine(source, predicate, label) {
  const line = source.split('\n').find((line) => predicate(line))
  assert.ok(line, `${label} line must exist in the source`)
  const match = /\[([^\]]*)\]/.exec(line)
  assert.ok(match, `${label} line must contain an array literal`)
  return match[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean)
}

test('the content script accepts every spreadsheet action the MCP surface advertises', async () => {
  const connectorSource = await readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8')
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')

  const advertised = [
    ...arrayOnFirstMatchingLine(connectorSource, (line) => line.includes('action: { enum:') && line.includes("'special_cells'"), 'the connector office_spreadsheet action enum'),
    ...arrayOnFirstMatchingLine(backgroundSource, (line) => line.includes("['context', 'selection', 'used_range', 'range', 'range_features'") && line.includes("'special_cells'"), 'the background office_spreadsheet action list'),
  ]
  const allowlist = arrayOnFirstMatchingLine(contentSource, (line) => line.includes("'special_cells', 'inspect_write', 'write', 'probe'"), 'the content-script spreadsheet allowlist')

  for (const action of new Set(advertised)) {
    assert.ok(allowlist.includes(action), `advertised spreadsheet action '${action}' must be accepted by the content script allowlist`)
  }
})

test('the content script accepts every light-document action the MCP surface advertises', async () => {
  const connectorSource = await readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8')
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')

  const advertised = [
    ...arrayOnFirstMatchingLine(connectorSource, (line) => line.includes('action: { enum:') && line.includes("'selection'"), 'the connector office_document action enum'),
    ...arrayOnFirstMatchingLine(backgroundSource, (line) => line.includes("'read', 'search', 'selection'"), 'the background office_document action list'),
  ]
  const allowlist = arrayOnFirstMatchingLine(contentSource, (line) => line.includes("'read', 'search', 'selection', 'inspect_write'"), 'the content-script light-document allowlist')

  for (const action of new Set(advertised)) {
    assert.ok(allowlist.includes(action), `advertised light-document action '${action}' must be accepted by the content script allowlist`)
  }
})

test('the content script grants light-document writes a longer budget than reads, under the native connector timeout', async () => {
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')
  const connectorSource = await readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8')

  const writeBudgetMatch = /'write'\s*\?\s*(\d[\d_]*)/.exec(contentSource)
  assert.ok(writeBudgetMatch, 'the light-document dispatcher must define an explicit write timeout budget')
  const writeBudgetMs = Number(writeBudgetMatch[1].replace(/_/g, ''))
  const nativeTimeoutMatch = /const REQUEST_TIMEOUT_MS = (\d[\d_]*)/.exec(connectorSource)
  assert.ok(nativeTimeoutMatch, 'the native connector must define REQUEST_TIMEOUT_MS')
  const nativeTimeoutMs = Number(nativeTimeoutMatch[1].replace(/_/g, ''))

  // A write legitimately needs longer than a read (runtime APP wait +
  // CanvasPatch change poll + readback), but must stay under the native
  // REQUEST_TIMEOUT_MS so the extension answer never races a native abort.
  assert.ok(writeBudgetMs > 8_000, `write budget ${writeBudgetMs}ms must exceed the 8s read budget`)
  assert.ok(writeBudgetMs < nativeTimeoutMs, `write budget ${writeBudgetMs}ms must stay under the native ${nativeTimeoutMs}ms request timeout`)
})

test('the light-document CustomEvent bridge uses a per-load channel and strict envelopes', async () => {
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')
  const runtimeSource = await readFile(new URL('../apps/chrome-extension/public/office-light-document-runtime.js', import.meta.url), 'utf8')
  assert.match(contentSource, /const documentRuntimeChannel = crypto\.randomUUID\(\)/)
  assert.match(contentSource, /deepseekHarnessChannel = documentRuntimeChannel/)
  assert.match(contentSource, /type: 'request', channel: documentRuntimeChannel, id, request/)
  assert.match(contentSource, /payload\.type === 'response' && payload\.channel === documentRuntimeChannel/)
  assert.match(runtimeSource, /existingRuntime\.registerChannel\(bridgeChannel\)/)
  assert.match(runtimeSource, /const registeredChannels = new Map\(\)/)
  assert.match(runtimeSource, /const consumedRequestIds = new Set\(\)/)
  assert.match(runtimeSource, /registeredChannels\.has\(value\.channel\)/)
  assert.match(runtimeSource, /type: 'response', channel, id, ok: true/)
})
