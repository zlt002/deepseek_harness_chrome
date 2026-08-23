import assert from 'node:assert/strict'
import test from 'node:test'
import { assertStateModes, installConflictMessage, skillOrigin, statePermissions } from '../src/skill-origin.mjs'

const root = '/runtime/skills'
const installed = new Set(['user-skill'])

test('classifies only an exact marked product directory as user-installed', () => {
  assert.equal(skillOrigin({ name: 'user-skill', source: 'custom', resourceBase: { kind: 'directory', path: '/runtime/skills/user-skill' } }, root, installed), 'installed')
  assert.equal(skillOrigin({ name: 'pmd-prd', source: 'custom', resourceBase: { kind: 'directory', path: '/runtime/skills/pmd-prd' } }, root, installed), 'system')
  assert.equal(skillOrigin({ name: 'user-skill', source: 'custom', resourceBase: { kind: 'directory', path: '/Users/a/.claude/skills/user-skill' } }, root, installed), 'user')
  assert.equal(skillOrigin({ name: 'pptx', source: 'accrui-product-office', resourceBase: { kind: 'directory', path: '/runtime/skills/pptx' } }, root, installed), 'system')
  assert.equal(skillOrigin({ name: 'project-skill', source: 'project-agents' }, root, installed), 'project')
})

test('collision messages identify system skills without relying on display fields', () => {
  assert.match(installConflictMessage('pptx', 'system'), /系统内置/)
  assert.match(installConflictMessage('same-skill', 'custom'), /已发现技能/)
})

test('server source guard allows user and project modes but rejects a client-forged system mode write', () => {
  const systems = new Set(['pptx'])
  assert.doesNotThrow(() => assertStateModes({ 'user-skill': 'disabled', 'project-skill': 'manual-only' }, systems))
  assert.throws(() => assertStateModes({ pptx: 'disabled' }, systems), /系统内置/)
})

test('legacy system modes survive a user Skill update but cannot be changed', () => {
  const legacy = { 'pmd-prd': 'disabled' }
  const systems = new Set(['pmd-prd'])
  assert.doesNotThrow(() => assertStateModes({ 'pmd-prd': 'disabled', 'user-skill': 'manual-only' }, systems, legacy))
  assert.throws(() => assertStateModes({ 'pmd-prd': 'enabled', 'user-skill': 'manual-only' }, systems, legacy), /系统内置/)
})

test('state and deletion permissions remain separate for every origin', () => {
  assert.deepEqual(statePermissions('system'), { stateEditable: false })
  assert.deepEqual(statePermissions('user'), { stateEditable: true })
  assert.deepEqual(statePermissions('project'), { stateEditable: true })
  assert.deepEqual(statePermissions('installed'), { stateEditable: true })
})
