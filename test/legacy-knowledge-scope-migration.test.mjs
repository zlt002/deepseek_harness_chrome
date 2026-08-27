import assert from 'node:assert/strict'
import test from 'node:test'

import {
  legacyKnowledgeScopeKey,
  migrateLegacyKnowledgeScope,
} from '../apps/chrome-extension/src/legacy-knowledge-scope.mjs'

test('migrates one legacy AccrUI session scope without deleting repository selections', () => {
  assert.equal(legacyKnowledgeScopeKey('session-a'), 'knowledge-query:scope:session:session-a')
  assert.deepEqual(migrateLegacyKnowledgeScope({
    enabled: false,
    scope: {
      hasCommon: false,
      repoKeys: ['repo-b', 'repo-a', 'repo-a'],
      domains: { order: { self: true, systems: ['otp', 'oms', 'otp'] } },
    },
  }), {
    enabled: false,
    scope: { domainSystems: { order: ['otp', 'oms'] }, repositoryIds: ['repo-b', 'repo-a'] },
  })
})

test('preserves all legacy knowledge categories with their own systems', () => {
  assert.deepEqual(migrateLegacyKnowledgeScope({
    hasCommon: true,
    repoKeys: ['repo-a'],
    domains: {
      first: { self: true, systems: ['one'] },
      second: { self: false, systems: ['two'] },
    },
  }), {
    enabled: true,
    scope: { domainSystems: { first: ['one'], second: ['two'] }, repositoryIds: ['repo-a'] },
  })
})

test('rejects malformed legacy scope records', () => {
  assert.equal(migrateLegacyKnowledgeScope({ enabled: true, scope: { domains: [] } }), undefined)
})
