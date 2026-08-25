import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PRESENTATION_WRITE_OPERATIONS } from '../apps/native-server/src/connector-tool-catalog.mjs'

test('delivers Office requests and every page-world runtime to discovered WebEdit iframes', async () => {
  const [background, content, config, runtime, presentationRuntime] = await Promise.all([
    readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/entrypoints/office-read.content.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/wxt.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/public/office-light-document-runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/public/office-presentation-runtime.js', import.meta.url), 'utf8'),
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
  assert.match(config, /office-presentation-runtime\.js/)
  assert.match(content, /type === 'office-presentation\/v1'/)
  assert.match(content, /office-presentation-runtime\.js/)
  assert.match(content, /inspect_capabilities/)
  assert.match(content, /allFrames: true/)
  assert.match(runtime, /getDocXml/)
  assert.match(runtime, /insertContent/)
  assert.match(presentationRuntime, /ActivePresentation/)
  assert.match(presentationRuntime, /request\.action === 'inspect_capabilities'/)
})

test('keeps every model-facing presentation write operation aligned with a runtime capability and handler', async () => {
  const runtime = await readFile(new URL('../apps/chrome-extension/public/office-presentation-runtime.js', import.meta.url), 'utf8')
  for (const operation of PRESENTATION_WRITE_OPERATIONS) {
    assert.match(runtime, new RegExp(`${operation}:\\s*\\{\\s*actions:`), `${operation} must have a capability mapping`)
    assert.match(runtime, new RegExp(`operation === '${operation}'`), `${operation} must have a runtime handler`)
  }
})
