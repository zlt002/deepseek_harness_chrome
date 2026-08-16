import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SETTINGS_NAMESPACE,
  SkillSettingsController,
  claudeSkillRoots,
  modeFor,
  mountHostSkillSettings,
  normalizeSkillSettings,
  projectSkillCatalog,
  resolveInvocation,
  withSkillMode,
} from '../src/index.mjs'

test('three modes only reduce authored controls', () => {
  assert.deepEqual(resolveInvocation({ modelInvocable: true, userInvocable: true }, 'enabled'), { modelInvocable: true, userInvocable: true })
  assert.deepEqual(resolveInvocation({ modelInvocable: true, userInvocable: true }, 'manual-only'), { modelInvocable: false, userInvocable: true })
  assert.deepEqual(resolveInvocation({ modelInvocable: true, userInvocable: true }, 'disabled'), { modelInvocable: false, userInvocable: false })
  assert.deepEqual(resolveInvocation({ modelInvocable: false, userInvocable: false }, 'enabled'), { modelInvocable: false, userInvocable: false })
})

test('normalization ignores malformed values and a mode write preserves valid settings', () => {
  const normalized = normalizeSkillSettings({ modes: { good: 'manual-only', bad: 'open', alsoBad: 1 } })
  assert.deepEqual(normalized, { modes: { good: 'manual-only' } })
  assert.equal(modeFor(normalized, 'new-skill'), 'enabled')
  assert.deepEqual(withSkillMode(normalized, 'new-skill', 'disabled'), { modes: { good: 'manual-only', 'new-skill': 'disabled' } })
})

test('settings inspection includes disabled source skills while effective policy remains safe', () => {
  const projected = projectSkillCatalog([
    { name: 'visible', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'paused', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'author-hidden', invocation: { modelInvocable: false, userInvocable: true } },
  ], { modes: { paused: 'disabled', 'author-hidden': 'enabled' } })
  assert.deepEqual(projected.map(({ name, mode, invocation }) => ({ name, mode, invocation })), [
    { name: 'visible', mode: 'enabled', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'paused', mode: 'disabled', invocation: { modelInvocable: false, userInvocable: false } },
    { name: 'author-hidden', mode: 'enabled', invocation: { modelInvocable: false, userInvocable: true } },
  ])
})

test('controller serializes writes and hides the persistence adapter', async () => {
  let saved = { modes: {} }
  const controller = new SkillSettingsController({
    async read() { return saved },
    async write(next) { saved = next },
  })
  await controller.refresh()
  await Promise.all([controller.setMode('first', 'manual-only'), controller.setMode('second', 'disabled')])
  assert.deepEqual(controller.snapshot(), { modes: { first: 'manual-only', second: 'disabled' } })
})

test('Claude roots reuse the official custom skill directory configuration', () => {
  assert.deepEqual(claudeSkillRoots('/Users/example/'), ['/Users/example/.claude/skills'])
})

test('future Host adapter owns settings and registry lifecycle through two seams', () => {
  let resolve
  let settingsHandler
  const disposed = []
  const stop = mountHostSkillSettings({
    registerInvocationPolicy(next) { resolve = next; return () => disposed.push('policy') },
    registerSettings(namespace, defaults, next) {
      assert.equal(namespace, SETTINGS_NAMESPACE)
      assert.deepEqual(defaults, { modes: {} })
      settingsHandler = next
      return () => disposed.push('settings')
    },
  })
  settingsHandler({ modes: { check: 'manual-only' } })
  assert.deepEqual(resolve({ name: 'check', invocation: { modelInvocable: true, userInvocable: true } }), { modelInvocable: false, userInvocable: true })
  stop()
  assert.deepEqual(disposed, ['settings', 'policy'])
})
