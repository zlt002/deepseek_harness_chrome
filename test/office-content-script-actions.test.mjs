import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { LIGHT_DOCUMENT_OPERATIONS, SPREADSHEET_INSPECT_ACTIONS, SPREADSHEET_WRITE_OPERATIONS } from '../apps/native-server/src/transport/connector-tool-catalog.mjs'

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

function assignedArrayOnFirstMatchingLine(source, predicate, label) {
  const line = source.split('\n').find((line) => predicate(line))
  assert.ok(line, `${label} line must exist in the source`)
  const match = /=\s*\[([^\]]*)\]/.exec(line)
  assert.ok(match, `${label} line must contain an assigned array literal`)
  return match[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean)
}

test('the content script still accepts used_range for read_work_tab spreadsheet previews', async () => {
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')
  const allowlist = arrayOnFirstMatchingLine(contentSource, (line) => line.includes("'context', 'active_sheet'") && line.includes("'inspect_write', 'write', 'probe'"), 'the content-script spreadsheet allowlist')
  assert.ok(allowlist.includes('used_range'), 'read_work_tab still previews spreadsheets through used_range')
  assert.ok(allowlist.includes('probe'))
  for (const inspectAction of SPREADSHEET_INSPECT_ACTIONS) {
    const runtimeAction = {
      workbook: 'workbook_info', protection: 'worksheet_protection', preflight: 'write_preflight',
      filter: 'filter_state', charts: 'list_charts', pivots: 'list_pivots',
    }[inspectAction] ?? inspectAction
    assert.ok(allowlist.includes(runtimeAction), `spreadsheet inspect action '${inspectAction}' must be accepted by the content script`)
  }
})

test('the Extension background accepts every advertised spreadsheet write and never accepts model-controlled target fields', async () => {
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background/office-request-contract.ts', import.meta.url), 'utf8')
  const backgroundOperations = assignedArrayOnFirstMatchingLine(backgroundSource, (line) => line.includes('const OFFICE_SPREADSHEET_OPERATIONS:'), 'the Extension background spreadsheet operations')
  for (const operation of SPREADSHEET_WRITE_OPERATIONS) {
    assert.ok(backgroundOperations.includes(operation), `Native spreadsheet operation '${operation}' must be accepted by the Extension background`)
  }
  assert.match(backgroundSource, /message\.operation === undefined && message\.payload === undefined && message\.resource === undefined && message\.precondition === undefined/)
})

test('the content script accepts every light-document action the MCP surface advertises', async () => {
  const connectorSource = await readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8')
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background/office-request-contract.ts', import.meta.url), 'utf8')
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')

  const advertised = [
    ...arrayOnFirstMatchingLine(backgroundSource, (line) => line.includes("'read', 'search', 'selection'"), 'the background light_document action list'),
  ]
  const allowlist = arrayOnFirstMatchingLine(contentSource, (line) => line.includes("'read', 'search', 'selection', 'inspect_write'"), 'the content-script light-document allowlist')

  for (const action of new Set(advertised)) {
    assert.ok(allowlist.includes(action), `advertised light-document action '${action}' must be accepted by the content script allowlist`)
  }
})

test('the Extension background accepts every light-document operation the Native Connector can send', async () => {
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background/office-request-contract.ts', import.meta.url), 'utf8')

  const backgroundOperations = assignedArrayOnFirstMatchingLine(backgroundSource, (line) => line.includes('const OFFICE_DOCUMENT_OPERATIONS:'), 'the Extension background light-document operations')

  for (const operation of LIGHT_DOCUMENT_OPERATIONS) {
    assert.ok(backgroundOperations.includes(operation), `Native light-document operation '${operation}' must be accepted by the Extension background`)
  }
})

