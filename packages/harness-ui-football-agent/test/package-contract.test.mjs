import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('football agent is an out-of-tree client plugin that only adds a public composer slot', async () => {
  const [manifest, client, bridge, protocol, productManifest] = await Promise.all([
    source('../package.json'),
    source('../src/client/index.ts'),
    source('../src/client/football-agent-bridge.ts'),
    source('../src/client/protocol.js'),
    source('../../../apps/native-server/src/product-plugin-manifest.mjs'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-football-agent/)
  assert.match(client, /conversation\.composer\.above/)
  assert.match(client, /id: 'accrui-football-agent'/)
  assert.doesNotMatch(client, /conversation\.presentation|conversation\.session|sidebar\./)
  assert.match(productManifest, /harness-ui-football-agent/)
  assert.match(bridge, /window\.parent\.postMessage\([^,]+, this\.parentOrigin\)/)
  assert.match(protocol, /event\.source !== parent \|\| event\.origin !== parentOrigin/)
  assert.match(protocol, /football-agent\/context/)
  assert.match(protocol, /football-agent\/request-analysis/)
  assert.match(protocol, /football-agent\/open-records/)
  assert.doesNotMatch(`${client}\n${bridge}\n${protocol}`, /deepseek-harness\/packages\/.*\/src/)
})
