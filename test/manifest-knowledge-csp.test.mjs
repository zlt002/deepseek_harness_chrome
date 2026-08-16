import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('MV3 manifest source permits the Knowledge Platform for requests', async () => {
  const config = await readFile(new URL('../wxt.config.ts', import.meta.url), 'utf8')
  assert.match(config, /'\*:\/\/\*\.annto\.com\/\*'/)
  assert.match(config, /connect-src[^"\n]*https:\/\/anapi-uat\.annto\.com/)
})
