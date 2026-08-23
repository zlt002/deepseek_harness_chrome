import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Prototype Studio restore is limited to its authorized extension page', async () => {
  const source = await readFile(new URL('../background.ts', import.meta.url), 'utf8')
  assert.match(source, /const PROTOTYPE_STUDIO_RESTORE_PATH = '\/api\/prototype-studio\/restore'/)
  assert.match(source, /request\.type === 'prototype-studio-restore\/v1'/)
  assert.match(source, /isPrototypeStudioSender\(sender, request\.projectId\)/)
  assert.match(source, /prototypeStudioAuthorization\(request\.projectId\)/)
  assert.match(source, /targetRevisionId: request\.targetRevisionId, expectedCurrentRevisionId: request\.expectedCurrentRevisionId/)
  assert.match(source, /Prototype Studio authorization expired\. Capture the reference page again\./)
})
