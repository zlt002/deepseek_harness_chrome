import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserConnector } from '../native-server/src/connector.mjs'
import { OfficeSpreadsheetWriteRecordStore } from '../native-server/src/office-spreadsheet-write-record-store.mjs'

function writeStore() { return new OfficeSpreadsheetWriteRecordStore({ recordPath: join(tmpdir(), `dsh-spreadsheet-${randomUUID()}.json`) }) }
function writePrecondition(range = 'A1') {
  const match = range.match(/^([A-Z])(\d+)(?::([A-Z])(\d+))?$/); const rows = Number(match[4] ?? match[2]) - Number(match[2]) + 1; const columns = (match[3] ?? match[1]).charCodeAt(0) - match[1].charCodeAt(0) + 1
  const values = Array.from({ length: rows }, () => Array(columns).fill(null)); const formulas = Array.from({ length: rows }, () => Array(columns).fill(null))
  return { version: 1, range, state: { values, formulas, merged: false, filter: null, rowHeight: null, columnWidth: null, format: { bold: false, italic: false, underline: false, size: 11, name: 'Arial', color: '#000000', fill: '#FFFFFF', numberFormat: 'General', alignment: 'general', wrap: false } } }
}
function multiRangePrecondition(first = 'A1', second = 'B1') {
  const state = writePrecondition(first).state
  return { version: 2, targets: [{ range: first, state }, { range: second, state }] }
}
function spreadsheetState(values, formulas = values.map((row) => row.map(() => ''))) { return { ...writePrecondition().state, values, formulas } }
function p0Precondition(operation) {
  if (operation === 'replace_range_text') return { version: 2, targets: [{ range: 'A1', state: spreadsheetState([['a']]) }] }
  if (operation === 'text_to_columns') return { version: 2, targets: [{ range: 'A1', state: spreadsheetState([['a,b']]) }, { range: 'A1:B1', state: spreadsheetState([['a,b', null]]) }] }
  if (operation === 'remove_duplicates') return { version: 2, targets: [{ range: 'A1:B2', state: spreadsheetState([['a', 1], ['a', 1]]) }] }
  return { version: 2, targets: [{ range: 'A1:B2', state: spreadsheetState([['a', 1], ['b', 2]]) }, { range: 'C1:D2', state: spreadsheetState([[null, null], [null, null]]) }] }
}

async function call(endpoint, arguments_, id = 1) {
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'office_spreadsheet', arguments: arguments_ } }),
  })
  return response.json()
}

test('requires a bound one-time spreadsheet inspection grant and returns the verified write readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 21, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', values: [[42]] }, observed: { range: 'A1', values: [[42]], verified: true } }
        : { status: 'ok', resource, precondition: writePrecondition(request.payload.range), context: { workbookName: 'Budget.xlsx' } },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-write-run', target)
  const endpoint = await connector.start()
  try {
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'set_values', payload: { range: 'A1', values: [[42]] } })
    const grant = inspected.result.structuredContent.challenge
    const write = { action: 'write', challenge: grant, idempotencyIdentity: 'spreadsheet-1', resource, operation: 'set_values', payload: { range: 'A1', values: [[42]] } }
    const written = await call(endpoint, write, 2)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.deepEqual(written.result.structuredContent.observed, { range: 'A1', values: [[42]], verified: true })

    const replay = await call(endpoint, write, 3)
    assert.equal(replay.result.isError, true)
    assert.match(replay.result.content[0].text, /challenge/i)
  } finally { await connector.stop() }
})

