import assert from 'node:assert/strict'
import test from 'node:test'
import { modesForSelection, refreshAfterDeletedSkill, updateSkillModes } from '../src/client/update-skill-modes.mjs'

test('bulk mode update sends one settings namespace patch', async () => {
  const updates = []
  const api = { settings: { async update(request) { updates.push(request); return { result: { ok: true, value: {} } } } } }
  await updateSkillModes(api, 'skill-settings', { first: 'enabled', second: 'enabled' }, 4)
  assert.deepEqual(updates, [{
    ns: 'skill-settings', patch: { modes: { first: 'enabled', second: 'enabled' } }, expectedRevision: 4,
  }])
})

test('bulk mode update describes once then retries a stale revision', async () => {
  const updates = []
  let calls = 0
  const api = { settings: {
    async update(request) {
      updates.push(request); calls += 1
      return calls === 1
        ? { result: { ok: false, error: { code: 'settings-conflict', message: 'settings moved' } } }
        : { result: { ok: true, value: {} } }
    },
    async describe() { return { result: { ok: true, value: { namespaces: [{ ns: 'skill-settings', revision: 9 }] } } } },
  } }
  await updateSkillModes(api, 'skill-settings', { first: 'disabled', second: 'disabled' }, 4)
  assert.deepEqual(updates, [
    { ns: 'skill-settings', patch: { modes: { first: 'disabled', second: 'disabled' } }, expectedRevision: 4 },
    { ns: 'skill-settings', patch: { modes: { first: 'disabled', second: 'disabled' } }, expectedRevision: 9 },
  ])
})

test('deletion refresh resets only the deleted name to enabled through settings', async () => {
  const updates = []
  const api = { settings: { async update(request) { updates.push(request); return { result: { ok: true, value: {} } } } } }
  await refreshAfterDeletedSkill(api, 'skill-settings', 'removed-skill', 5)
  assert.deepEqual(updates, [{
    ns: 'skill-settings', patch: { modes: { 'removed-skill': 'enabled' } }, expectedRevision: 5,
  }])
})

test('bulk selection writes only selected names, including manual-only', () => {
  const skills = [{ name: 'first-skill' }, { name: 'second-skill' }, { name: 'third-skill' }]
  assert.deepEqual(modesForSelection(skills, new Set(['first-skill', 'third-skill']), 'manual-only'), {
    'first-skill': 'manual-only', 'third-skill': 'manual-only',
  })
  assert.deepEqual(modesForSelection(skills, new Set(), 'enabled'), {})
})
