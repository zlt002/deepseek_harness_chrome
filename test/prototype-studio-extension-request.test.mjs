import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

async function loadExtensionRequest() {
  const sourceUrl = new URL('../apps/chrome-extension/entrypoints/prototype-studio/extension-request.ts', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const compiled = await bundleTypescript(source, sourceUrl)
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

test('Prototype Studio stops waiting when the extension never replies', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: () => {},
      get lastError() { return undefined },
    },
  }
  try {
    const { extensionRequest } = await loadExtensionRequest()
    await assert.rejects(
      extensionRequest({ type: 'prototype-studio-snapshot/v1' }, 20),
      /扩展后台响应超时/,
    )
  } finally {
    delete globalThis.chrome
  }
})
