import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'

const targetFor = (url) => ({ browser: 'chrome', windowId: 4, tabId: 12, url })
const domFingerprint = 'a'.repeat(64)
const anchor = { selector: '#selected', structurePath: ['p#selected'], fingerprint: 'b'.repeat(64), text: 'Selected', outerHTML: '<p id="selected">Selected</p>' }
const style = (color) => [{ selector: '#selected', computedStyle: { display: 'block', visibility: 'visible', color, backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', width: '100px', height: '20px' } }]

async function call(endpoint, name, arguments_, id) {
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

async function withWorkspace(run, initialCss = '#selected { color: rgb(1, 2, 3); }') {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'dsh-html-workbench-'))
  const htmlPath = join(directory, 'page.html'); const cssPath = join(directory, 'page.css')
  await writeFile(htmlPath, '<link rel="stylesheet" href="page.css"><p id="selected">Selected</p>')
  await writeFile(cssPath, initialCss)
  try { await run({ url: pathToFileURL(htmlPath).href, htmlPath, cssPath }) } finally { await rm(directory, { recursive: true, force: true }) }
}

function connectorFor(url, { selections = [anchor], before = style('rgb(1, 2, 3)'), after = style('rgb(4, 5, 6)') } = {}) {
  const target = targetFor(url)
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
    result: request.action === 'refresh_readback'
      ? { verified: true, url, sourceFingerprint: request.expectedSourceFingerprint, stylesheetFingerprints: request.expectedStylesheets, anchorStates: after }
      : { domFingerprint, selections, anchorStates: before },
  })) })
  connector.bindBrowserTarget('html-workbench-run', target)
  return connector
}

async function previewAndCommit(connector, endpoint, edits) {
  const preview = await call(endpoint, 'html_workbench_preview', { edits }, 1)
  const challenge = preview.result?.structuredContent?.challenge
  if (!challenge) return { preview }
  return { preview, commit: await call(endpoint, 'html_workbench_commit', { challenge }, 2) }
}

test('CSS commits without a selected anchor fail before atomic mutation', async () => {
  await withWorkspace(async ({ url, cssPath }) => {
    const connector = connectorFor(url, { selections: [], before: [], after: [] }); const endpoint = await connector.start()
    try {
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content: '#selected { color: rgb(4, 5, 6); }' }])
      assert.equal(result.preview.result.isError, true)
      assert.match(result.preview.result.content[0].text, /selected DOM anchor/i)
      assert.equal(await readFile(cssPath, 'utf8'), '#selected { color: rgb(1, 2, 3); }')
    } finally { await connector.stop() }
  })
})

test('HTML-only commits without a selected anchor retain HTML readback behaviour', async () => {
  await withWorkspace(async ({ url, htmlPath }) => {
    const connector = connectorFor(url, { selections: [], before: [], after: [] }); const endpoint = await connector.start()
    try {
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.html', content: '<p>Updated</p>' }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
      assert.equal(await readFile(htmlPath, 'utf8'), '<p>Updated</p>')
    } finally { await connector.stop() }
  })
})

test('CSS commits with an equivalent computed color still verify after exact stylesheet readback', async () => {
  await withWorkspace(async ({ url }) => {
    const unchanged = style('rgb(1, 2, 3)')
    const connector = connectorFor(url, { before: unchanged, after: unchanged }); const endpoint = await connector.start()
    try {
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content: '#selected { color: #010203; }' }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
    } finally { await connector.stop() }
  })
})

test('CSS commits adding an inherited-equivalent property verify after exact stylesheet readback', async () => {
  await withWorkspace(async ({ url, cssPath }) => {
    const unchanged = style('rgb(1, 2, 3)')
    const connector = connectorFor(url, { before: unchanged, after: unchanged }); const endpoint = await connector.start()
    try {
      const content = '#selected { color: rgb(1, 2, 3); background-color: transparent; }'
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
      assert.equal(await readFile(cssPath, 'utf8'), content)
    } finally { await connector.stop() }
  })
})

test('CSS commits deleting a declaration with the same inherited value verify after exact stylesheet readback', async () => {
  await withWorkspace(async ({ url, cssPath }) => {
    const unchanged = style('rgb(1, 2, 3)')
    const connector = connectorFor(url, { before: unchanged, after: unchanged }); const endpoint = await connector.start()
    try {
      const content = '#selected { }'
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
      assert.equal(await readFile(cssPath, 'utf8'), content)
    } finally { await connector.stop() }
  })
})

test('CSS commits verify after the selected-anchor computed style changes', async () => {
  await withWorkspace(async ({ url }) => {
    const connector = connectorFor(url); const endpoint = await connector.start()
    try {
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content: '#selected { color: rgb(4, 5, 6); }' }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
    } finally { await connector.stop() }
  })
})

test('CSS commits whose changed property is not among the sampled computed fields still verify from the loaded stylesheet hash', async () => {
  await withWorkspace(async ({ url, cssPath }) => {
    const unchanged = style('rgb(1, 2, 3)')
    const connector = connectorFor(url, { before: unchanged, after: unchanged }); const endpoint = await connector.start()
    try {
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content: '#selected { color: rgb(1, 2, 3); margin: 24px; }' }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
      assert.equal(await readFile(cssPath, 'utf8'), '#selected { color: rgb(1, 2, 3); margin: 24px; }')
    } finally { await connector.stop() }
  })
})

test('CSS commits ignore unchanged sampled declarations when only an unsampled property changes', async () => {
  await withWorkspace(async ({ url, cssPath }) => {
    const unchanged = style('rgb(1, 2, 3)')
    const connector = connectorFor(url, { before: unchanged, after: unchanged }); const endpoint = await connector.start()
    try {
      const result = await previewAndCommit(connector, endpoint, [{ path: 'page.css', content: '#selected { color: rgb(1, 2, 3); margin: 9px; }' }])
      assert.equal(result.commit.result.structuredContent.status, 'verified_write')
      assert.equal(await readFile(cssPath, 'utf8'), '#selected { color: rgb(1, 2, 3); margin: 9px; }')
    } finally { await connector.stop() }
  }, '#selected { color: rgb(1, 2, 3); margin: 1px; }')
})
