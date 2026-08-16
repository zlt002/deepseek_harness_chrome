import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('declares an out-of-tree scope plugin against public composer contracts only', async () => {
  await access(new URL('package.json', root))
  const [manifest, client] = await Promise.all([source('package.json'), source('src/client/index.ts')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-knowledge-scope"/)
  assert.match(client, /conversation\.composer\.above/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})
