import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('keeps prototype preview as an out-of-tree, schema-only product package', async () => {
  const [manifest, schema, runtime, host] = await Promise.all([source('package.json'), source('src/prototype-document.ts'), source('src/client/TrustedPrototypeRuntime.tsx'), source('src/index.ts')])
  assert.match(manifest, /@accrui\/harness-ui-prototype-studio/)
  assert.match(manifest, /"inject"/)
  assert.match(schema, /ReferenceEvidenceV1/)
  assert.match(schema, /DesignSpecV1/)
  assert.match(schema, /PrototypeDocumentV1/)
  assert.match(schema, /PrototypeRevisionV1/)
  assert.match(schema, /'navigate' \| 'open-modal' \| 'close-modal' \| 'set-value' \| 'toggle' \| 'set-tab' \| 'submit-success'/)
  assert.match(runtime, /validatePrototypeBundle/)
  assert.match(schema, /validatePrototypeBundle/)
  assert.match(schema, /createTrustedRevision/)
  assert.match(schema, /verifyTrustedRevision/)
  assert.match(runtime, /data-prototype-element-id/)
  assert.match(host, /save_product_prototype/)
  assert.match(host, /PROTOTYPE_STUDIO_RESTORE_PATH/)
  assert.match(host, /targetRevisionId/)
  assert.match(host, /expectedCurrentRevisionId/)
  assert.match(host, /verified_write/)
  assert.doesNotMatch(`${schema}\n${runtime}`, /new Function|\beval\s*\(|innerHTML|deepseek-harness\/packages\/.*\/src/)
})
