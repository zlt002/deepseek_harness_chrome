import assert from 'node:assert/strict'
import test from 'node:test'
import { enableInstalledSkill } from '../src/client/enable-installed-skill.mjs'

test('retries an enabled-mode write once with the current Settings revision', async () => {
  const updates = []
  let calls = 0
  const api = {
    settings: {
      async update(request) {
        updates.push(request)
        calls += 1
        return calls === 1
          ? { result: { ok: false, error: { code: 'settings-conflict', message: 'settings moved' } } }
          : { result: { ok: true, value: {} } }
      },
      async describe() { return { result: { ok: true, value: { namespaces: [{ ns: 'skill-settings', revision: 9 }] } } } },
    },
  }
  await enableInstalledSkill(api, 'skill-settings', 'fresh-skill', 4)
  assert.deepEqual(updates, [
    { ns: 'skill-settings', patch: { modes: { 'fresh-skill': 'enabled' } }, expectedRevision: 4 },
    { ns: 'skill-settings', patch: { modes: { 'fresh-skill': 'enabled' } }, expectedRevision: 9 },
  ])
})

test('does not hide a rejected enabled-mode write', async () => {
  const api = { settings: { async update() { return { result: { ok: false, error: { code: 'settings-rejected', message: 'read-only' } } } } } }
  await assert.rejects(enableInstalledSkill(api, 'skill-settings', 'fresh-skill', 1), /read-only/)
})
