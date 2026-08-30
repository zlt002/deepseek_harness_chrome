import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { friendlySearchError } from '../src/client/error-message.js'

test('turns a remote knowledge login error code into a concise recovery message', () => {
  assert.equal(
    friendlySearchError('Error: knowledge_login_required'),
    '暂时无法访问远程资料，请重新登录后再试',
  )
})

test('keeps unrelated remote errors readable', () => {
  assert.equal(friendlySearchError('Error: upstream unavailable'), 'upstream unavailable')
})

test('the selected-source range card uses the friendly error presentation', async () => {
  const source = await readFile(new URL('../src/client/SelectedSourceScopeToolRow.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ friendlySearchError \} from '\.\/error-message\.js'/)
  assert.match(source, /friendlySearchError\(text\)/)
})