test('rejects an invalid or mismatched spreadsheet extension readback instead of claiming a write succeeded', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 22, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write' ? { status: 'verified_write', resource, operation: 'set_values', requested: { range: 'A1', values: [[1]] }, observed: { range: 'A1', values: [[2]] } } : { status: 'ok', resource, precondition: writePrecondition(request.payload.range), context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-readback-run', target)
  const endpoint = await connector.start()
  try {
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'set_values', payload: { range: 'A1', values: [[1]] } })
    const response = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'spreadsheet-mismatch', resource, operation: 'set_values', payload: { range: 'A1', values: [[1]] } }, 2)
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('rejects a verified write from an identically named but different spreadsheet fingerprint', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 25, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'different-workbook-instance' }, operation: 'set_values', requested: { range: 'A1', values: [[9]] }, observed: { range: 'A1', values: [[9]], verified: true } }
        : { status: 'ok', resource, precondition: writePrecondition(request.payload.range), context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-resource-fingerprint-run', target)
  const endpoint = await connector.start()
  try {
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'set_values', payload: { range: 'A1', values: [[9]] } })
    const response = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'spreadsheet-resource-fingerprint', resource, operation: 'set_values', payload: { range: 'A1', values: [[9]] } }, 2)
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('rejects generic spreadsheet write attestations for structural and filter-clear operations', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 24, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: request.payload.range, clear: true }, observed: { range: request.payload.range, verified: true, after: { operator: 'equals' } } }
        : { status: 'ok', resource, precondition: writePrecondition(request.payload.range), context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-generic-attestation-run', target)
  const endpoint = await connector.start()
  const write = async (operation, payload, id) => {
    const inspected = await call(endpoint, { action: 'inspect_write', operation, payload }, id)
    return call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: `generic-${operation}`, resource, operation, payload }, id + 1)
  }
  try {
    const structural = await call(endpoint, { action: 'inspect_write', operation: 'insert_rows', payload: { range: '1:1' } }, 1)
    assert.equal(structural.error.code, -32602)
    const exportAttempt = await call(endpoint, { action: 'inspect_write', operation: 'export_pdf', payload: { range: 'A1' } }, 2)
    assert.equal(exportAttempt.error.code, -32602)
    const unclearedFilters = await write('clear_filters', { range: 'A1:B2' }, 3)
    assert.equal(unclearedFilters.result.isError, true)
    assert.match(unclearedFilters.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('forwards only inspected multi-range preconditions and verifies all four P0 operations', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 29, url: 'https://doc.midea.com/sheets/p0' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'P0.xlsx', sheetName: 'Sheet1', fingerprint: 'p0-sheet' }
  const forwarded = []
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => {
      if (request.action === 'write') forwarded.push(request)
      const result = request.action !== 'write' ? { status: 'ok', resource, precondition: p0Precondition(request.operation) } : (() => {
        if (request.operation === 'replace_range_text') return { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', what: 'a', replacement: 'b', matchEntireCell: false, matchCase: false, allowFormulaChanges: false }, observed: { range: 'A1', values: [['b']], formulas: [['']], replacementCount: 1, verified: true } }
        if (request.operation === 'text_to_columns') return { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', outputRange: 'A1:B1', delimiter: 'comma', consecutiveDelimiter: false }, observed: { range: 'A1', outputRange: 'A1:B1', values: [['a', 'b']], formulas: [['', '']], verified: true } }
        if (request.operation === 'remove_duplicates') return { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1:B2', columns: [1], hasHeader: false }, observed: { range: 'A1:B2', values: [['a', 1], [null, null]], formulas: [['', ''], ['', '']], duplicateRowsRemoved: 1, verified: true } }
        return { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1:B2', destination: 'C1', outputRange: 'C1:D2' }, observed: { range: 'A1:B2', outputRange: 'C1:D2', sourceBlank: true, sourceValues: [[null, null], [null, null]], sourceFormulas: [['', ''], ['', '']], values: [['a', 1], ['b', 2]], formulas: [['', ''], ['', '']], format: { bold: false, italic: false, underline: false, size: 11, name: 'Arial', color: '#000000', fill: '#FFFFFF', numberFormat: 'General', alignment: 'general', wrap: false }, merged: false, verified: true } }
      })()
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result })
    }),
  })
  connector.bindBrowserTarget('spreadsheet-p0-run', target); const endpoint = await connector.start()
  const requests = [
    ['replace_range_text', { range: 'A1', what: 'a', replacement: 'b' }],
    ['text_to_columns', { range: 'A1', delimiter: 'comma' }],
    ['remove_duplicates', { range: 'A1:B2', columns: [1], hasHeader: false }],
    ['move_range', { range: 'A1:B2', destination: 'C1' }],
  ]
  try {
    for (const [operation, payload] of requests) {
      const inspected = await call(endpoint, { action: 'inspect_write', operation, payload })
      const written = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: `p0-${operation}`, resource, operation, payload })
      assert.equal(written.result.structuredContent.status, 'verified_write')
    }
    assert.equal(forwarded.length, 4); assert.deepEqual(forwarded.map((request) => request.precondition.targets.length), [1, 2, 1, 2])
  } finally { await connector.stop() }
})

