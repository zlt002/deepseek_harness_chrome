import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { OfficeDocumentWriteRecordStore } from '../apps/native-server/src/office/office-document-write-record-store.mjs'
import { SPREADSHEET_INSPECT_ACTIONS, SPREADSHEET_WRITE_OPERATIONS } from '../apps/native-server/src/transport/connector-tool-catalog.mjs'

async function call(endpoint, name, arguments_, id = 1) {
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

function writeStore() { return new OfficeDocumentWriteRecordStore({ recordPath: join(tmpdir(), `dsh-spreadsheet-${randomUUID()}.json`) }) }

test('publishes the former WebEdit spreadsheet profile through strict read actions and challenge-only writes', () => {
  const writes = [
    'set_values', 'set_formula', 'clear', 'format', 'apply_table_style', 'clear_formats', 'merge', 'unmerge',
    'row_height', 'column_width', 'insert_rows', 'insert_columns', 'delete_rows', 'delete_columns', 'insert_cells', 'delete_cells',
    'fill_range', 'auto_fill', 'auto_fit', 'set_rows_hidden', 'set_columns_hidden', 'sort', 'set_auto_filter', 'clear_filters', 'apply_filter',
    'replace_range_text', 'text_to_columns', 'remove_duplicates', 'copy_range', 'move_range', 'paste_special', 'set_data_validation',
    'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_comment', 'delete_comments', 'add_conditional_format',
    'clear_conditional_formats', 'insert_cell_image', 'create_defined_name', 'delete_defined_name', 'activate_worksheet', 'sheet_add',
    'sheet_rename', 'copy_worksheet', 'move_worksheet', 'set_worksheet_visibility', 'sheet_delete', 'undo', 'redo', 'recalculate',
    'create_chart', 'update_chart', 'set_chart_data_source', 'resize_chart', 'delete_chart', 'create_pivot_table', 'refresh_pivot_tables',
    'add_pivot_field', 'remove_pivot_field', 'refresh_pivot_table', 'delete_pivot_table', 'sort_pivot_field', 'set_pivot_subtotals',
    'set_pivot_value_function', 'set_pivot_show_values_as', 'export_pdf', 'export_range_image', 'export_worksheet_image', 'set_zoom',
    'set_freeze_panes', 'set_print_settings', 'set_outline_group', 'batch_write',
  ]
  for (const operation of writes) assert.ok(SPREADSHEET_WRITE_OPERATIONS.includes(operation), `missing ${operation}`)
  assert.deepEqual(SPREADSHEET_INSPECT_ACTIONS, [
    'active_sheet', 'selection', 'used_range', 'workbook', 'sheets', 'view', 'protection', 'preflight', 'filter', 'filter_values',
    'range_features', 'special_cells', 'charts', 'chart', 'pivots', 'pivot', 'pivot_field_items', 'defined_names', 'print_settings',
    'outline', 'dimensions', 'capabilities', 'debug_runtime', 'probe_range_api',
  ])
})

test('routes bounded spreadsheet reads and commit-only Verified Writes through the fixed Browser Target', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 91, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/91?id=91' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'webedit:budget-sheet1' }
  const requests = []
  const connector = new BrowserConnector({
    officeDocumentWriteStore: writeStore(),
    requestExtension: (request) => {
      requests.push(request)
      const result = request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1', values: [[42]] }, observed: { range: 'A1', values: [[42]], verified: true } }
        : request.action === 'inspect_write'
          ? { status: 'ok', resource, precondition: { version: 2, targets: [{ range: 'A1', state: { values: [[1]] } }] } }
      : request.action === 'context'
            ? { status: 'ok', resource, context: { workbookName: '预算.xlsx', activeSheet: 'Sheet1', readOnly: false } }
            : request.action === 'range'
              ? { status: 'ok', resource, range: { address: 'A1', values: [[1]], formulas: [['']] } }
              : request.action === 'search'
                ? { status: 'ok', resource, search: { range: 'A1:B2', query: request.query, matches: [], total: 0, offset: 0, limit: 100, hasMore: false } }
                : { status: 'ok', resource, inspected: { action: request.action, range: request.range ?? null } }
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
        browserTarget: request.browserTarget, result,
      }))
    },
  })
  connector.bindBrowserTarget('spreadsheet-run', target)
  const endpoint = await connector.start()
  try {
    const context = await call(endpoint, 'spreadsheet_get_context', {})
    assert.equal(context.result.structuredContent.context.activeSheet, 'Sheet1')
    const range = await call(endpoint, 'spreadsheet_read_range', { range: 'A1', sheetName: 'Sheet1' }, 2)
    assert.deepEqual(range.result.structuredContent.range.values, [[1]])
    const search = await call(endpoint, 'spreadsheet_search', { query: '42', range: 'A1:B2', searchBy: 'values' }, 3)
    assert.equal(search.result.structuredContent.search.query, '42')
    const inspected = await call(endpoint, 'spreadsheet_inspect', { action: 'range_features', range: 'A1:B2' }, 31)
    assert.equal(inspected.result.structuredContent.inspected.action, 'range_features')
    assert.equal(requests.at(-1).action, 'range_features')
    const filtered = await call(endpoint, 'spreadsheet_inspect', { action: 'filter', range: 'A1:B2' }, 32)
    assert.equal(filtered.result.structuredContent.inspected.action, 'filter_state')
    assert.equal(requests.at(-1).action, 'filter_state')
    const charts = await call(endpoint, 'spreadsheet_inspect', { action: 'charts' }, 33)
    assert.equal(charts.result.structuredContent.inspected.action, 'list_charts')
    assert.equal(requests.at(-1).action, 'list_charts')
    const probe = await call(endpoint, 'spreadsheet_inspect', { action: 'probe_range_api', range: 'A1' }, 34)
    assert.equal(probe.result.structuredContent.inspected.action, 'probe_range_api')
    assert.equal(requests.at(-1).action, 'probe_range_api')

    const preview = await call(endpoint, 'spreadsheet_write_preview', { operation: 'set_values', payload: { range: 'A1', values: [[42]] } }, 4)
    assert.equal(preview.result.structuredContent.action, 'inspect_write')
    assert.equal(typeof preview.result.structuredContent.challenge, 'string')
    assert.equal(Object.hasOwn(preview.result.structuredContent, 'precondition'), false)
    assert.equal(preview.result.structuredContent.summary.operation, 'set_values')
    assert.deepEqual(preview.result.structuredContent.summary.confirmation.values, { rows: 1, columns: 1, cellCount: 1, cells: [[42]], truncated: false })
    assert.deepEqual(preview.result.structuredContent.summary.confirmation.target, { range: 'A1' })
    const challenge = preview.result.structuredContent.challenge
    const invalidCommit = await call(endpoint, 'spreadsheet_write_commit', { challenge, operation: 'clear' }, 5)
    assert.equal(invalidCommit.error.code, -32602)
    const committed = await call(endpoint, 'spreadsheet_write_commit', { challenge }, 6)
    assert.equal(committed.result.structuredContent.status, 'verified_write')
    assert.equal(requests.at(-1).tool, 'spreadsheet')
    assert.equal(requests.at(-1).action, 'write')
    assert.equal(requests.at(-1).operation, 'set_values')
    assert.deepEqual(requests.at(-1).resource, resource)
    assert.deepEqual(requests.at(-1).precondition, { version: 2, targets: [{ range: 'A1', state: { values: [[1]] } }], resourceFingerprint: resource.fingerprint })
    const replay = await call(endpoint, 'spreadsheet_write_commit', { challenge }, 7)
    assert.equal(replay.result.isError, true)

    const rejectedTarget = await call(endpoint, 'spreadsheet_inspect', { action: 'used_range', browserTarget: target }, 8)
    assert.equal(rejectedTarget.error.code, -32602)
  } finally {
    await connector.stop()
  }
})

