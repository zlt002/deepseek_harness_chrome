import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePastedFileUrls } from '../src/client/file-url-paste.js'

test('decodes encoded UTF-8 only in standalone file URLs pasted into surrounding text', () => {
  const pasted = '根据 file:///D:/Users/baomx4/%E7%89%A9%E6%B5%81Agent/%E6%96%B9%E6%A1%88.html 更新页面'
  assert.equal(
    decodePastedFileUrls(pasted),
    '根据 file:///D:/Users/baomx4/物流Agent/方案.html 更新页面',
  )
})

test('keeps ordinary URLs, ordinary text, malformed encodings, and embedded file prefixes unchanged', () => {
  const text = 'https://example.test/%E4%B8%AD%E6%96%87 ordinary 100% file:///D:/%E4%ZZ xfile:///D:/%E4%B8%AD'
  assert.equal(decodePastedFileUrls(text), text)
})
