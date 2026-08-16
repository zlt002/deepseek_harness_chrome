import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('is an out-of-tree client plugin using public composer and sidebar slots', async () => {
  await access(new URL('package.json', root))
  const [manifest, client] = await Promise.all([source('package.json'), source('src/client/index.ts')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-browser-target"/)
  assert.match(client, /conversation\.input\.left/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.match(client, /sidebar\.footer\.action/)
  assert.match(client, /@deepseek-ai\/dsh-client-ui-sidebar/)
  assert.doesNotMatch(client, /sidebar\.compact\.action/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})