test('spreadsheet previews expose concrete analytics/filter/format targets and reject an incomplete chart target', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 191, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/191?id=191' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-preview-191' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      result: { status: 'ok', resource, operation: request.operation, precondition: { version: 2 }, summary: { operation: request.operation } },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-preview-details-run', target)
  const endpoint = await connector.start()
  try {
    const chart = await call(endpoint, 'spreadsheet_write_preview', { operation: 'create_chart', payload: { range: 'A1:B5', chartType: 'columnClustered', left: 1, top: 2, width: 30, height: 20 } })
    assert.equal(chart.result.isError, undefined)
    assert.deepEqual(chart.result.structuredContent.summary.confirmation.chart, { chartType: 'columnClustered', left: 1, top: 2, width: 30, height: 20 })
    assert.equal(chart.result.structuredContent.summary.confirmation.target.range, 'A1:B5')
    const pivot = await call(endpoint, 'spreadsheet_write_preview', { operation: 'set_pivot_value_function', payload: { pivotTableId: 7, fieldName: '销售额', summaryFunction: 'sum' } }, 2)
    assert.deepEqual(pivot.result.structuredContent.summary.confirmation.pivot, { pivotTableId: 7, fieldName: '销售额', summaryFunction: 'sum' })
    const filter = await call(endpoint, 'spreadsheet_write_preview', { operation: 'apply_filter', payload: { range: 'A1:B9', field: 1, criteria: '华东' } }, 3)
    assert.deepEqual(filter.result.structuredContent.summary.confirmation.filter, { field: 1, criteria: '华东' })
    const incomplete = await call(endpoint, 'spreadsheet_write_preview', { operation: 'create_chart', payload: { range: 'A1:B5' } }, 4)
    assert.equal(incomplete.error.code, -32602)
  } finally { await connector.stop() }
})

