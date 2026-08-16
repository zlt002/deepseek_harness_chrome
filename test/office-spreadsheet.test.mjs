import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserConnector } from '../native-server/src/connector.mjs'
import { OfficeSpreadsheetWriteRecordStore } from '../native-server/src/office-spreadsheet-write-record-store.mjs'

function writeStore() { return new OfficeSpreadsheetWriteRecordStore({ recordPath: join(tmpdir(), `dsh-spreadsheet-${randomUUID()}.json`) }) }
function writePrecondition(range = 'A1') {
  return { version: 1, range, state: { values: [[null]], formulas: [[null]], merged: null, filter: null, rowHeight: null, columnWidth: null, format: { bold: null, italic: null, underline: null, size: null, name: null, color: null, fill: null, numberFormat: null, alignment: null, wrap: null } } }
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
