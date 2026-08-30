import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  DEFAULT_WINDOWS_LITE_MANIFEST_URL,
  fetchRelease,
  resolveReleaseSource,
} from '../apps/native-server/src/release-update/release-source.mjs'

const manifestBytes = value => Buffer.from(JSON.stringify(value))
const packageUrl = 'https://github.com/zlt002/deepseek_harness_chrome/releases/download/windows-lite-v1.1.86/accr-ui-windows-lite-x64.zip'
const streamBody = (chunks, { onCancel } = {}) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk)
    controller.close()
  },
  cancel: onCancel,
})

test('uses a validated published release manifest when no install root or override is available', async () => {
  assert.match(DEFAULT_WINDOWS_LITE_MANIFEST_URL, /releases\/download\/windows-lite-current\//)
  const source = await resolveReleaseSource({
    env: {},
    fetchImpl: async input => {
      assert.equal(String(input), DEFAULT_WINDOWS_LITE_MANIFEST_URL)
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: streamBody([manifestBytes({
          format: 'accr-ui-windows-lite-update-v1',
          releaseUrl: 'https://github.com/zlt002/deepseek_harness_chrome/releases/tag/windows-lite-v1.1.86',
          version: '1.1.86',
          sha256: 'a'.repeat(64),
          packageUrl,
        })]),
        arrayBuffer: async () => { throw new Error('manifest must not use arrayBuffer') },
      }
    },
  })
  assert.deepEqual(source, {
    packageUrl,
    expectedSha256: 'a'.repeat(64),
    expectedVersion: '1.1.86',
    releaseUrl: 'https://github.com/zlt002/deepseek_harness_chrome/releases/tag/windows-lite-v1.1.86',
  })
})

test('fails closed when a direct override omits its SHA256', async () => {
  await assert.rejects(
    resolveReleaseSource({ env: { ACCRUI_WINDOWS_LITE_UPDATE_URL: 'https://example.test/release.zip' } }),
    /SHA256/,
  )
})

test('fails closed when a published manifest omits required integrity metadata', async () => {
  await assert.rejects(
    resolveReleaseSource({
      env: { ACCRUI_WINDOWS_LITE_UPDATE_MANIFEST_URL: 'https://example.test/release.json' },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: streamBody([manifestBytes({
          format: 'accr-ui-windows-lite-update-v1',
          releaseUrl: 'https://github.com/example/repo/releases/tag/windows-lite-v1.1.86',
          packageUrl: 'https://example.test/release.zip',
          version: '1.1.86',
        })]),
      }),
    }),
    /SHA256/,
  )
})

test('cancels an oversized chunked manifest before buffering more than 64 KiB', async () => {
  let cancelled = false
  let signal
  const chunks = [Buffer.alloc(64 * 1024), Buffer.from('x')]
  let chunkIndex = 0
  await assert.rejects(
    resolveReleaseSource({
      env: { ACCRUI_WINDOWS_LITE_UPDATE_MANIFEST_URL: 'https://example.test/release.json' },
      fetchImpl: async (_input, options) => {
        signal = options.signal
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream({
            pull(controller) { controller.enqueue(chunks[chunkIndex++]) },
            cancel() { cancelled = true },
          }),
          arrayBuffer: async () => { throw new Error('manifest must not use arrayBuffer') },
        }
      },
    }),
    /大小无效或超过/,
  )
  assert.equal(cancelled, true)
  assert.equal(signal.aborted, true)
})

test('aborts a real chunked manifest fetch and reports the 64 KiB limit', async () => {
  let response
  let responseClosed
  const responseClosedPromise = new Promise(resolve => { responseClosed = resolve })
  const server = createServer((_request, nextResponse) => {
    response = nextResponse
    response.once('close', () => responseClosed(!response.writableEnded))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write(Buffer.alloc(64 * 1024))
    setTimeout(() => response.write('x'), 20)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const { port } = server.address()
    await assert.rejects(
      resolveReleaseSource({
        env: { ACCRUI_WINDOWS_LITE_UPDATE_MANIFEST_URL: 'https://example.test/release.json' },
        fetchImpl: (_input, options) => fetch(`http://127.0.0.1:${port}/manifest.json`, options),
      }),
      /65536/,
    )
    let timeoutId
    try {
      await Promise.race([
        responseClosedPromise.then(aborted => {
          assert.equal(aborted, true, 'the local server connection must close before its response ends')
        }),
        new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('manifest request was not aborted')), 1_000) }),
      ])
    } finally {
      clearTimeout(timeoutId)
    }
  } finally {
    response?.destroy()
    server.close()
    await once(server, 'close')
  }
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
