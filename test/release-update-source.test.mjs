import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WINDOWS_LITE_SOURCE,
  fetchRelease,
  resolveReleaseSource,
} from '../apps/native-server/src/release-update/release-source.mjs'

test('uses the published source when no install root or override is available', async () => {
  assert.deepEqual(await resolveReleaseSource({ env: {} }), {
    packageUrl: DEFAULT_WINDOWS_LITE_SOURCE,
  })
})

test('accepts a streamed release response without Content-Length', async () => {
  const bytes = Buffer.from('PK\x03\x04fixture')
  const release = await fetchRelease(
    { packageUrl: 'https://example.test/release.zip' },
    async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/zip' }),
      arrayBuffer: async () => bytes,
    }),
  )
  assert.deepEqual(release.bytes, bytes)
})
