import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('keeps local-file paste decoding in a product plugin over the public generic seam', async () => {
  const [manifest, client, seam] = await Promise.all([
    source('../package.json'),
    source('../src/client/index.ts'),
    source('../../../upstream-contributions/0024-composer-paste-text-transforms.patch'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-file-url-paste/)
  assert.match(client, /composerPasteTextTransforms/)
  assert.match(client, /decodePastedFileUrls/)
  assert.match(seam, /ComposerPasteTextTransforms/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})