test('rejects forged P0 observations and v2 targets that do not match the approved operation footprint', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 30, url: 'https://doc.midea.com/sheets/p0-adversarial' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'P0.xlsx', sheetName: 'Sheet1', fingerprint: 'p0-adversarial' }
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => {
      const result = request.action === 'inspect_write'
        ? { status: 'ok', resource, precondition: request.operation === 'set_values' ? { ...writePrecondition('A1:B2'), state: { ...writePrecondition('A1:B2').state, values: [[null]], formulas: [[null]] } } : request.operation === 'remove_duplicates' ? { ...p0Precondition('remove_duplicates'), targets: [{ ...p0Precondition('remove_duplicates').targets[0], state: { ...p0Precondition('remove_duplicates').targets[0].state, values: [['a', 1]], formulas: [['', '']] } }] } : request.operation === 'move_range' ? { ...p0Precondition('move_range'), targets: [p0Precondition('move_range').targets[0], { ...p0Precondition('move_range').targets[1], range: 'B1:C2' }] } : p0Precondition('replace_range_text') }
        : request.operation === 'replace_range_text'
          ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', what: 'a', replacement: 'b', matchEntireCell: false, matchCase: false, allowFormulaChanges: false }, observed: { range: 'A1', values: [['b']], formulas: [['']], replacementCount: 99, verified: true } }
          : { status: 'verified_write', resource, operation: request.operation, requested: {}, observed: {} }
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result })
    }),
  })
  connector.bindBrowserTarget('spreadsheet-p0-adversarial', target); const endpoint = await connector.start()
  const write = async (operation, payload, id) => {
    const inspected = await call(endpoint, { action: 'inspect_write', operation, payload }, id)
    return call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: `adversarial-${operation}`, resource, operation, payload }, id + 1)
  }
  try {
    const forgedCount = await write('replace_range_text', { range: 'A1', what: 'a', replacement: 'b' }, 1)
    assert.equal(forgedCount.result.isError, true)
    const wrongTargets = await call(endpoint, { action: 'inspect_write', operation: 'move_range', payload: { range: 'A1:B2', destination: 'C1' } }, 3)
    assert.equal(wrongTargets.result.isError, true)
    const wrongMatrix = await call(endpoint, { action: 'inspect_write', operation: 'set_values', payload: { range: 'A1:B2', values: [[1, 2], [3, 4]] } }, 4)
    assert.equal(wrongMatrix.result.isError, true)
    const wrongV2Matrix = await call(endpoint, { action: 'inspect_write', operation: 'remove_duplicates', payload: { range: 'A1:B2', columns: [1], hasHeader: false } }, 5)
    assert.equal(wrongV2Matrix.result.isError, true)
  } finally { await connector.stop() }
})

test('rejects move_range preconditions with same-cell, partial-overlap, and duplicate targets', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 31, url: 'https://doc.midea.com/sheets/p0-overlap' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'P0.xlsx', sheetName: 'Sheet1', fingerprint: 'p0-overlap' }
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => {
      const base = p0Precondition('move_range'); const destinationTarget = request.payload.destination === 'A2' ? 'A2:B3' : 'A1:B2'
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, precondition: { ...base, targets: [base.targets[0], { ...base.targets[1], range: destinationTarget }] } } })
    }),
  })
  connector.bindBrowserTarget('spreadsheet-p0-overlap', target); const endpoint = await connector.start()
  try {
    for (const destination of ['A1', 'A2', 'C1']) {
      const response = await call(endpoint, { action: 'inspect_write', operation: 'move_range', payload: { range: 'A1:B2', destination } })
      assert.equal(response.result.isError, true)
    }
  } finally { await connector.stop() }
})