test('rejects a write response without same-resource verified readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 92, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/92?id=92' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'webedit:budget-sheet1' }
  const connector = new BrowserConnector({
    officeDocumentWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      result: request.action === 'inspect_write'
        ? { status: 'ok', resource, precondition: { version: 2, targets: [] } }
        : { status: 'verified_write', resource: { ...resource, sheetName: 'Sheet2', fingerprint: 'webedit:budget-sheet2' }, operation: request.operation, requested: { range: 'A1', values: [[42]] }, observed: { verified: true } },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-readback-run', target)
  const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'spreadsheet_write_preview', { operation: 'set_values', payload: { range: 'A1', values: [[42]] } })
    const committed = await call(endpoint, 'spreadsheet_write_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(committed.result.isError, true)
    assert.match(committed.result.content[0].text, /invalid spreadsheet result/)
  } finally {
    await connector.stop()
  }
})

test('accepts only an explicit worksheet transition inside the approved workbook', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 193, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/193?id=193' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-1' }
  for (const [operation, returned, expected] of [
    ['activate_worksheet', { ...resource, sheetName: 'Sheet2', fingerprint: 'sheet-2' }, false],
    ['activate_worksheet', { ...resource, workbookName: '其他.xlsx', sheetName: 'Sheet2', fingerprint: 'other-2' }, true],
    ['set_values', { ...resource, sheetName: 'Sheet2', fingerprint: 'sheet-2' }, true],
  ]) {
    const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      result: request.action === 'inspect_write'
        ? { status: 'ok', resource, operation, precondition: { version: 2, resourceFingerprint: resource.fingerprint } }
        : { status: 'verified_write', resource: returned, operation, requested: { sheetName: 'Sheet2' }, observed: { verified: true } },
    })) })
    connector.bindBrowserTarget(`sheet-transition-${operation}-${returned.workbookName}`, target); const endpoint = await connector.start()
    try {
      const payload = operation === 'activate_worksheet' ? { sheetName: 'Sheet2' } : { range: 'A1', values: [[1]] }
      const preview = await call(endpoint, 'spreadsheet_write_preview', { operation, payload })
      const commit = await call(endpoint, 'spreadsheet_write_commit', { challenge: preview.result.structuredContent.challenge }, 2)
      assert.equal(Boolean(commit.result.isError), expected, `${operation}:${returned.workbookName}`)
    } finally { await connector.stop() }
  }
})

test('keeps a bounded spreadsheet write_incomplete diagnostic through the Native Connector', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 195, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/195?id=195' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-195' }
  const details = { operation: 'add_comment', observed: { range: { address: 'A1', comment: { text: '现有批注', author: '李四' } } }, rollbackComplete: false }
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
    ...(request.action === 'inspect_write'
      ? { result: { status: 'ok', resource, operation: request.operation, precondition: { version: 2, resourceFingerprint: resource.fingerprint }, summary: {} } }
      : { error: { code: 'write_incomplete', message: 'The comment write could not be fully read back.', details } }),
  })) })
  connector.bindBrowserTarget('spreadsheet-write-incomplete-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'spreadsheet_write_preview', { operation: 'add_comment', payload: { range: 'A1', text: '新批注' } })
    const commit = await call(endpoint, 'spreadsheet_write_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(commit.result.isError, true)
    assert.match(commit.result.content[0].text, /"code":"write_incomplete"/)
    assert.match(commit.result.content[0].text, /"author":"李四"/)
  } finally { await connector.stop() }
})

test('workbook-wide and batch spreadsheet confirmations remain concrete without a range', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 194, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/194?id=194' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-194' }
  const connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result: { status: 'ok', resource, operation: request.operation, precondition: { version: 2 }, summary: {} } })) })
  connector.bindBrowserTarget('spreadsheet-workbook-preview', target); const endpoint = await connector.start()
  try {
    const print = await call(endpoint, 'spreadsheet_write_preview', { operation: 'set_print_settings', payload: { orientation: 'landscape' } })
    assert.deepEqual(print.result.structuredContent.summary.confirmation.target, { scope: 'active_workbook' })
    const batch = await call(endpoint, 'spreadsheet_write_preview', { operation: 'batch_write', payload: { cells: [{ range: 'A1', values: [[1]] }, { address: 'B2', value: 'ok' }] } }, 2)
    assert.deepEqual(batch.result.structuredContent.summary.confirmation.batch, { cellCount: 2, cells: [{ address: 'A1', values: { rows: 1, columns: 1, cellCount: 1, cells: [[1]], truncated: false } }, { address: 'B2', value: 'ok' }], truncated: false })
  } finally { await connector.stop() }
})
