import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('delivers light-document requests to the discovered WebEdit iframe instead of the doc.midea top frame', async () => {
  const [background, content, config, runtime] = await Promise.all([
    readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/wxt.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/public/office-light-document-runtime.js', import.meta.url), 'utf8'),
  ])
  assert.match(background, /type: 'office-document\/v1'/)
  assert.match(background, /sendToWebEditFrame\(request\.browserTarget\.tabId, frames/)
  assert.match(background, /const OFFICE_CONTENT_SCRIPT_FILES = \['content-scripts\/office-read\.js'\]/)
  assert.match(background, /isOfficeDocumentRequest/)
  assert.match(content, /type === 'office-document\/v1'/)
  assert.match(content, /office-light-document-runtime\.js/)
  assert.match(config, /'https:\/\/doc\.midea\.com\/\*'/)
  assert.match(config, /'https:\/\/webedit\.midea\.com\/\*'/)
  assert.match(config, /web_accessible_resources/)
  assert.match(config, /office-light-document-runtime\.js/)
  assert.match(config, /office-read-runtime\.js/)
  assert.match(config, /office-spreadsheet-runtime\.js/)
  assert.match(content, /allFrames: true/)
  assert.match(runtime, /getDocXml/)
  assert.match(runtime, /insertContent/)
})