test('keeps oversized verified spreadsheet writes successful with a bounded response', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 23, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  let valueBytes = 16 * 1024
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', values: [[Buffer.alloc(valueBytes, 1).toString('base64')]] }, observed: { range: 'A1', values: [[Buffer.alloc(valueBytes, 1).toString('base64')]], verified: true } }
        : { status: 'ok', resource, precondition: writePrecondition(request.payload.range), context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-large-write-run', target)
  const endpoint = await connector.start()
  const write = async (identity, id) => {
    const values = [[Buffer.alloc(valueBytes, 1).toString('base64')]]
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'set_values', payload: { range: 'A1', values } }, id)
    return call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, resource, operation: 'set_values', payload: { range: 'A1', values } }, id + 1)
  }
  try {
    const compact = await write('spreadsheet-large-small', 1)
    assert.equal(compact.result.isError, undefined)
    assert.equal(compact.result.structuredContent.status, 'verified_write')

    valueBytes = 72 * 1024
    const oversized = await write('spreadsheet-large-oversized', 3)
    assert.equal(oversized.result.isError, undefined)
    assert.equal(oversized.result.structuredContent.status, 'verified_write')
    assert.equal(oversized.result.structuredContent.observed.verified, true)
    assert.equal(oversized.result.structuredContent.observed.values, undefined)
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') <= 128 * 1024)
  } finally { await connector.stop() }
})