test('the content script grants light-document writes a longer budget than reads, under the native connector timeout', async () => {
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')
  const connectorSource = await readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8')

  const writeBudgetMatch = /\['inspect_write', 'write'\]\.includes\(String\(action\)\)\s*\?\s*(\d[\d_]*)/.exec(contentSource)
  assert.ok(writeBudgetMatch, 'the light-document dispatcher must define an explicit write timeout budget')
  const writeBudgetMs = Number(writeBudgetMatch[1].replace(/_/g, ''))
  const nativeTimeoutMatch = /const REQUEST_TIMEOUT_MS = (\d[\d_]*)/.exec(connectorSource)
  assert.ok(nativeTimeoutMatch, 'the native connector must define REQUEST_TIMEOUT_MS')
  const nativeTimeoutMs = Number(nativeTimeoutMatch[1].replace(/_/g, ''))
  const officeTimeoutMatch = /const OFFICE_REQUEST_TIMEOUT_MS = (\d[\d_]*)/.exec(connectorSource)
  assert.ok(officeTimeoutMatch, 'the native connector must define OFFICE_REQUEST_TIMEOUT_MS')
  const officeTimeoutMs = Number(officeTimeoutMatch[1].replace(/_/g, ''))

  // A write legitimately needs longer than a read (runtime APP wait +
  // CanvasPatch change poll + readback), but must stay under the office
  // Native cap so the extension answer never races a native abort.
  assert.ok(writeBudgetMs > 8_000, `write budget ${writeBudgetMs}ms must exceed the 8s read budget`)
  assert.ok(writeBudgetMs < officeTimeoutMs, `write budget ${writeBudgetMs}ms must stay under the office ${officeTimeoutMs}ms request timeout`)
  // Cold WebEdit reads sweep iframes for 8s then the in-frame runtime budgets
  // another 8s. The short REQUEST_TIMEOUT_MS must not abort that path.
  assert.ok(officeTimeoutMs >= 16_000, `office timeout ${officeTimeoutMs}ms must cover an 8s probe plus an 8s in-frame read`)
  assert.ok(officeTimeoutMs > nativeTimeoutMs, `office timeout ${officeTimeoutMs}ms must exceed the generic ${nativeTimeoutMs}ms request timeout`)
})

test('presentation write previews use the slow mutation-inspection budget end to end', async () => {
  const contentSource = await readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8')
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background/office/frame-routing.ts', import.meta.url), 'utf8')
  const connectorSource = await readFile(new URL('../apps/native-server/src/connector.mjs', import.meta.url), 'utf8')

  assert.match(contentSource, /const officeRuntimeBudgetMs = \(action: unknown\): number =>/)
  assert.match(contentSource, /\['inspect_write', 'write'\]\.includes\(String\(action\)\) \? 20_000 : 8_000/)
  assert.match(backgroundSource, /\['inspect_write', 'write'\]\.includes\(String\(message\?\.action\)\) \? OFFICE_FRAME_WRITE_OPERATION_MS_DEFAULT : OFFICE_FRAME_READ_OPERATION_MS_DEFAULT/)

  const frameWriteMs = Number(/const OFFICE_FRAME_WRITE_OPERATION_MS_DEFAULT = (\d[\d_]*)/.exec(backgroundSource)?.[1].replace(/_/g, ''))
  const nativeOfficeMs = Number(/const OFFICE_REQUEST_TIMEOUT_MS = (\d[\d_]*)/.exec(connectorSource)?.[1].replace(/_/g, ''))
  assert.ok(nativeOfficeMs > 8_000 + frameWriteMs, `native Office timeout ${nativeOfficeMs}ms must leave headroom above iframe discovery plus the ${frameWriteMs}ms frame write budget`)
})

test('Office reads and write previews do not queue behind Native start and restart work', async () => {
  const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const responder = /function respondToOfficeRequest[\s\S]*?\r?\n}\r?\n\r?\nasync function queueResourceWrite/.exec(backgroundSource)?.[0]
  assert.ok(responder, 'the Office request responder must remain discoverable')
  assert.doesNotMatch(responder, /queueNativeLifecycle\(execute\)/, 'a stale iframe request must not block later Office reads or previews behind the Native lifecycle queue')
  assert.match(responder, /void respond\(execute\(\)\)/, 'non-commit Office requests should execute directly')
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
