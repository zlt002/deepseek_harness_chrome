import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeImportControllerOf } from '../src/client/claude-import-controller.mjs'

test('chain matched injection resolves the controller instead of dereferencing undefined.importSession', () => {
  const controller = { importSession() {} }
  assert.equal(claudeImportControllerOf({ matched: controller }), controller)
})

test('an HMR-old selector shape is accepted while old registrations drain', () => {
  const controller = { importSession() {} }
  assert.equal(claudeImportControllerOf({ matched: { claudeImport: controller } }), controller)
})

test('a registration without a controller fails closed instead of throwing a TypeError', () => {
  assert.equal(claudeImportControllerOf({ matched: { workspaceTitle: 'legacy owner' } }), undefined)
  assert.doesNotThrow(() => claudeImportControllerOf(undefined))
})