test('validates data-validation schema, range features, and independently rejects forged validation readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 34, url: 'https://doc.midea.com/sheets/validation' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Validation.xlsx', sheetName: 'Sheet1', fingerprint: 'validation-sheet' }
  const payload = { range: 'A1', validationType: 'list', formula1: '"A,B"', formula2: '', showError: false, errorTitle: 'Invalid' }
  const expected = { type: 3, alertStyle: 1, operator: 1, formula1: '"A,B"', formula2: '', ignoreBlank: true, showError: false, errorTitle: 'Invalid', errorMessage: '' }
  let forge = false
  const connector = new BrowserConnector({
    officeSpreadsheetWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => {
      const baseline = writePrecondition('A1'); const precondition = { ...baseline, state: { ...baseline.state, validation: null, merged: false, filter: { operator: 'none' }, rowHeight: 15, columnWidth: 8, format: { bold: false, italic: false, underline: false, size: 11, name: 'Arial', color: '#000000', fill: '#FFFFFF', numberFormat: 'General', alignment: 'general', wrap: false } } }
      const result = request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', validation: expected }, observed: { range: 'A1', validation: forge ? { ...expected, showError: true } : expected, state: { ...precondition.state, validation: expected }, verified: true } }
        : request.action === 'range_features'
          ? { status: 'ok', resource, rangeFeatures: { range: 'A1', supported: true, validation: null } }
          : { status: 'ok', resource, precondition }
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result })
    }),
  })
  connector.bindBrowserTarget('spreadsheet-validation-run', target); const endpoint = await connector.start()
  try {
    const invalid = await call(endpoint, { action: 'inspect_write', operation: 'set_data_validation', payload: { range: 'A1', validationType: 'unknown', formula1: 'x' } })
    assert.equal(invalid.error.code, -32602)
    const missingSecondFormula = await call(endpoint, { action: 'inspect_write', operation: 'set_data_validation', payload: { range: 'A1', validationType: 'wholeNumber', formula1: '1' } })
    assert.equal(missingSecondFormula.error.code, -32602)
    const features = await call(endpoint, { action: 'range_features', range: 'A1' })
    assert.deepEqual(features.result.structuredContent.rangeFeatures, { range: 'A1', supported: true, validation: null })
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'set_data_validation', payload })
    const success = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'validation-success', resource, operation: 'set_data_validation', payload })
    assert.equal(success.result.structuredContent.status, 'verified_write')
    forge = true
    const second = await call(endpoint, { action: 'inspect_write', operation: 'set_data_validation', payload })
    const rejected = await call(endpoint, { action: 'write', challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'validation-forged', resource, operation: 'set_data_validation', payload })
    assert.equal(rejected.result.isError, true)
    assert.match(rejected.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('verifies complete hyperlink collection deltas independently of browser attestations', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 35, url: 'https://doc.midea.com/sheets/hyperlinks' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Links.xlsx', sheetName: 'Sheet1', fingerprint: 'links-sheet' }
  const payload = { range: 'A1', url: 'https://example.com/', subAddress: '', textToDisplay: 'Example' }; const expected = { url: 'https://example.com/', subAddress: '', textToDisplay: 'Example' }
  const baseline = writePrecondition('A1'); const precondition = { ...baseline, state: { ...baseline.state, validation: null, hyperlinks: [], merged: false, filter: { operator: 'none' }, rowHeight: 15, columnWidth: 8, format: { bold: false, italic: false, underline: false, size: 11, name: 'Arial', color: '#000000', fill: '#FFFFFF', numberFormat: 'General', alignment: 'general', wrap: false } } }
  const item = { address: expected.url, subAddress: '', textToDisplay: 'Example', name: 'Link1', type: 'hyperlink' }; let forge = false
  const connector = new BrowserConnector({ officeSpreadsheetWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    const links = forge ? [{ ...item, textToDisplay: 'Wrong' }] : [item]
    const result = request.action === 'write'
      ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', hyperlink: expected }, observed: { range: 'A1', hyperlinks: links, newItem: links[0], state: { ...precondition.state, hyperlinks: links }, verified: true } }
      : { status: 'ok', resource, precondition }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result })
  }) })
  connector.bindBrowserTarget('spreadsheet-hyperlink-run', target); const endpoint = await connector.start()
  try {
    const dangerous = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, url: 'data:text/html,unsafe' } }); assert.equal(dangerous.error.code, -32602)
    for (const subAddress of ['javascript:alert(1)', '[Other.xlsx]Sheet1!A1', 'Sheet1!A1:javascript']) {
      const invalidReference = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, url: '', subAddress } }); assert.equal(invalidReference.error.code, -32602)
    }
    const invalidCombinedReference = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, subAddress: 'javascript:alert(1)' } }); assert.equal(invalidCombinedReference.error.code, -32602)
    const sheetReference = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, url: '', subAddress: "'Sales 2026'!$A$1:$B$2", textToDisplay: 'Sales' } }); assert.equal(sheetReference.error, undefined)
    const namedReference = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, url: '', subAddress: 'QuarterlySales', textToDisplay: 'Quarterly sales' } }); assert.equal(namedReference.error, undefined)
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload }); const success = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'hyperlink-success', resource, operation: 'add_hyperlink', payload }); assert.equal(success.result.structuredContent.status, 'verified_write')
    forge = true
    const second = await call(endpoint, { action: 'inspect_write', operation: 'add_hyperlink', payload }); const rejected = await call(endpoint, { action: 'write', challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'hyperlink-forged', resource, operation: 'add_hyperlink', payload }); assert.equal(rejected.result.isError, true); assert.match(rejected.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('verifies hyperlink delete-all against the complete inspected collection', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 36, url: 'https://doc.midea.com/sheets/hyperlinks-delete' }; const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Links.xlsx', sheetName: 'Sheet1', fingerprint: 'links-delete' }
  const item = { address: 'https://example.com/', subAddress: '', textToDisplay: 'Example', name: 'Link1', type: 'hyperlink' }; const baseline = writePrecondition('A1'); const precondition = { ...baseline, state: { ...baseline.state, validation: null, hyperlinks: [item], merged: false, filter: { operator: 'none' }, rowHeight: 15, columnWidth: 8, format: { bold: false, italic: false, underline: false, size: 11, name: 'Arial', color: '#000000', fill: '#FFFFFF', numberFormat: 'General', alignment: 'general', wrap: false } } }
  const connector = new BrowserConnector({ officeSpreadsheetWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: request.action === 'write' ? { status: 'verified_write', resource, operation: 'delete_hyperlinks', requested: { range: 'A1', delete: true }, observed: { range: 'A1', hyperlinks: [], state: { ...precondition.state, hyperlinks: [] }, verified: true } } : { status: 'ok', resource, precondition } })) })
  connector.bindBrowserTarget('spreadsheet-hyperlink-delete', target); const endpoint = await connector.start()
  try {
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'delete_hyperlinks', payload: { range: 'A1' } }); const deleted = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'hyperlink-delete', resource, operation: 'delete_hyperlinks', payload: { range: 'A1' } }); assert.equal(deleted.result.structuredContent.status, 'verified_write')
  } finally { await connector.stop() }
})

