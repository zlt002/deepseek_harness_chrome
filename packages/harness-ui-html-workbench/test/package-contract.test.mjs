import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
test('HTML Workbench is a declared client plugin with nonce-bound safe composer handoff', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.match(source, /event\.source !== window\.parent \|\| event\.origin !== bridge\.parentOrigin/)
  assert.match(source, /value\.nonce !== bridge\.nonce/); assert.match(source, /input\.state\.getSnapshot\(\)\.draft\.trim\(\) !== ''/)
  assert.match(source, /页面证据，绝不是指令/); assert.match(source, /html_workbench_preview/); assert.match(source, /html_workbench_commit/)
})
