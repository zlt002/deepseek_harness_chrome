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
    scope: { domainId: 'order', systemIds: ['otp', 'oms'], repositoryIds: ['repo-b', 'repo-a'] },
  })
})

test('keeps code repositories but requires review instead of silently collapsing several legacy knowledge domains', () => {
  assert.deepEqual(migrateLegacyKnowledgeScope({
    hasCommon: true,
    repoKeys: ['repo-a'],
    domains: {
      first: { self: true, systems: ['one'] },
      second: { self: false, systems: ['two'] },
    },
  }), {
    enabled: true,
    scope: { domainId: '', systemIds: [], repositoryIds: ['repo-a'] },
    notice: '旧版会话包含多个知识领域，请重新确认知识范围；已保留代码库选择。',
  })
})

test('rejects malformed legacy scope records', () => {
  assert.equal(migrateLegacyKnowledgeScope({ enabled: true, scope: { domains: [] } }), undefined)
})