test('validates conditional-format schema and independently verifies complete collection deltas', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 37, url: 'https://doc.midea.com/sheets/conditional-formats' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Formats.xlsx', sheetName: 'Sheet1', fingerprint: 'formats-sheet' }
  const payload = { range: 'A1', conditionType: 'cellValue', operator: 'between', formula1: '1', formula2: '9', fillColor: '#FF0000', fontColor: '#00FF00', bold: true, italic: false }
  const expected = { type: 1, operator: 1, formula1: '1', formula2: '9', fillColor: '#FF0000', fontColor: '#00FF00', bold: true, italic: false }
  const baseline = writePrecondition('A1'); const precondition = { ...baseline, state: { ...baseline.state, conditionalFormats: [], merged: false, filter: { operator: 'none' }, rowHeight: 15, columnWidth: 8, format: { bold: false, italic: false, underline: false, size: 11, name: 'Arial', color: '#000000', fill: '#FFFFFF', numberFormat: 'General', alignment: 'general', wrap: false } } }
  const item = { ...expected, priority: 1 }; let forge = false
  const connector = new BrowserConnector({ officeSpreadsheetWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    const formats = forge ? [{ ...item, formula1: 'wrong' }] : [item]
    const result = request.action === 'write'
      ? request.operation === 'clear_conditional_formats'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', clear: true }, observed: { range: 'A1', conditionalFormats: [], state: { ...precondition.state, conditionalFormats: [] }, verified: true } }
        : { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', conditionalFormat: expected }, observed: { range: 'A1', conditionalFormats: formats, newItem: formats[0], state: { ...precondition.state, conditionalFormats: formats }, verified: true } }
      : { status: 'ok', resource, precondition }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result })
  }) })
  connector.bindBrowserTarget('spreadsheet-conditional-format-run', target); const endpoint = await connector.start()
  try {
    const missingFormula2 = await call(endpoint, { action: 'inspect_write', operation: 'add_conditional_format', payload: { ...payload, formula2: undefined } }); assert.equal(missingFormula2.error.code, -32602)
    const invalidColor = await call(endpoint, { action: 'inspect_write', operation: 'add_conditional_format', payload: { ...payload, fillColor: 'red' } }); assert.equal(invalidColor.error.code, -32602)
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'add_conditional_format', payload }); const success = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'conditional-format-success', resource, operation: 'add_conditional_format', payload }); assert.equal(success.result.structuredContent.status, 'verified_write')
    forge = true
    const second = await call(endpoint, { action: 'inspect_write', operation: 'add_conditional_format', payload }); const rejected = await call(endpoint, { action: 'write', challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'conditional-format-forged', resource, operation: 'add_conditional_format', payload }); assert.equal(rejected.result.isError, true); assert.match(rejected.result.content[0].text, /invalid verified spreadsheet write/i)
    const clearInspection = await call(endpoint, { action: 'inspect_write', operation: 'clear_conditional_formats', payload: { range: 'A1' } }); const cleared = await call(endpoint, { action: 'write', challenge: clearInspection.result.structuredContent.challenge, idempotencyIdentity: 'conditional-format-clear', resource, operation: 'clear_conditional_formats', payload: { range: 'A1' } }); assert.equal(cleared.result.structuredContent.status, 'verified_write')
  } finally { await connector.stop() }
})

