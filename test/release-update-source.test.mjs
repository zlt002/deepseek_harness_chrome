import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  DEFAULT_WINDOWS_LITE_ZIP_URL,
  fetchRelease,
  resolveReleaseSource,
} from '../apps/native-server/src/release-update/release-source.mjs'
import { checkUpdate } from '../apps/native-server/src/release-update/index.mjs'

const manifestBytes = value => Buffer.from(JSON.stringify(value))
const packageUrl = 'https://github.com/zlt002/deepseek_harness_chrome/releases/download/windows-lite-v1.1.86/accr-ui-windows-lite-x64.zip'
const streamBody = (chunks, { onCancel } = {}) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk)
    controller.close()
  },
  cancel: onCancel,
})

test('checks the single Midea GitLab ZIP by metadata without downloading it', async () => {
  assert.equal(
    DEFAULT_WINDOWS_LITE_ZIP_URL,
    'https://git.midea.com/zhanglt21/claudecodeuibox/-/raw/main/accr-ui-windows-lite-x64.zip',
  )
  let downloaded = false
  const update = await checkUpdate({
    currentPackageId: 'W/"old-package"',
    env: {},
    fetchImpl: async (input, options) => {
      assert.equal(String(input), DEFAULT_WINDOWS_LITE_ZIP_URL)
      assert.equal(options.method, 'HEAD')
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: 'W/"new-package"', 'last-modified': 'Tue, 01 Sep 2026 12:00:00 GMT' }),
        arrayBuffer: async () => { downloaded = true; throw new Error('check must not download ZIP bytes') },
      }
    },
  })
  assert.equal(downloaded, false)
  assert.deepEqual(update, {
    available: true,
    packageId: 'W/"new-package"',
    lastModified: 'Tue, 01 Sep 2026 12:00:00 GMT',
    packageUrl: DEFAULT_WINDOWS_LITE_ZIP_URL,
  })
})

test('accepts a direct single-ZIP override without a separately uploaded SHA file', async () => {
  assert.deepEqual(
    await resolveReleaseSource({ env: { ACCRUI_WINDOWS_LITE_UPDATE_URL: 'https://example.test/release.zip' } }),
    { packageUrl: 'https://example.test/release.zip' },
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

test('manifest update checks compare the signed release identity without downloading its ZIP', async () => {
  const result = await checkUpdate({
    currentVersion: '1.1.85',
    env: { ACCRUI_WINDOWS_LITE_UPDATE_MANIFEST_URL: 'https://example.test/release.json' },
    fetchImpl: async input => {
      assert.equal(String(input), 'https://example.test/release.json')
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: streamBody([manifestBytes({
          format: 'accr-ui-windows-lite-update-v1',
          releaseUrl: 'https://example.test/releases/1.1.86',
          version: '1.1.86',
          sha256: 'a'.repeat(64),
          packageUrl: 'https://example.test/accr-ui-windows-lite-x64.zip',
        })]),
      }
    },
  })
  assert.deepEqual(result, {
    available: true,
    version: '1.1.86',
    sha256: 'a'.repeat(64),
    packageUrl: 'https://example.test/accr-ui-windows-lite-x64.zip',
    releaseUrl: 'https://example.test/releases/1.1.86',
  })
})

test('release source honours an already-cancelled caller signal', async () => {
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(
    resolveReleaseSource({
      env: { ACCRUI_WINDOWS_LITE_UPDATE_MANIFEST_URL: 'https://example.test/release.json' },
      signal: controller.signal,
      fetchImpl: async (_input, options) => {
        assert.equal(options.signal.aborted, true)
        throw options.signal.reason
      },
    }),
    /caller cancelled/,
  )
})
