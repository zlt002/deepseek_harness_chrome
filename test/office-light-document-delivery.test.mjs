import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('delivers light-document requests to the discovered WebEdit iframe instead of the doc.midea top frame', async () => {
  const [background, content, config, runtime] = await Promise.all([
    readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8'),
    readFile(new URL('../entrypoints/office-read.content.ts', import.meta.url), 'utf8'),
    readFile(new URL('../wxt.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../public/office-light-document-runtime.js', import.meta.url), 'utf8'),
  ])
  assert.match(background, /type: 'office-document\/v1'/)
  assert.match(background, /\{ frameId: frame\.frameId \}/)
  assert.match(background, /isOfficeDocumentRequest/)
  assert.match(content, /type === 'office-document\/v1'/)
  assert.match(content, /office-light-document-runtime\.js/)
  assert.match(config, /'https:\/\/doc\.midea\.com\/\*'/)
  assert.match(config, /'https:\/\/webedit\.midea\.com\/\*'/)
  assert.match(content, /allFrames: true/)
  assert.match(runtime, /getDocXml/)
  assert.match(runtime, /insertContent/)
})