test('validates and independently verifies view zoom preconditions', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 38, url: 'https://doc.midea.com/sheets/view' }; const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'View.xlsx', sheetName: 'Sheet1', fingerprint: 'view-sheet' }
  const view = { sheetName: 'Sheet1', activeCell: 'A1', freezePanes: false, splitRow: 0, splitColumn: 0, zoom: 100, scrollRow: 1, scrollColumn: 1 }; const precondition = { version: 4, view }; let forge = false
  const connector = new BrowserConnector({ officeSpreadsheetWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: request.action === 'write' ? { status: 'verified_write', resource, operation: 'set_zoom', requested: { zoom: 125 }, observed: { view: { ...view, zoom: 125, ...(forge ? { scrollRow: 2 } : {}) }, verified: true } } : { status: 'ok', resource, precondition } })) })
  connector.bindBrowserTarget('spreadsheet-view-run', target); const endpoint = await connector.start()
  try {
    const invalid = await call(endpoint, { action: 'inspect_write', operation: 'set_zoom', payload: { zoom: 9 } }); assert.equal(invalid.error.code, -32602)
    const inspected = await call(endpoint, { action: 'inspect_write', operation: 'set_zoom', payload: { zoom: 125 } }); const success = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'view-zoom-success', resource, operation: 'set_zoom', payload: { zoom: 125 } }); assert.equal(success.result.structuredContent.status, 'verified_write')
    forge = true; const second = await call(endpoint, { action: 'inspect_write', operation: 'set_zoom', payload: { zoom: 125 } }); const rejected = await call(endpoint, { action: 'write', challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'view-zoom-forged', resource, operation: 'set_zoom', payload: { zoom: 125 } }); assert.equal(rejected.result.isError, true)
  } finally { await connector.stop() }
})

test('validates and independently verifies print and outline write contracts', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 39, url: 'https://doc.midea.com/sheets/print' }; const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Print.xlsx', sheetName: 'Sheet1', fingerprint: 'print-sheet' }
  const settings = { sheetName: 'Sheet1', printArea: '', printTitleRows: '', printTitleColumns: '', orientation: 'portrait', zoom: 100, fitToPagesWide: 1, fitToPagesTall: 1, centerHorizontally: false, centerVertically: false, leftMargin: 36, rightMargin: 36, topMargin: 36, bottomMargin: 36, headerMargin: 18, footerMargin: 18 }; const printPrecondition = { version: 5, printSettings: settings }; const outlinePrecondition = { version: 6, outline: { sheetName: 'Sheet1', range: '1:2', axis: 'row', levels: [0, 0] } }; let forge = false
  const connector = new BrowserConnector({ officeSpreadsheetWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => { const result = request.action === 'write' ? request.operation === 'set_print_settings' ? { status: 'verified_write', resource, operation: request.operation, requested: { leftMargin: 40 }, observed: { printSettings: { ...settings, leftMargin: 40, ...(forge ? { rightMargin: 37 } : {}) }, verified: true } } : { status: 'verified_write', resource, operation: request.operation, requested: { range: '1:2', axis: 'row', grouped: true }, observed: { outline: { ...outlinePrecondition.outline, levels: forge ? [1, 0] : [1, 1] }, verified: true } } : { status: 'ok', resource, precondition: request.operation === 'set_print_settings' ? printPrecondition : outlinePrecondition }; connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result }) }) })
  connector.bindBrowserTarget('spreadsheet-print-run', target); const endpoint = await connector.start()
  try {
    const invalid = await call(endpoint, { action: 'inspect_write', operation: 'set_print_settings', payload: { zoom: 100, fitToPagesWide: 1 } }); assert.equal(invalid.error.code, -32602)
    const print = await call(endpoint, { action: 'inspect_write', operation: 'set_print_settings', payload: { leftMargin: 40 } }); const success = await call(endpoint, { action: 'write', challenge: print.result.structuredContent.challenge, idempotencyIdentity: 'print-success', resource, operation: 'set_print_settings', payload: { leftMargin: 40 } }); assert.equal(success.result.structuredContent.status, 'verified_write')
    const outline = await call(endpoint, { action: 'inspect_write', operation: 'set_outline_group', payload: { range: '1:2', axis: 'row', grouped: true } }); const grouped = await call(endpoint, { action: 'write', challenge: outline.result.structuredContent.challenge, idempotencyIdentity: 'outline-success', resource, operation: 'set_outline_group', payload: { range: '1:2', axis: 'row', grouped: true } }); assert.equal(grouped.result.structuredContent.status, 'verified_write')
    forge = true; const second = await call(endpoint, { action: 'inspect_write', operation: 'set_print_settings', payload: { leftMargin: 40 } }); const rejected = await call(endpoint, { action: 'write', challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'print-forged', resource, operation: 'set_print_settings', payload: { leftMargin: 40 } }); assert.equal(rejected.result.isError, true)
  } finally { await connector.stop() }
})
